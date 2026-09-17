import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentHost } from "../src/host.js";
import { autoApprover } from "../src/permissions/policy.js";
import { dispatch } from "../src/protocol/acp.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { SessionStore } from "../src/session/store.js";

describe("ACP-shaped protocol", () => {
  it("initializes, creates a session, and runs a prompt", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-acp-"));
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-acp-sess-"));
    const config = loadConfig({
      workspace,
      provider: "scripted",
      approvalMode: "auto",
      sessionDir,
    });
    const provider = new ScriptedProvider([{ text: "hello from acp" }]);
    const host = await AgentHost.create(
      config,
      provider,
      new SessionStore(sessionDir),
      autoApprover(),
      { connectMcp: false },
    );
    const sessions = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const notes: unknown[] = [];

    const init = await dispatch(host, sessions, controllers, { jsonrpc: "2.0", id: 1, method: "initialize" }, () => undefined);
    expect(init).toMatchObject({ protocolVersion: "0.1.0" });

    const created = (await dispatch(
      host,
      sessions,
      controllers,
      { jsonrpc: "2.0", id: 2, method: "session/new" },
      () => undefined,
    )) as { sessionId: string };

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
});
