import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentHost } from "../src/host.js";
import { autoApprover } from "../src/permissions/policy.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { SessionStore } from "../src/session/store.js";

describe("subagent", () => {
  it("returns only a summary to the parent session", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sub-"));
    fs.writeFileSync(path.join(workspace, "note.txt"), "secret-detail\n");
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sub-sess-"));
    const store = new SessionStore(sessionDir);
    const config = loadConfig({
      workspace,
      provider: "scripted",
      approvalMode: "auto",
      sessionDir,
    });
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            id: "c1",
            name: "task",
            arguments: { prompt: "Read note.txt and summarize.", subagent_type: "explore", label: "explore" },
          },
        ],
      },
      { toolCalls: [{ id: "c2", name: "read", arguments: { path: "note.txt" } }] },
      { text: "note.txt contains secret-detail" },
      { text: "The subagent found a note." },
    ]);
    const host = await AgentHost.create(config, provider, store, autoApprover(), { connectMcp: false });
    const sessionId = host.createSession();
    const events = [];
    for await (const event of host.prompt(sessionId, "What's in the note?", new AbortController().signal)) {
      events.push(event);
    }
    await host.close();
    const parent = store.read(sessionId);
    expect(parent.some((event) => event.type === "tool_call" && event.name === "read")).toBe(false);
    const taskResult = parent.find((event) => event.type === "tool_result" && event.name === "task");
    expect(taskResult?.type === "tool_result" && taskResult.content).toContain("secret-detail");
    expect(events.some((event) => event.type === "subagent-start")).toBe(true);
    expect(events.some((event) => event.type === "turn-end")).toBe(true);
    const childSessions = store.list().filter((row) => row.id !== sessionId);
    expect(childSessions.length).toBe(1);
    const child = store.read(childSessions[0]!.id);
    expect(child.some((event) => event.type === "tool_call" && event.name === "read")).toBe(true);
  });
});
