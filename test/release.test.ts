import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packRelease } from "../scripts/pack-release.mjs";
import { packageVersion } from "../src/version.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("release tarball", () => {
  it("packs a prebuilt dist that installs without npm", () => {
    const tsc = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(tsc.status, tsc.stderr || tsc.stdout).toBe(0);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pack-out-"));
    const packed = packRelease({ from: root, outDir });
    expect(packed.version).toBe(packageVersion());
    expect(fs.existsSync(packed.tarball)).toBe(true);
    expect(fs.existsSync(path.join(outDir, `agent-${packed.version}.tgz`))).toBe(true);
    expect(fs.readFileSync(path.join(outDir, "SHA256SUMS"), "utf8")).toContain("agent.tgz");

    const extract = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pack-extract-"));
    const tar = spawnSync("tar", ["-xzf", packed.tarball, "-C", extract], { encoding: "utf8" });
    expect(tar.status, tar.stderr).toBe(0);
    const unpacked = path.join(extract, `agent-${packed.version}`);
    expect(fs.existsSync(path.join(unpacked, "dist", "cli.js"))).toBe(true);
    expect(fs.existsSync(path.join(unpacked, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(unpacked, "src"))).toBe(false);
    const releasePkg = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
    expect(releasePkg.scripts.prepare).toBeUndefined();

    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "agent-release-prefix-"));
    const setup = spawnSync(
      process.execPath,
      [path.join(unpacked, "scripts/setup.mjs"), "--from", unpacked, "--prefix", prefix, "--no-link", "--skip-build"],
      { encoding: "utf8" },
    );
    expect(setup.status, setup.stderr || setup.stdout).toBe(0);
    const cli = path.join(unpacked, "dist", "cli.js");
    const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(packed.version);
    const doctor = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8" });
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain(`agent ${packed.version}`);
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("agent memory");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rel-sess-"));
    const listed = spawnSync(process.execPath, [cli, "session", "list", "--output-format", "json", "--session-dir", empty], {
      encoding: "utf8",
    });
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);
    const memory = spawnSync(process.execPath, [cli, "memory", "show", "--output-format", "json", "-w", empty], {
      encoding: "utf8",
      env: { ...process.env, AGENT_HOME: empty },
    });
    expect(memory.status, memory.stderr).toBe(0);
    expect(JSON.parse(memory.stdout)).toMatchObject({ type: "memory" });
    const evalJson = spawnSync(process.execPath, [cli, "eval", path.join(root, "test/evals"), "--output-format", "json"], {
      encoding: "utf8",
    });
    expect(evalJson.status, evalJson.stderr).toBe(0);
    expect(JSON.parse(evalJson.stdout)).toMatchObject({ type: "eval", failed: 0 });
  });
});
