import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bwrapArgs, filterSandboxEnv, hasBwrap } from "../src/sandbox/index.js";
import { shellTool } from "../src/tools/shell.js";

describe("sandbox env", () => {
  it("strips API keys and tokens from the child environment", () => {
    const filtered = filterSandboxEnv({
      PATH: "/usr/bin",
      HOME: "/home/ubuntu",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_secret",
      LANG: "C",
      HARMLESS: "ok",
    });
    expect(filtered.OPENAI_API_KEY).toBeUndefined();
    expect(filtered.GITHUB_TOKEN).toBeUndefined();
    expect(filtered.PATH).toBe("/usr/bin");
    expect(filtered.HARMLESS).toBe("ok");
    expect(filtered.LANG).toBe("C");
  });
});

describe("bwrap plan", () => {
  it("binds the workspace after tmpfs so /tmp workspaces stay visible", () => {
    const args = bwrapArgs("/tmp/ws", "/tmp/ws/src", "echo hi", ["/tmp/ws/artifacts"]);
    const bindAt = args.findIndex((item, i) => item === "--bind" && args[i + 1] === "/tmp/ws");
    const tmpfsAt = args.indexOf("/tmp");
    expect(bindAt).toBeGreaterThan(tmpfsAt);
    expect(args.includes("--unshare-net")).toBe(true);
    expect(args.at(-3)).toBe("/bin/sh");
    expect(args.at(-1)).toBe("echo hi");
  });
});

describe("shell sandbox", () => {
  it("runs in bwrap when available and blocks writes outside the workspace", async () => {
    if (!hasBwrap()) return;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sbx-"));
    const config = loadConfig({
      workspace,
      approvalMode: "auto",
      sessionDir: os.tmpdir(),
      sandbox: "auto",
    });
    expect(config.sandboxBackend).toBe("bwrap");
    const ok = await shellTool(config, "echo sandboxed-ok", undefined, 5_000, new AbortController().signal);
    expect(ok).toMatch(/sandbox: bwrap/);
    expect(ok).toMatch(/sandboxed-ok/);
    await expect(
      shellTool(config, "echo leaked > /etc/agent-sandbox-should-not-exist", undefined, 5_000, new AbortController().signal),
    ).rejects.toThrow(/Read-only file system|cannot create|Permission denied|exit:/);
    expect(fs.existsSync("/etc/agent-sandbox-should-not-exist")).toBe(false);
  });

  it("can be disabled", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sbx-off-"));
    const config = loadConfig({
      workspace,
      approvalMode: "auto",
      sessionDir: os.tmpdir(),
      sandbox: "none",
    });
    expect(config.sandboxBackend).toBe("none");
    const out = await shellTool(config, "echo nosbx", undefined, 5_000, new AbortController().signal);
    expect(out).toMatch(/sandbox: none/);
    expect(out).toMatch(/nosbx/);
  });
});
