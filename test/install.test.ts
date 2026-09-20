import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/version.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function compileProject() {
  const tscJs = path.join(root, "node_modules", "typescript", "bin", "tsc");
  return spawnSync(process.execPath, [tscJs], { cwd: root, encoding: "utf8" });
}

describe("one-click setup", () => {
  it("writes a user shim that prints the version", () => {
    const tsc = compileProject();
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
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-cli-"));
    fs.writeFileSync(
      path.join(sessionDir, "s1.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        id: "s1",
        timestamp: "2026-09-18T00:00:00.000Z",
        cwd: "/tmp",
        model: "test",
        provider: "scripted",
      })}\n${JSON.stringify({ type: "user", id: "u1", timestamp: "2026-09-18T00:00:01.000Z", text: "hello" })}\n`,
      "utf8",
    );
    const sessionList = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "session", "list", "--output-format", "json", "--session-dir", sessionDir],
      { encoding: "utf8" },
    );
    expect(sessionList.status, sessionList.stderr).toBe(0);
    expect(JSON.parse(sessionList.stdout)).toMatchObject([{ id: "s1", title: "hello" }]);
    const shown = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "session", "show", "s1", "--session-dir", sessionDir],
      { encoding: "utf8" },
    );
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("user  2026-09-18T00:00:01.000Z");
    const exported = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "session", "export", "s1", "--session-dir", sessionDir],
      { encoding: "utf8" },
    );
    expect(exported.status, exported.stderr).toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({ id: "s1", title: "hello" });
    const forked = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "session", "fork", "s1", "--output-format", "json", "--session-dir", sessionDir],
      { encoding: "utf8" },
    );
    expect(forked.status, forked.stderr).toBe(0);
    const forkBody = JSON.parse(forked.stdout) as { id: string; forkedFrom: string };
    expect(forkBody).toMatchObject({ forkedFrom: "s1" });
    expect(forkBody.id).not.toBe("s1");
    expect(fs.existsSync(path.join(sessionDir, `${forkBody.id}.jsonl`))).toBe(true);
    const cost = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "session", "cost", "s1", "--output-format", "json", "--session-dir", sessionDir],
      { encoding: "utf8" },
    );
    expect(cost.status, cost.stderr).toBe(0);
    expect(JSON.parse(cost.stdout)).toMatchObject({ id: "s1", inputTokens: 0, outputTokens: 0, calls: 0 });
    const rewound = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "session", "rewind", "s1", "--output-format", "json", "--session-dir", sessionDir],
      { encoding: "utf8" },
    );
    expect(rewound.status, rewound.stderr).toBe(0);
    expect(JSON.parse(rewound.stdout)).toMatchObject({ id: "s1", removed: 1 });
    const afterRewind = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "session", "show", "s1", "--output-format", "json", "--session-dir", sessionDir],
      { encoding: "utf8" },
    );
    expect(JSON.parse(afterRewind.stdout).events.map((event: { type: string }) => event.type)).toEqual(["session_meta"]);
    const deleted = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "session", "delete", "s1", "--output-format", "json", "--session-dir", sessionDir],
      { encoding: "utf8" },
    );
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(JSON.parse(deleted.stdout)).toEqual({ id: "s1", deleted: true });
    expect(fs.existsSync(path.join(sessionDir, "s1.jsonl"))).toBe(false);
    const evalJson = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "eval", path.join(root, "test/evals"), "--output-format", "json"],
      { encoding: "utf8" },
    );
    expect(evalJson.status, evalJson.stderr).toBe(0);
    expect(JSON.parse(evalJson.stdout)).toMatchObject({ type: "eval", failed: 0 });
    const help = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "--help"], { encoding: "utf8" });
    expect(help.stdout).toContain("--output-format");
    expect(help.stdout).toContain("--quiet");
    expect(help.stdout).toContain("agent session list");
    expect(help.stdout).toContain("agent session list|show|delete|export|fork|rewind|compact|cost");
    expect(help.stdout).toContain("--continue");
    expect(help.stdout).toContain("agent memory");
    expect(help.stdout).toContain("agent serve");
    expect(help.stdout).toContain("web console");
    expect(help.stdout).toContain("--file");
  }, 60_000);

  it("ships unix and windows installers", () => {
    const sh = fs.readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    const ps = fs.readFileSync(path.join(root, "scripts/install.ps1"), "utf8");
    expect(sh).toContain("curl");
    expect(sh).toContain("setup.mjs");
    expect(sh).toContain("PATH");
    expect(sh).toContain("releases/latest/download/agent.tgz");
    expect(sh).toContain("agent-${id}.tar.gz");
    expect(sh).toContain("--skip-build");
    expect(ps).toContain("Invoke-WebRequest");
    expect(ps).toContain("setup.mjs");
    expect(ps).toContain("PATH");
    expect(ps).toContain("releases/latest/download/agent.tgz");
    expect(ps).toContain("agent-$id.exe");
    expect(ps).toContain("--skip-build");
  });

  it("releases only after CI on main succeeds", () => {
    const release = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("pull_request");
    expect(release).toContain("workflow_run");
    expect(release).toContain("workflows: [ci]");
    expect(release).toContain("conclusion == 'success'");
    expect(release).toContain("head_branch == 'main'");
    expect(release).toContain("gh release create");
    expect(release).toContain("--latest");
    expect(release).toContain('basename "$f")" = "NOTES.md"');
    expect(release).toContain("macos-14");
    expect(release).toContain("darwin-arm64");
    expect(release).toContain("pack-mac");
    expect(release).toContain("codesign");
  });
});
