import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentHost } from "../src/host.js";
import { autoApprover } from "../src/permissions/policy.js";
import {
  ACP_PROTOCOL_VERSION,
  bindAcpApprover,
  dispatch,
  parsePermissionOutcome,
} from "../src/protocol/acp.js";
import { parseClientCapabilities } from "../src/protocol/fs.js";
import { encodeMessage, extractMessages } from "../src/protocol/framing.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { SessionStore } from "../src/session/store.js";

async function hostWith(
  provider: ScriptedProvider,
  extra: Parameters<typeof loadConfig>[0] = {},
) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-acp-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-acp-sess-"));
  const config = loadConfig({
    workspace,
    provider: "scripted",
    approvalMode: "auto",
    sessionDir,
    sandbox: "none",
    browser: "html",
    ...extra,
  });
  const host = await AgentHost.create(config, provider, new SessionStore(sessionDir), autoApprover(), {
    connectMcp: false,
  });
  return host;
}

describe("ACP framing", () => {
  it("round-trips NDJSON and Content-Length", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize" };
    const nd = extractMessages(encodeMessage(msg, "ndjson"), undefined);
    expect(nd.framing).toBe("ndjson");
    expect(nd.messages[0]).toEqual(msg);
    const lsp = extractMessages(encodeMessage(msg, "lsp"), undefined);
    expect(lsp.framing).toBe("lsp");
    expect(lsp.messages[0]).toEqual(msg);
  });
});

describe("ACP-shaped protocol", () => {
  it("initializes, creates a session, and runs a prompt", async () => {
    const provider = new ScriptedProvider([{ text: "hello from acp" }]);
    const host = await hostWith(provider);
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const notes: unknown[] = [];

    const init = await dispatch(host, sessions, controllers, { jsonrpc: "2.0", id: 1, method: "initialize" }, () => undefined);
    expect(init).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    });

    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/new" },
      () => undefined,
    )) as { sessionId: string; modes: { currentModeId: string } };
    expect(created.modes.currentModeId).toBe("execute");

    const result = await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] },
      },
      (note) => notes.push(note),
    );
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(JSON.stringify(notes)).toContain("hello from acp");
    await host.close();
  });

  it("switches to plan mode and maps plan updates", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            id: "c1",
            name: "update_plan",
            arguments: { steps: [{ title: "Inspect", status: "pending" }] },
          },
        ],
      },
      { text: "Plan ready." },
    ]);
    const host = await hostWith(provider);
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const notes: unknown[] = [];
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "session/new" },
      () => undefined,
    )) as { sessionId: string };

    await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/set_mode", params: { sessionId: created.sessionId, modeId: "plan" } },
      (note) => notes.push(note),
    );
    expect(host.config.runMode).toBe("plan");

    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "plan it" },
      },
      (note) => notes.push(note),
    );
    expect(JSON.stringify(notes)).toContain("current_mode_update");
    expect(JSON.stringify(notes)).toContain("Inspect");
    await host.close();
  });

  it("asks the client before running a mutating tool", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo hi" } }] },
      { text: "done" },
    ]);
    const host = await hostWith(provider, { approvalMode: "ask", sandbox: "none" });
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "session/new" },
      () => undefined,
    )) as { sessionId: string };

    const seen: string[] = [];
    const result = await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "run it" },
      },
      () => undefined,
      async (method, params) => {
        seen.push(method);
        expect(method).toBe("session/request_permission");
        expect(JSON.stringify(params)).toContain("echo hi");
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      },
    );
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(seen).toEqual(["session/request_permission"]);
    await host.close();
  });
});

describe("permission outcome", () => {
  it("accepts Zed selected/cancelled shapes", () => {
    expect(parsePermissionOutcome({ outcome: { outcome: "selected", optionId: "allow-once" } })).toBe("allow");
    expect(parsePermissionOutcome({ outcome: { outcome: "cancelled" } })).toBe("deny");
    expect(parsePermissionOutcome({ outcome: { outcome: "selected", optionId: "reject-once" } })).toBe("deny");
  });
});

describe("bindAcpApprover", () => {
  it("maps allow-once to allow", async () => {
    const host = await hostWith(new ScriptedProvider([{ text: "x" }]));
    bindAcpApprover(host, "s1", async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }));
    expect(await host.approver({ tool: "shell", risk: "exec", arguments: {}, summary: "shell: ls" })).toBe("allow");
    await host.close();
  });
});

describe("ACP client filesystem", () => {
  it("parses initialize clientCapabilities.fs", () => {
    expect(parseClientCapabilities(undefined)).toEqual({ readTextFile: false, writeTextFile: false });
    expect(
      parseClientCapabilities({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }),
    ).toEqual({ readTextFile: true, writeTextFile: true });
  });

  it("uses session/new cwd as the workspace", async () => {
    const host = await hostWith(new ScriptedProvider([{ text: "ok" }]));
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-acp-cwd-"));
    await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } },
      () => undefined,
    );
    expect(host.config.workspace).toBe(path.resolve(cwd));
    await host.close();
  });

  it("reads unsaved buffers through fs/read_text_file", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "read", arguments: { path: "note.txt" } }] },
      { text: "saw unsaved" },
    ]);
    const host = await hostWith(provider);
    fs.writeFileSync(path.join(host.config.workspace, "note.txt"), "on disk\n");
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } },
      },
      () => undefined,
    );
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/new" },
      () => undefined,
    )) as { sessionId: string };

    const methods: string[] = [];
    const notes: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "read note" },
      },
      (note) => notes.push(note),
      async (method, params) => {
        methods.push(method);
        expect(method).toBe("fs/read_text_file");
        expect(JSON.stringify(params)).toContain("note.txt");
        return { content: "unsaved buffer\n" };
      },
    );
    expect(methods).toEqual(["fs/read_text_file"]);
    expect(JSON.stringify(notes)).toContain("unsaved buffer");
    expect(JSON.stringify(notes)).not.toContain("on disk");
    await host.close();
  });

  it("writes apply_patch through fs/write_text_file", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            id: "c1",
            name: "apply_patch",
            arguments: { path: "note.txt", old_string: "hello", new_string: "hello world" },
          },
        ],
      },
      { text: "patched" },
    ]);
    const host = await hostWith(provider);
    const diskPath = path.join(host.config.workspace, "note.txt");
    fs.writeFileSync(diskPath, "hello");
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } },
      },
      () => undefined,
    );
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/new" },
      () => undefined,
    )) as { sessionId: string };

    const files = new Map<string, string>([[diskPath, "hello"]]);
    const methods: string[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "edit note" },
      },
      () => undefined,
      async (method, params) => {
        methods.push(method);
        const row = params as { path?: string; content?: string };
        if (method === "fs/read_text_file") return { content: files.get(String(row.path)) ?? "" };
        if (method === "fs/write_text_file") {
          files.set(String(row.path), String(row.content ?? ""));
          return null;
        }
        throw new Error(`unexpected ${method}`);
      },
    );
    expect(methods).toEqual(["fs/read_text_file", "fs/write_text_file"]);
    expect(files.get(diskPath)).toBe("hello world");
    expect(fs.readFileSync(diskPath, "utf8")).toBe("hello");
    await host.close();
  });

  it("does not call fs methods when the client omitted the capability", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "read", arguments: { path: "note.txt" } }] },
      { text: "from disk" },
    ]);
    const host = await hostWith(provider);
    fs.writeFileSync(path.join(host.config.workspace, "note.txt"), "disk only\n");
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
      () => undefined,
    );
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/new" },
      () => undefined,
    )) as { sessionId: string };

    const methods: string[] = [];
    const notes: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "read note" },
      },
      (note) => notes.push(note),
      async (method) => {
        methods.push(method);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      },
    );
    expect(methods).toEqual([]);
    expect(JSON.stringify(notes)).toContain("disk only");
    await host.close();
  });
});
