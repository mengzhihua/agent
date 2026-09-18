import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentsMd } from "../src/context/agents-md.js";
import { gitBinary, inspectGit } from "../src/git-context.js";
import { loadIgnoreMatcher, parseIgnoreLine } from "../src/ignore.js";
import { formatInitResult, initWorkspace } from "../src/init.js";
import { canRunInParallel, toolBatches } from "../src/loop/agent-loop.js";
import { grepTool } from "../src/tools/grep.js";
import { globTool } from "../src/tools/glob.js";

describe("ignore rules", () => {
  it("parses gitignore syntax and applies last-match negation", () => {
    const matcher = loadIgnoreMatcher(fs.mkdtempSync(path.join(os.tmpdir(), "agent-ign-")));
    expect(matcher.ignoresDir("node_modules")).toBe(true);
    expect(matcher.ignores("node_modules/pkg/index.js", false)).toBe(true);
    expect(matcher.ignores("src/app.ts", false)).toBe(false);
    expect(matcher.ignores(".env", false)).toBe(true);
    expect(parseIgnoreLine("*.log")?.regex.test("tmp/a.log")).toBe(true);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ign2-"));
    fs.writeFileSync(path.join(home, ".agentignore"), "keep.txt\n!keep.txt\nsecret.txt\n");
    const custom = loadIgnoreMatcher(home);
    expect(custom.ignores("secret.txt", false)).toBe(true);
    expect(custom.ignores("keep.txt", false)).toBe(false);
  });

  it("grep and glob skip ignored build dirs and .agentignore", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-search-"));
    fs.mkdirSync(path.join(home, "src"));
    fs.mkdirSync(path.join(home, "coverage"));
    fs.writeFileSync(path.join(home, "src", "app.ts"), "UNIQUE_APP_TOKEN\n");
    fs.writeFileSync(path.join(home, "coverage", "hit.txt"), "UNIQUE_COVERAGE_TOKEN\n");
    fs.writeFileSync(path.join(home, "secret.txt"), "UNIQUE_SECRET_TOKEN\n");
    fs.writeFileSync(path.join(home, ".agentignore"), "secret.txt\n");
    const grepApp = await grepTool(home, "UNIQUE_APP_TOKEN", undefined, undefined, 20, new AbortController().signal);
    expect(grepApp).toContain("app.ts");
    const grepCov = await grepTool(home, "UNIQUE_COVERAGE_TOKEN", undefined, undefined, 20, new AbortController().signal);
    expect(grepCov).not.toContain("UNIQUE_COVERAGE_TOKEN");
    const grepSecret = await grepTool(home, "UNIQUE_SECRET_TOKEN", undefined, undefined, 20, new AbortController().signal);
    expect(grepSecret).not.toContain("UNIQUE_SECRET_TOKEN");
    const globbed = await globTool(home, "*.ts");
    expect(globbed).toContain("app.ts");
    expect(globbed).not.toContain("coverage");
  });
});

describe("init and parent AGENTS.md", () => {
  it("scaffolds project files once", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-init-"));
    const first = initWorkspace(home);
    expect(first.created).toEqual(expect.arrayContaining(["AGENTS.md", ".agentignore", ".agent/mcp.json", ".agent/hooks.json"]));
    expect(fs.existsSync(path.join(home, ".agent", "skills"))).toBe(true);
    const second = initWorkspace(home);
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
    expect(formatInitResult(second)).toContain("exists:");
  });

  it("loads parent AGENTS.md above the workspace", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-parent-"));
    const child = path.join(parent, "app");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(parent, "AGENTS.md"), "from-parent");
    fs.writeFileSync(path.join(child, "AGENTS.md"), "from-child");
    const text = loadAgentsMd(child);
    expect(text).toContain("from-parent");
    expect(text).toContain("from-child");
    expect(text.indexOf("from-parent")).toBeLessThan(text.indexOf("from-child"));
  });
});

describe("git snapshot", () => {
  it("returns nothing without .git", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-nogit-"));
    expect(inspectGit(home)).toBeUndefined();
  });

  it("summarizes a real git checkout when git is available", () => {
    const git = gitBinary();
    if (!git) return;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-git-"));
    const init = spawnSync(git, ["init", "-b", "main"], { cwd: home, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    fs.writeFileSync(path.join(home, "a.txt"), "hi\n");
    const snap = inspectGit(home);
    expect(snap?.branch).toMatch(/main|HEAD|master/);
    expect(snap?.dirty).toBe(true);
    expect(snap?.summary).toMatch(/Git:/);
  });
});

describe("parallel read batches", () => {
  it("groups consecutive read tools and splits on writes", () => {
    expect(canRunInParallel("read")).toBe(true);
    expect(canRunInParallel("apply_patch")).toBe(false);
    expect(canRunInParallel("ask_user")).toBe(false);
    const batches = toolBatches([
      { id: "1", name: "read", arguments: { path: "a.ts" } },
      { id: "2", name: "grep", arguments: { pattern: "x" } },
      { id: "3", name: "apply_patch", arguments: { path: "a.ts" } },
      { id: "4", name: "glob", arguments: { pattern: "*.ts" } },
    ]);
    expect(batches.map((batch) => batch.map((call) => call.name))).toEqual([
      ["read", "grep"],
      ["apply_patch"],
      ["glob"],
    ]);
  });
});
