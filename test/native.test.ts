import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { currentNativeTarget, packNative, packableTargets, parseNativeTargets } from "../scripts/pack-native.mjs";
import { packageVersion } from "../src/version.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function waitForHealth(url: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`health ${res.statusCode}`));
            return;
          }
          setTimeout(ping, 150);
        });
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error("serve did not start"));
        else setTimeout(ping, 150);
      });
    };
    ping();
  });
}

describe("native SEA binary", () => {
  it("includes Apple Silicon among packable Darwin targets", () => {
    expect(packableTargets("darwin").map((item) => item.id)).toEqual(["darwin-x64", "darwin-arm64"]);
    expect(packableTargets("linux").map((item) => item.id)).not.toContain("darwin-arm64");
    expect(parseNativeTargets(["--targets", "darwin-arm64,darwin-x64"]).map((item) => item.id)).toEqual([
      "darwin-arm64",
      "darwin-x64",
    ]);
  });

  it("packs the current platform and runs without node on PATH", async () => {
    const tsc = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(tsc.status, tsc.stderr || tsc.stdout).toBe(0);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-native-"));
    const packed = await packNative({ from: root, outDir, targets: [currentNativeTarget()] });
    expect(packed.version).toBe(packageVersion());
    const exe = packed.files.find((file) => !file.endsWith(".tar.gz") && !file.endsWith(".zip"));
    expect(exe && fs.existsSync(exe)).toBe(true);
    if (process.platform === "darwin") {
      const signed = spawnSync("codesign", ["-dv", exe!], { encoding: "utf8" });
      expect(signed.status, signed.stderr || signed.stdout).toBe(0);
      expect(`${signed.stderr}${signed.stdout}`).toContain("adhoc");
    }
    const env = {
      ...process.env,
      PATH: fs.mkdtempSync(path.join(os.tmpdir(), "agent-empty-path-")),
    };
    const version = spawnSync(exe!, ["--version"], { encoding: "utf8", env });
    expect(version.status, version.stderr || version.stdout).toBe(0);
    expect(version.stdout.trim()).toBe(packed.version);
    const doctor = spawnSync(exe!, ["doctor"], { encoding: "utf8", env });
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain(`agent ${packed.version}`);
    expect(doctor.stdout).toContain("(sea)");
    const help = spawnSync(exe!, ["--help"], { encoding: "utf8", env });
    expect(help.stdout).toContain("agent serve");
    const child = spawn(exe!, ["serve", "--host", "127.0.0.1", "--port", "0"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`serve silent: ${stderr.join("")}`)), 15_000);
        child.stderr?.on("data", (chunk) => {
          const text = String(chunk);
          const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`serve exited ${code}: ${stderr.join("")}`));
        });
      });
      const health = await waitForHealth(`${line}/v1/health`);
      expect(health).toMatchObject({ status: "UP", version: packed.version, runtime: "sea" });
      const page = await fetch(`${line}/`);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("web console");
    } finally {
      child.kill("SIGTERM");
    }
  }, 120_000);
});
