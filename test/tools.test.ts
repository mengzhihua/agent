import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { defaultShell } from "../src/platform.js";
import { grepTool } from "../src/tools/grep.js";
import { globTool } from "../src/tools/glob.js";
import { readFileTool } from "../src/tools/read.js";
import { shellTool } from "../src/tools/shell.js";
import { webSearchTool } from "../src/tools/web_search.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/broken-add");

describe("read/grep/glob/shell", () => {
  it("reads numbered lines", async () => {
    const out = await readFileTool(fixture, "add.mjs");
    expect(out).toMatch(/add\.mjs/);
    expect(out).toMatch(/1\|export function add/);
  });

  it("greps a regex", async () => {
    const out = await grepTool(fixture, "a - b", undefined, undefined, 10, new AbortController().signal);
    expect(out).toMatch(/add\.mjs/);
  });

  it("globs mjs files", async () => {
    const out = await globTool(fixture, "*.mjs", undefined);
    expect(out).toMatch(/add\.mjs/);
    expect(out).toMatch(/add\.test\.mjs/);
  });

  it("runs a shell command in the workspace", async () => {
    const config = loadConfig({ workspace: fixture, approvalMode: "auto", sessionDir: os.tmpdir() });
    const out = await shellTool(config, "node -e \"console.log('hi')\"", undefined, 5_000, new AbortController().signal);
    expect(out).toMatch(/hi/);
    expect(out).toMatch(/exit: 0/);
  });

  it("rejects shell cwd escape", async () => {
    const config = loadConfig({ workspace: fixture, approvalMode: "auto", sessionDir: os.tmpdir() });
    await expect(
      shellTool(config, "pwd", "../", 1_000, new AbortController().signal),
    ).rejects.toThrow(/escapes workspace/);
  });

  it("runs shell via an ACP terminal client", async () => {
    const config = loadConfig({ workspace: fixture, approvalMode: "auto", sessionDir: os.tmpdir(), sandbox: "none" });
    const methods: string[] = [];
    const out = await shellTool(config, "echo hi", undefined, 5_000, new AbortController().signal, {
      terminal: {
        create: async (input) => {
          methods.push("create");
          expect(input.args).toEqual([...defaultShell().argsPrefix, "echo hi"]);
          expect(input.cwd).toBe(fixture);
          return "term_1";
        },
        waitForExit: async () => {
          methods.push("wait");
          return { exitCode: 0, signal: null };
        },
        output: async () => {
          methods.push("output");
          return { output: "hi\n", truncated: false, exitStatus: { exitCode: 0, signal: null } };
        },
        kill: async () => {
          methods.push("kill");
        },
        release: async () => {
          methods.push("release");
        },
      },
    });
    expect(out).toMatch(/hi/);
    expect(out).toMatch(/client-terminal/);
    expect(methods).toEqual(["create", "wait", "output", "release"]);
  });

  it("kills the client terminal on timeout", async () => {
    const config = loadConfig({ workspace: fixture, approvalMode: "auto", sessionDir: os.tmpdir(), sandbox: "none" });
    const methods: string[] = [];
    await expect(
      shellTool(config, "sleep 30", undefined, 20, new AbortController().signal, {
        terminal: {
          create: async () => "term_1",
          waitForExit: () => new Promise(() => undefined),
          output: async () => ({ output: "partial\n", truncated: false }),
          kill: async () => {
            methods.push("kill");
          },
          release: async () => {
            methods.push("release");
          },
        },
      }),
    ).rejects.toThrow(/timeout/);
    expect(methods).toEqual(["kill", "release"]);
  });
});

describe("web_search", () => {
  it("formats injected results", async () => {
    const out = await webSearchTool("agent harness", 2, new AbortController().signal, async () => [
      { title: "Codex loop", url: "https://example.com/codex", snippet: "agent loop" },
    ]);
    expect(out).toContain("Codex loop");
    expect(out).toContain("https://example.com/codex");
  });
});
