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
