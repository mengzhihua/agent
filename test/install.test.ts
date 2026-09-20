import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/version.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("one-click setup", () => {
  it("writes a user shim that prints the version", () => {
    const tsc = spawnSync("npx", ["tsc"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
    expect(tsc.status, tsc.stderr || tsc.stdout).toBe(0);
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "agent-setup-"));
    const setup = spawnSync(
      process.execPath,
      [path.join(root, "scripts/setup.mjs"), "--from", root, "--prefix", prefix, "--no-link", "--skip-build"],
      { cwd: root, encoding: "utf8" },
    );
    expect(setup.status, setup.stderr || setup.stdout).toBe(0);
    const shim = process.platform === "win32" ? path.join(prefix, "bin", "agent.cmd") : path.join(prefix, "bin", "agent");
    expect(fs.existsSync(shim)).toBe(true);
    const ran = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "--version"], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe(packageVersion());
    const doctor = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "doctor"], { encoding: "utf8" });
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain(`agent ${packageVersion()}`);
    const config = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "config"], { encoding: "utf8" });
    expect(config.status).toBe(0);
    expect(config.stdout).toMatch(/^config /m);
    const completion = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "completion", "bash"], {
      encoding: "utf8",
    });
    expect(completion.status).toBe(0);
    expect(completion.stdout).toContain("complete -F _agent agent");
    const emptySessions = fs.mkdtempSync(path.join(os.tmpdir(), "agent-list-"));
    const listed = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "--list", "--output-format", "json", "--session-dir", emptySessions],
      { encoding: "utf8" },
    );
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);
    const help = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "--help"], { encoding: "utf8" });
    expect(help.stdout).toContain("--output-format");
    expect(help.stdout).toContain("--quiet");
  });

  it("ships unix and windows installers", () => {
    const sh = fs.readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    const ps = fs.readFileSync(path.join(root, "scripts/install.ps1"), "utf8");
    expect(sh).toContain("curl");
    expect(sh).toContain("setup.mjs");
    expect(sh).toContain("PATH");
    expect(ps).toContain("Invoke-WebRequest");
    expect(ps).toContain("setup.mjs");
    expect(ps).toContain("PATH");
  });
});
