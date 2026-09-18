import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentHost } from "../src/host.js";
import { autoApprover } from "../src/permissions/policy.js";
import {
  ACP_PROTOCOL_VERSION,
  bindAcpApprover,
  dispatch,
  parseAdditionalDirectories,
  parsePermissionOutcome,
  toAcpReplayUpdate,
} from "../src/protocol/acp.js";
import { parseAcpMcpServers } from "../src/protocol/mcp.js";
import { parseClientCapabilities } from "../src/protocol/fs.js";
import { clientTerminalEnabled } from "../src/protocol/terminal.js";
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
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { additionalDirectories: {}, resume: {}, close: {} },
      },
      agentInfo: { name: "agent", version: "0.11.0" },
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

describe("ACP client terminal", () => {
  it("parses initialize clientCapabilities.terminal", () => {
    expect(clientTerminalEnabled(undefined)).toBe(false);
    expect(clientTerminalEnabled({ clientCapabilities: { terminal: true } })).toBe(true);
  });

  it("runs shell through terminal/create and embeds the terminal id", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo hi" } }] },
      { text: "ran" },
    ]);
    const host = await hostWith(provider, { sandbox: "none" });
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
        params: { protocolVersion: 1, clientCapabilities: { terminal: true } },
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
        params: { sessionId: created.sessionId, prompt: "run echo" },
      },
      (note) => notes.push(note),
      async (method, params) => {
        methods.push(method);
        if (method === "terminal/create") {
          expect(JSON.stringify(params)).toContain("echo hi");
          return { terminalId: "term_1" };
        }
        if (method === "terminal/wait_for_exit") return { exitCode: 0, signal: null };
        if (method === "terminal/output") return { output: "hi\n", truncated: false, exitStatus: { exitCode: 0 } };
        if (method === "terminal/release") return {};
        throw new Error(`unexpected ${method}`);
      },
    );
    expect(methods).toEqual(["terminal/create", "terminal/wait_for_exit", "terminal/output", "terminal/release"]);
    expect(JSON.stringify(notes)).toContain("term_1");
    expect(JSON.stringify(notes)).toContain('"type":"terminal"');
    expect(JSON.stringify(notes)).toContain("hi");
    await host.close();
  });

  it("does not call terminal methods without the capability", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo local" } }] },
      { text: "ran" },
    ]);
    const host = await hostWith(provider, { sandbox: "none" });
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
        params: { sessionId: created.sessionId, prompt: "run echo" },
      },
      (note) => notes.push(note),
      async (method) => {
        methods.push(method);
        return {};
      },
    );
    expect(methods.filter((name) => name.startsWith("terminal/"))).toEqual([]);
    expect(JSON.stringify(notes)).toContain("local");
    await host.close();
  });
});

const echoServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/mcp/echo-server.mjs");

describe("ACP session MCP", () => {
  it("parses stdio and HTTP server lists and skips SSE", () => {
    const parsed = parseAcpMcpServers([
      {
        name: "echo",
        command: "/usr/bin/node",
        args: ["echo.mjs"],
        env: [{ name: "TOKEN", value: "abc" }],
      },
      {
        type: "http",
        name: "api",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer x" }],
      },
      { type: "sse", name: "events", url: "https://example.com/sse" },
      { name: "broken" },
    ]);
    expect(parsed.echo).toEqual({
      command: "/usr/bin/node",
      args: ["echo.mjs"],
      env: { TOKEN: "abc" },
    });
    expect(parsed.api).toEqual({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(parsed.events).toBeUndefined();
    expect(parsed.broken).toBeUndefined();
  });

  it("connects session/new mcpServers and exposes the tool", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "mcp__echo__echo", arguments: { text: "hi" } }] },
      { text: "echoed" },
    ]);
    const host = await hostWith(provider);
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: {
          mcpServers: [{ name: "echo", command: process.execPath, args: [echoServer] }],
        },
      },
      () => undefined,
    )) as { sessionId: string };

    const notes: unknown[] = [];
    const result = await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "echo hi" },
      },
      (note) => notes.push(note),
    );
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(JSON.stringify(notes)).toContain("echo:hi");
    await host.close();
  });
});

describe("ACP additionalDirectories", () => {
  it("keeps only unique absolute paths", () => {
    expect(parseAdditionalDirectories(["/tmp/a", "/tmp/a/", "relative", 1, "/tmp/b"])).toEqual([
      path.resolve("/tmp/a"),
      path.resolve("/tmp/b"),
    ]);
  });

  it("lets read touch a file in an extra root", async () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "agent-acp-extra-"));
    fs.writeFileSync(path.join(extra, "lib.ts"), "export const n = 1;\n");
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "read", arguments: { path: path.join(extra, "lib.ts") } }] },
      { text: "saw lib" },
    ]);
    const host = await hostWith(provider);
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { additionalDirectories: [extra] },
      },
      () => undefined,
    )) as { sessionId: string };

    const notes: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "read lib" },
      },
      (note) => notes.push(note),
    );
    expect(JSON.stringify(notes)).toContain("export const n = 1");
    await host.close();
  });
});

describe("ACP session load / resume / close", () => {
  it("maps transcript events for replay", () => {
    expect(
      toAcpReplayUpdate({ type: "session_meta", id: "s1", timestamp: "t", cwd: "/", model: "m", provider: "scripted" }),
    ).toBeUndefined();
    expect(toAcpReplayUpdate({ type: "compact", id: "c1", timestamp: "t", summary: "old" })).toBeUndefined();
    expect(toAcpReplayUpdate({ type: "user", id: "u1", timestamp: "t", text: "hi" })).toEqual({
      sessionUpdate: "user_message_chunk",
      messageId: "u1",
      content: { type: "text", text: "hi" },
    });
    expect(toAcpReplayUpdate({ type: "assistant", id: "a1", timestamp: "t", text: "hello" })).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      messageId: "a1",
    });
    expect(
      toAcpReplayUpdate({
        type: "tool_call",
        id: "t1",
        timestamp: "t",
        callId: "c1",
        name: "read",
        arguments: { path: "a.ts" },
      }),
    ).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "read", status: "in_progress" });
    expect(
      toAcpReplayUpdate({
        type: "tool_result",
        id: "t2",
        timestamp: "t",
        callId: "c1",
        name: "read",
        content: "ok",
      }),
    ).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
  });

  it("replays history on session/load and returns null", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "read", arguments: { path: "note.txt" } }] },
      { text: "saw note" },
      { text: "still here" },
    ]);
    const host = await hostWith(provider);
    fs.writeFileSync(path.join(host.config.workspace, "note.txt"), "hello note\n");
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
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
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "read note" },
      },
      () => undefined,
    );

    const notes: unknown[] = [];
    const loaded = await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/load",
        params: { sessionId: created.sessionId },
      },
      (note) => notes.push(note),
    );
    expect(loaded).toBeNull();
    const dumped = JSON.stringify(notes);
    expect(dumped).toContain("user_message_chunk");
    expect(dumped).toContain("read note");
    expect(dumped).toContain("agent_message_chunk");
    expect(dumped).toContain("saw note");
    expect(dumped).toContain("tool_call");
    expect(dumped).toContain("hello note");
    expect(dumped).not.toContain("still here");
    await host.close();
  });

  it("restores on session/resume without replaying", async () => {
    const provider = new ScriptedProvider([{ text: "first" }, { text: "second" }]);
    const host = await hostWith(provider);
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
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
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "hi" },
      },
      () => undefined,
    );

    const notes: unknown[] = [];
    const resumed = (await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/resume",
        params: { sessionId: created.sessionId },
      },
      (note) => notes.push(note),
    )) as { sessionId: string; modes: { currentModeId: string } };
    expect(resumed.sessionId).toBe(created.sessionId);
    expect(resumed.modes.currentModeId).toBe("execute");
    expect(notes).toEqual([]);

    const after: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "again" },
      },
      (note) => after.push(note),
    );
    expect(JSON.stringify(after)).toContain("second");
    expect(JSON.stringify(after)).not.toContain("first");
    await host.close();
  });

  it("closes an active session and rejects later prompts", async () => {
    const host = await hostWith(new ScriptedProvider([{ text: "ok" }]));
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "session/new" },
      () => undefined,
    )) as { sessionId: string };

    const closed = await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/close", params: { sessionId: created.sessionId } },
      () => undefined,
    );
    expect(closed).toEqual({});
    expect(sessions.has(created.sessionId)).toBe(false);

    await expect(
      dispatch(
        host,
        sessions,
        controllers,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId: created.sessionId, prompt: "hi" },
        },
        () => undefined,
      ),
    ).rejects.toThrow("unknown session");

    await expect(
      dispatch(
        host,
        sessions,
        controllers,
        { jsonrpc: "2.0", id: 4, method: "session/close", params: { sessionId: created.sessionId } },
        () => undefined,
      ),
    ).rejects.toThrow("unknown session");

    const notes: unknown[] = [];
    const loaded = await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 5, method: "session/load", params: { sessionId: created.sessionId } },
      (note) => notes.push(note),
    );
    expect(loaded).toBeNull();
    expect(sessions.has(created.sessionId)).toBe(true);
    expect(JSON.stringify(notes)).not.toContain("user_message_chunk");
    await host.close();
  });
});
