import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runTurn } from "../src/loop/agent-loop.js";
import { autoApprover, decidePermission } from "../src/permissions/policy.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function run(workspace: string, provider: ScriptedProvider, extra = {}) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-plan-sess-"));
  const store = new SessionStore(sessionDir);
  const config = loadConfig({
    workspace,
    provider: "scripted",
    approvalMode: "auto",
    sessionDir,
    runMode: "plan",
    ...extra,
  });
  store.create({
    type: "session_meta",
    id: "p1",
    timestamp: new Date().toISOString(),
    cwd: workspace,
    model: "scripted",
    provider: "scripted",
  });
  const events = [];
  for await (const event of runTurn({
    store,
    sessionId: "p1",
    userText: "plan the fix",
    provider,
    tools: ToolRegistry.builtin(config),
    config,
    approver: autoApprover(),
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return { events, store };
}

describe("plan mode", () => {
  it("denies mutating tools even with auto approval", async () => {
    const result = await decidePermission("shell", { command: "echo x" }, "auto", autoApprover(), "plan");
    expect(result.decision).toBe("deny");
    expect(result.summary).toMatch(/plan mode blocked/);
  });

  it("blocks shell and records a plan", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-plan-"));
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo pwned" } }] },
      {
        toolCalls: [
          {
            id: "c2",
            name: "update_plan",
            arguments: {
              explanation: "inspect then patch",
              steps: [
                { title: "Read add.mjs", status: "completed" },
                { title: "Fix the operator", status: "pending" },
              ],
            },
          },
        ],
      },
      { text: "Plan is ready." },
    ]);
    const { events, store } = await run(workspace, provider);
    const denied = events.find((event) => event.type === "permission");
    expect(denied?.type === "permission" && denied.decision).toBe("deny");
    const plan = events.find((event) => event.type === "plan");
    expect(plan?.type === "plan" && plan.steps[1]?.title).toMatch(/Fix/);
    const end = events.find((event) => event.type === "turn-end");
    expect(end?.type === "turn-end" && end.text).toBe("Plan is ready.");
    expect(store.read("p1").some((event) => event.type === "plan")).toBe(true);
  });
});
