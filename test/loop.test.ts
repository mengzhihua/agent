import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runTurn } from "../src/loop/agent-loop.js";
import { autoApprover, denyApprover } from "../src/permissions/policy.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const fixtureSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/broken-add");

async function collect(
  store: SessionStore,
  sessionId: string,
  prompt: string,
  provider: ScriptedProvider,
  workspace: string,
  extra: Partial<ReturnType<typeof loadConfig>> = {},
  approver = autoApprover(),
  signal = new AbortController().signal,
) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-sess-"));
  const config = loadConfig({
    workspace,
    provider: "scripted",
    approvalMode: "auto",
    sessionDir,
    compactTokens: 100_000,
    ...extra,
  });
  if (!store.exists(sessionId)) {
    store.create({
      type: "session_meta",
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: workspace,
      model: "scripted",
      provider: "scripted",
    });
  }
  const events = [];
  for await (const event of runTurn({
    store,
    sessionId,
    userText: prompt,
    provider,
    tools: ToolRegistry.builtin(config),
    config,
    approver,
    signal,
  })) {
    events.push(event);
  }
  return { events, config };
}

describe("agent loop", () => {
  it("fixes the broken add fixture, runs tests, and can resume", async () => {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-fix-"));
    await fsp.cp(fixtureSrc, workspace, { recursive: true });
    const store = new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), "agent-fix-sess-")));
    const provider = new ScriptedProvider([
      {
        text: "I will inspect the project.",
        toolCalls: [{ id: "c1", name: "glob", arguments: { pattern: "*.mjs" } }],
      },
      {
        toolCalls: [{ id: "c2", name: "read", arguments: { path: "add.mjs" } }],
      },
      {
        toolCalls: [{ id: "c3", name: "apply_patch", arguments: { path: "add.mjs", old_string: "return a - b;", new_string: "return a + b;" } }],
      },
      {
        toolCalls: [{ id: "c4", name: "shell", arguments: { command: "node add.test.mjs" } }],
      },
      { text: "Fixed add() and verified with node add.test.mjs." },
    ]);

    const { events } = await collect(store, "s1", "Fix the failing test.", provider, workspace);
    expect(events.some((event) => event.type === "turn-end")).toBe(true);
    expect(await fsp.readFile(path.join(workspace, "add.mjs"), "utf8")).toContain("return a + b;");
    const patch = events.find((event) => event.type === "tool-end" && event.name === "apply_patch");
    expect(patch?.type === "tool-end" && patch.diff?.oldText).toContain("return a - b;");
    expect(patch?.type === "tool-end" && patch.diff?.newText).toContain("return a + b;");
    expect(patch?.type === "tool-end" && patch.locations?.[0]?.path).toBe(path.join(workspace, "add.mjs"));
    const testOut = events.find((event) => event.type === "tool-end" && event.name === "shell");
    expect(testOut?.type === "tool-end" && testOut.content).toMatch(/ok/);
    expect(provider.remaining()).toBe(0);

    const resume = new ScriptedProvider([{ text: "Still fixed." }]);
    const second = await collect(store, "s1", "What did you change?", resume, workspace);
    const end = second.events.find((event) => event.type === "turn-end");
    expect(end?.type === "turn-end" && end.text).toBe("Still fixed.");
    const transcript = store.read("s1");
    expect(transcript.filter((event) => event.type === "user")).toHaveLength(2);
  });

  it("returns a deny error to the model and continues", async () => {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-deny-"));
    const store = new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), "agent-deny-sess-")));
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo pwned" } }] },
      { text: "I did not run the command." },
    ]);
    const { events } = await collect(
      store,
      "deny1",
      "run echo",
      provider,
      workspace,
      { approvalMode: "ask", sandbox: "none" },
      denyApprover(),
    );
    const denied = events.find((event) => event.type === "permission");
    expect(denied?.type === "permission" && denied.decision).toBe("deny");
    const toolEnd = events.find((event) => event.type === "tool-end");
    expect(toolEnd?.type === "tool-end" && toolEnd.isError).toBe(true);
    expect(events.some((event) => event.type === "turn-end")).toBe(true);
  });

  it("compacts long history and keeps the latest user turn", async () => {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-c-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-c-sess-"));
    const store = new SessionStore(dir);
    store.create({
      type: "session_meta",
      id: "c1",
      timestamp: new Date().toISOString(),
      cwd: workspace,
      model: "scripted",
      provider: "scripted",
    });
    for (let i = 0; i < 8; i++) {
      store.append("c1", { type: "user", id: `u${i}`, timestamp: new Date().toISOString(), text: "x".repeat(200) });
      store.append("c1", { type: "assistant", id: `a${i}`, timestamp: new Date().toISOString(), text: "y".repeat(200) });
    }
    const provider = new ScriptedProvider([
      { text: "Prior work: lots of x and y." },
      { text: "Ready to continue." },
    ]);
    const { events } = await collect(
      store,
      "c1",
      "continue",
      provider,
      workspace,
      { compactTokens: 100 },
    );
    expect(events.some((event) => event.type === "compact-end")).toBe(true);
    const end = events.find((event) => event.type === "turn-end");
    expect(end?.type === "turn-end" && end.text).toBe("Ready to continue.");
    const users = store.read("c1").filter((event) => event.type === "user");
    expect(users.at(-1)?.type === "user" && users.at(-1).text).toBe("continue");
  });

  it("stops when the turn is aborted", async () => {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-ab-"));
    const store = new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), "agent-ab-sess-")));
    const provider = new ScriptedProvider([{ text: "should not run" }]);
    const controller = new AbortController();
    controller.abort();
    const { events } = await collect(
      store,
      "ab1",
      "hello",
      provider,
      workspace,
      {},
      autoApprover(),
      controller.signal,
    );
    expect(events.some((event) => event.type === "aborted")).toBe(true);
  });

  it("runs consecutive read tools from one model turn", async () => {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-par-"));
    await fsp.writeFile(path.join(workspace, "a.txt"), "alpha\n");
    await fsp.writeFile(path.join(workspace, "b.txt"), "beta\n");
    const store = new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), "agent-par-sess-")));
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "read", arguments: { path: "a.txt" } },
          { id: "c2", name: "read", arguments: { path: "b.txt" } },
        ],
      },
      { text: "both files read" },
    ]);
    const { events } = await collect(store, "p1", "read both", provider, workspace);
    const reads = events.filter((event) => event.type === "tool-end" && event.name === "read");
    expect(reads).toHaveLength(2);
    expect(reads.some((event) => event.type === "tool-end" && event.content.includes("alpha"))).toBe(true);
    expect(reads.some((event) => event.type === "tool-end" && event.content.includes("beta"))).toBe(true);
    expect(events.some((event) => event.type === "turn-end")).toBe(true);
  });
});
