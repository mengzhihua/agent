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
  listAcpSessions,
  parseListCursor,
  parseSlashCommand,
  toAcpReplayUpdate,
  toAcpUpdate,
  contextWindowSize,
  acpUsageUpdate,
} from "../src/protocol/acp.js";
import { parseAcpMcpServers } from "../src/protocol/mcp.js";
import { parseClientCapabilities } from "../src/protocol/fs.js";
import { clientTerminalEnabled } from "../src/protocol/terminal.js";
import {
  askUserSchema,
  parseElicitationCapabilities,
  parseElicitationResult,
} from "../src/protocol/elicitation.js";
import { encodeMessage, extractMessages } from "../src/protocol/framing.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { SessionStore } from "../src/session/store.js";
import { packageVersion } from "../src/version.js";

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
        sessionCapabilities: { additionalDirectories: {}, resume: {}, close: {}, list: {}, delete: {} },
      },
      agentInfo: { name: "agent", version: packageVersion() },
    });

    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/new" },
      () => undefined,
    )) as { sessionId: string; modes: { currentModeId: string }; configOptions: Array<{ id: string; currentValue: unknown }> };
    expect(created.modes.currentModeId).toBe("execute");
    expect(created.configOptions.map((option) => option.id)).toEqual(["mode", "model", "approval"]);
    expect(created.configOptions.find((option) => option.id === "mode")?.currentValue).toBe("execute");

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

describe("ACP elicitation", () => {
  it("parses initialize clientCapabilities.elicitation", () => {
    expect(parseElicitationCapabilities(undefined)).toEqual({ form: false, url: false });
    expect(parseElicitationCapabilities({ clientCapabilities: { elicitation: {} } })).toEqual({
      form: false,
      url: false,
    });
    expect(
      parseElicitationCapabilities({ clientCapabilities: { elicitation: { form: {}, url: null } } }),
    ).toEqual({ form: true, url: false });
    expect(
      parseElicitationCapabilities({ clientCapabilities: { elicitation: { form: {}, url: {} } } }),
    ).toEqual({ form: true, url: true });
  });

  it("builds a form schema for free text or choices", () => {
    expect(askUserSchema()).toMatchObject({
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "string", minLength: 1 } },
    });
    expect(askUserSchema(["red", "blue"])).toMatchObject({
      properties: { answer: { enum: ["red", "blue"] } },
    });
  });

  it("parses accept, decline, and cancel", () => {
    expect(parseElicitationResult({ action: "accept", content: { answer: "yes" } })).toEqual({
      action: "accept",
      content: { answer: "yes" },
    });
    expect(parseElicitationResult({ action: "decline" }).action).toBe("decline");
    expect(parseElicitationResult({ action: "cancel" }).action).toBe("cancel");
    expect(parseElicitationResult(undefined).action).toBe("cancel");
  });

  it("asks through elicitation/create when the client advertises form", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "ask_user", arguments: { question: "Ship it?", choices: ["yes", "no"] } }] },
      { text: "got it" },
    ]);
    const host = await hostWith(provider);
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const methods: string[] = [];
    const payloads: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
      },
      () => undefined,
    );
    expect(host.clientElicitation).toEqual({ form: true, url: false });
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/new" },
      () => undefined,
    )) as { sessionId: string };
    const notes: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "ask" },
      },
      (note) => notes.push(note),
      async (method, params) => {
        methods.push(method);
        payloads.push(params);
        expect(method).toBe("elicitation/create");
        expect(params).toMatchObject({
          sessionId: created.sessionId,
          toolCallId: "c1",
          mode: "form",
          message: "Ship it?",
        });
        return { action: "accept", content: { answer: "yes" } };
      },
    );
    expect(methods).toEqual(["elicitation/create"]);
    expect(JSON.stringify(notes)).toContain("User: yes");
    expect(JSON.stringify(payloads)).not.toContain("session/request_permission");
    await host.close();
  });

  it("falls back to request_permission without form support", async () => {
    const host = await hostWith(new ScriptedProvider([{ text: "x" }]));
    const methods: string[] = [];
    bindAcpApprover(host, "s1", async (method, params) => {
      methods.push(method);
      expect(params).toMatchObject({ sessionId: "s1" });
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });
    expect(await host.askUser?.({ question: "Continue?" })).toBe("Continue");
    expect(methods).toEqual(["session/request_permission"]);
    await host.close();
  });

  it("turns decline into a failed ask_user", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "ask_user", arguments: { question: "Ship it?" } }] },
      { text: "stopped" },
    ]);
    const host = await hostWith(provider);
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
        params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
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
    const notes: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "ask" },
      },
      (note) => notes.push(note),
      async () => ({ action: "decline" }),
    );
    expect(JSON.stringify(notes)).toContain("User declined the question");
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
    const notes: unknown[] = [];
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
      (note) => notes.push(note),
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
    expect(JSON.stringify(notes)).toContain('"type":"diff"');
    expect(JSON.stringify(notes)).toContain("hello world");
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
    const abs = path.join(host.config.workspace, "note.txt");
    expect(JSON.stringify(notes)).toContain(JSON.stringify(abs));
    await host.close();
  });

  it("creates a file with a diff whose oldText is null", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            id: "c1",
            name: "apply_patch",
            arguments: { path: "new.txt", new_string: "fresh\n" },
          },
        ],
      },
      { text: "created" },
    ]);
    const host = await hostWith(provider);
    const abs = path.join(host.config.workspace, "new.txt");
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "session/new" },
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
        params: { sessionId: created.sessionId, prompt: "create file" },
      },
      (note) => notes.push(note),
    );
    const dumped = JSON.stringify(notes);
    expect(dumped).toContain('"name":"apply_patch"');
    expect(dumped).toContain('"type":"diff"');
    expect(dumped).toContain('"oldText":null');
    expect(dumped).toContain("fresh\\n");
    expect(dumped).toContain(JSON.stringify(abs));
    expect(fs.readFileSync(abs, "utf8")).toBe("fresh\n");
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
    ).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      name: "read",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "a.ts" },
      locations: [{ path: "a.ts" }],
    });
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
    expect(
      toAcpReplayUpdate({
        type: "tool_result",
        id: "t2",
        timestamp: "t",
        callId: "c1",
        name: "read",
        content: "ok",
      }),
    ).not.toHaveProperty("locations");
  });

  it("maps live tool events to name, locations, and diffs", () => {
    expect(
      toAcpUpdate({
        type: "tool-start",
        callId: "c1",
        name: "read",
        arguments: { path: "a.ts", offset: 12 },
        locations: [{ path: "/ws/a.ts", line: 12 }],
      }),
    ).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "read",
      name: "read",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "a.ts", offset: 12 },
      locations: [{ path: "/ws/a.ts", line: 12 }],
    });
    expect(
      toAcpUpdate({
        type: "tool-end",
        callId: "c1",
        name: "apply_patch",
        content: "updated a.ts",
        locations: [{ path: "/ws/a.ts" }],
        diff: { path: "/ws/a.ts", oldText: "a", newText: "b" },
      }),
    ).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      rawOutput: "updated a.ts",
      locations: [{ path: "/ws/a.ts" }],
      content: [
        { type: "content", content: { type: "text", text: "updated a.ts" } },
        { type: "diff", path: "/ws/a.ts", oldText: "a", newText: "b" },
      ],
    });
    expect(
      toAcpUpdate({
        type: "tool-start",
        callId: "c2",
        name: "shell",
        arguments: { command: "echo hi" },
      }),
    ).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "c2",
      title: "shell",
      name: "shell",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "echo hi" },
    });
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
    expect(JSON.stringify(notes)).toContain("available_commands_update");
    expect(JSON.stringify(notes)).not.toContain("user_message_chunk");
    expect(JSON.stringify(notes)).not.toContain("first");

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

describe("ACP session list / delete", () => {
  it("parses list cursors", () => {
    expect(parseListCursor(undefined)).toBe(0);
    expect(parseListCursor("3")).toBe(3);
    expect(() => parseListCursor("nope")).toThrow("invalid cursor");
  });

  it("lists sessions with title and cwd filter", async () => {
    const host = await hostWith(new ScriptedProvider([{ text: "hello from acp" }]));
    const firstWorkspace = host.config.workspace;
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "agent-acp-other-"));
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "session/new" },
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
        params: { sessionId: created.sessionId, prompt: "first question" },
      },
      (note) => notes.push(note),
    );
    expect(JSON.stringify(notes)).toContain("session_info_update");
    expect(JSON.stringify(notes)).toContain("first question");

    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "agent-acp-list-extra-"));
    await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: other, additionalDirectories: [extra] } },
      () => undefined,
    );

    const listed = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 4, method: "session/list" },
      () => undefined,
    )) as { sessions: Array<Record<string, unknown>>; nextCursor?: string };
    expect(listed.nextCursor).toBeUndefined();
    expect(listed.sessions).toHaveLength(2);
    const mine = listed.sessions.find((row) => row.sessionId === created.sessionId);
    expect(mine).toMatchObject({
      sessionId: created.sessionId,
      cwd: firstWorkspace,
      title: "first question",
    });
    expect(typeof mine?.updatedAt).toBe("string");

    const filtered = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 5, method: "session/list", params: { cwd: other } },
      () => undefined,
    )) as { sessions: Array<Record<string, unknown>> };
    expect(filtered.sessions).toHaveLength(1);
    expect(filtered.sessions[0]?.cwd).toBe(path.resolve(other));
    expect(filtered.sessions[0]?.additionalDirectories).toEqual([path.resolve(extra)]);

    const paged = listAcpSessions(host, {}, 1);
    expect(paged.sessions).toHaveLength(1);
    expect(paged.nextCursor).toBe("1");
    const rest = listAcpSessions(host, { cursor: paged.nextCursor }, 1);
    expect(rest.sessions).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
    await host.close();
  });

  it("deletes sessions from history, including missing ids", async () => {
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

    const deleted = await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/delete", params: { sessionId: created.sessionId } },
      () => undefined,
    );
    expect(deleted).toEqual({});
    expect(sessions.has(created.sessionId)).toBe(false);
    expect(host.store.exists(created.sessionId)).toBe(false);

    const listed = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 3, method: "session/list" },
      () => undefined,
    )) as { sessions: unknown[] };
    expect(listed.sessions).toEqual([]);

    await expect(
      dispatch(
        host,
        sessions,
        controllers,
        { jsonrpc: "2.0", id: 4, method: "session/delete", params: { sessionId: created.sessionId } },
        () => undefined,
      ),
    ).resolves.toEqual({});

    await expect(
      dispatch(
        host,
        sessions,
        controllers,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "session/prompt",
          params: { sessionId: created.sessionId, prompt: "hi" },
        },
        () => undefined,
      ),
    ).rejects.toThrow("unknown session");
    await host.close();
  });
});

describe("ACP slash commands", () => {
  it("parses known commands and leaves unknown text alone", () => {
    expect(parseSlashCommand("/plan inspect auth")).toEqual({ name: "plan", rest: "inspect auth" });
    expect(parseSlashCommand("/skills")).toEqual({ name: "skills", rest: "" });
    expect(parseSlashCommand("/unknown foo")).toEqual({ rest: "/unknown foo" });
    expect(parseSlashCommand("not a command")).toEqual({ rest: "not a command" });
  });

  it("advertises commands on session/new and handles /plan /skills", async () => {
    const provider = new ScriptedProvider([{ text: "from model" }]);
    const host = await hostWith(provider);
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const createdNotes: unknown[] = [];
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "session/new" },
      (note) => createdNotes.push(note),
    )) as { sessionId: string };
    expect(JSON.stringify(createdNotes)).toContain("available_commands_update");
    expect(JSON.stringify(createdNotes)).toContain('"name":"plan"');

    const planNotes: unknown[] = [];
    const planned = await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "/plan" },
      },
      (note) => planNotes.push(note),
    );
    expect(planned).toEqual({ stopReason: "end_turn" });
    expect(host.config.runMode).toBe("plan");
    expect(JSON.stringify(planNotes)).toContain("current_mode_update");
    expect(JSON.stringify(planNotes)).not.toContain("from model");

    const skillNotes: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "/skills" },
      },
      (note) => skillNotes.push(note),
    );
    expect(JSON.stringify(skillNotes)).toContain("(no skills)");
    expect(JSON.stringify(skillNotes)).not.toContain("from model");

    const restNotes: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "/execute say hi" },
      },
      (note) => restNotes.push(note),
    );
    expect(host.config.runMode).toBe("default");
    expect(JSON.stringify(restNotes)).toContain("from model");
    await host.close();
  });

  it("lets /yes skip client permission prompts", async () => {
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

    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "/yes" },
      },
      () => undefined,
    );
    expect(host.config.approvalMode).toBe("auto");

    const methods: string[] = [];
    const result = await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "run it" },
      },
      () => undefined,
      async (method) => {
        methods.push(method);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      },
    );
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(methods).toEqual([]);
    await host.close();
  });
});

describe("ACP session config options", () => {
  it("sets mode, model, and approval through session/set_config_option", async () => {
    const host = await hostWith(new ScriptedProvider([{ text: "ok" }]));
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "session/new" },
      () => undefined,
    )) as { sessionId: string; configOptions: Array<{ id: string; currentValue: unknown }> };
    expect(created.configOptions.find((option) => option.id === "model")?.currentValue).toBe(host.config.model);

    const notes: unknown[] = [];
    const updated = (await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/set_config_option",
        params: { sessionId: created.sessionId, configId: "mode", value: "plan" },
      },
      (note) => notes.push(note),
    )) as { configOptions: Array<{ id: string; currentValue: unknown }> };
    expect(host.config.runMode).toBe("plan");
    expect(updated.configOptions.find((option) => option.id === "mode")?.currentValue).toBe("plan");
    expect(JSON.stringify(notes)).toContain("current_mode_update");
    expect(JSON.stringify(notes)).toContain("config_option_update");

    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/set_config_option",
        params: { sessionId: created.sessionId, configId: "model", value: "grok-4" },
      },
      () => undefined,
    );
    expect(host.config.model).toBe("grok-4");

    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "session/set_config_option",
        params: { sessionId: created.sessionId, configId: "approval", value: "auto" },
      },
      () => undefined,
    );
    expect(host.config.approvalMode).toBe("auto");

    await expect(
      dispatch(
        host,
        sessions,
        controllers,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "session/set_config_option",
          params: { sessionId: created.sessionId, configId: "model", value: "not-a-model" },
        },
        () => undefined,
      ),
    ).rejects.toThrow("invalid model value");
    await expect(
      dispatch(
        host,
        sessions,
        controllers,
        {
          jsonrpc: "2.0",
          id: 6,
          method: "session/set_config_option",
          params: { sessionId: created.sessionId, configId: "nope", value: "x" },
        },
        () => undefined,
      ),
    ).rejects.toThrow("unknown config option");
    await host.close();
  });

  it("keeps modes in sync when set_mode changes config options", async () => {
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
    const notes: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/set_mode", params: { sessionId: created.sessionId, modeId: "plan" } },
      (note) => notes.push(note),
    );
    expect(host.config.runMode).toBe("plan");
    expect(JSON.stringify(notes)).toContain("config_option_update");
    expect(JSON.stringify(notes)).toContain('"currentValue":"plan"');
    await host.close();
  });
});

describe("ACP usage updates", () => {
  it("picks a context window from the model id", () => {
    expect(contextWindowSize("claude-sonnet-4-5", 100_000)).toBe(200_000);
    expect(contextWindowSize("grok-4", 100_000)).toBe(256_000);
    expect(contextWindowSize("gpt-4.1", 100_000)).toBe(1_047_576);
    expect(contextWindowSize("mystery", 100_000)).toBe(128_000);
  });

  it("notifies usage_update on session/new and after a prompt", async () => {
    const host = await hostWith(new ScriptedProvider([{ text: "hello from acp" }]));
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const createdNotes: unknown[] = [];
    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 1, method: "session/new" },
      (note) => createdNotes.push(note),
    )) as { sessionId: string };
    const createdUsage = createdNotes.find(
      (note) => (note as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "usage_update",
    ) as { update: { used: number; size: number } };
    expect(createdUsage.update.used).toBe(0);
    expect(createdUsage.update.size).toBe(contextWindowSize(host.config.model, host.config.compactTokens));

    const promptNotes: unknown[] = [];
    await dispatch(
      host,
      sessions,
      controllers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: created.sessionId, prompt: "hi there" },
      },
      (note) => promptNotes.push(note),
    );
    const promptUsage = promptNotes.find(
      (note) => (note as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "usage_update",
    ) as { update: { used: number; size: number } };
    expect(promptUsage.update.used).toBeGreaterThan(0);
    expect(promptUsage.update.size).toBe(createdUsage.update.size);
    expect(acpUsageUpdate(host, created.sessionId).used).toBe(promptUsage.update.used);
    await host.close();
  });

  it("sends usage_update after resume without replaying history", async () => {
    const host = await hostWith(new ScriptedProvider([{ text: "first" }, { text: "second" }]));
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
    await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 3, method: "session/resume", params: { sessionId: created.sessionId } },
      (note) => notes.push(note),
    );
    expect(JSON.stringify(notes)).toContain("usage_update");
    expect(JSON.stringify(notes)).not.toContain("user_message_chunk");
    const usage = notes.find(
      (note) => (note as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "usage_update",
    ) as { update: { used: number } };
    expect(usage.update.used).toBeGreaterThan(0);
    await host.close();
  });
});
