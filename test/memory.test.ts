import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendMemory,
  formatMemoryPrompt,
  formatMemoryShow,
  loadMemory,
  parseMemoryScope,
  replaceMemory,
} from "../src/context/memory.js";
import { loadConfig } from "../src/config.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { defaultDecision, decidePermission, autoApprover } from "../src/permissions/policy.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { initWorkspace } from "../src/init.js";

const prevHome = process.env.AGENT_HOME;

afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENT_HOME;
  else process.env.AGENT_HOME = prevHome;
});

describe("memory files", () => {
  it("appends user and project notes and injects them into the system prompt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mem-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mem-ws-"));
    process.env.AGENT_HOME = home;
    expect(formatMemoryPrompt(workspace)).toBe("");
    expect(appendMemory(workspace, "user", "Prefer TypeScript.")).toMatch(/user memory/);
    expect(appendMemory(workspace, "project", "Tests live in test/.")).toMatch(/project memory/);
    expect(appendMemory(workspace, "project", "Tests live in test/.")).toMatch(/Already/);
    const files = loadMemory(workspace);
    expect(files.user).toContain("Prefer TypeScript.");
    expect(files.project).toContain("Tests live in test/.");
    const shown = formatMemoryShow(files, "json");
    expect(JSON.parse(shown)).toMatchObject({ type: "memory" });
    const prompt = buildSystemPrompt(loadConfig({ workspace, provider: "scripted" }));
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("Prefer TypeScript.");
    expect(prompt).toContain("Tests live in test/.");
    expect(replaceMemory(workspace, "project", "Only vitest.")).toMatch(/Replaced/);
    expect(loadMemory(workspace).project).toBe("Only vitest.");
  });

  it("exposes a memory tool and treats get as read", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mem-tool-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mem-tool-ws-"));
    process.env.AGENT_HOME = home;
    const config = loadConfig({ workspace, provider: "scripted", approvalMode: "auto" });
    const tool = ToolRegistry.builtin(config).get("memory");
    expect(tool).toBeDefined();
    const ctx = { config, signal: new AbortController().signal };
    const appended = await tool!.execute({ action: "append", scope: "project", text: "Use npm test." }, ctx);
    expect(String(appended)).toMatch(/Appended/);
    const got = await tool!.execute({ action: "get", scope: "project" }, ctx);
    expect(String(got)).toContain("Use npm test.");
    expect(defaultDecision("memory", "ask", { action: "get" })).toBe("allow");
    expect(defaultDecision("memory", "ask", { action: "append", text: "x" })).toBe("ask");
    const planned = await decidePermission(
      "memory",
      { action: "append", scope: "project", text: "nope" },
      "auto",
      autoApprover(),
      "plan",
    );
    expect(planned.decision).toBe("deny");
  });

  it("scaffolds .agent/MEMORY.md and parses scopes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mem-init-"));
    expect(initWorkspace(home).created).toEqual(expect.arrayContaining([".agent/MEMORY.md"]));
    expect(parseMemoryScope("user")).toBe("user");
    expect(parseMemoryScope("project")).toBe("project");
    expect(() => parseMemoryScope("team")).toThrow(/user\|project/);
  });
});
