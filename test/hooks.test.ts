import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HookRunner } from "../src/hooks/hooks.js";
import { runTurn } from "../src/loop/agent-loop.js";
import { autoApprover } from "../src/permissions/policy.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("hooks", () => {
  it("lets PreToolUse deny a shell call", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hook-"));
    fs.mkdirSync(path.join(workspace, ".agent"));
    fs.writeFileSync(
      path.join(workspace, ".agent", "hooks.json"),
      JSON.stringify({
        PreToolUse: [
          {
            matcher: "shell",
            command:
              "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify({decision:'deny',reason:'blocked-by-hook'})))\"",
          },
        ],
      }),
    );
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hook-sess-"));
    const store = new SessionStore(sessionDir);
    const config = loadConfig({
      workspace,
      provider: "scripted",
      approvalMode: "auto",
      sessionDir,
    });
    store.create({
      type: "session_meta",
      id: "h1",
      timestamp: new Date().toISOString(),
      cwd: workspace,
      model: "scripted",
      provider: "scripted",
    });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo hi" } }] },
      { text: "hook blocked it" },
    ]);
    const events = [];
    for await (const event of runTurn({
      store,
      sessionId: "h1",
      userText: "run echo",
      provider,
      tools: ToolRegistry.builtin(config),
      config,
      approver: autoApprover(),
      signal: new AbortController().signal,
      hooks: HookRunner.load(workspace),
    })) {
      events.push(event);
    }
    const hook = events.find((event) => event.type === "hook");
    expect(hook?.type === "hook" && hook.message).toMatch(/blocked-by-hook/);
    const tool = events.find((event) => event.type === "tool-end");
    expect(tool?.type === "tool-end" && tool.isError).toBe(true);
  });
});
