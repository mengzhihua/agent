import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { currentNativeTarget, packNative } from "../scripts/pack-native.mjs";
import { packServerJar } from "../scripts/pack-server-jar.mjs";
import { packageVersion } from "../src/version.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasJava = spawnSync("java", ["-version"], { encoding: "utf8" }).status === 0;

function waitForHealth(url: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
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
          setTimeout(ping, 250);
        });
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error("jar did not start"));
        else setTimeout(ping, 250);
      });
    };
    ping();
  });
}

describe.skipIf(!hasJava || process.platform !== "linux")("spring boot jar", () => {
  it("packs java -jar agent-server.jar and serves health", async () => {
    const tsc = spawnSync("npx", ["tsc"], { cwd: root, encoding: "utf8" });
    expect(tsc.status, tsc.stderr || tsc.stdout).toBe(0);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-jar-"));
    const native = await packNative({ from: root, outDir, targets: [currentNativeTarget()] });
    const packed = await packServerJar({ from: root, outDir, nativeFiles: native.files });
    expect(packed.version).toBe(packageVersion());
    expect(fs.existsSync(packed.jar)).toBe(true);
    const exe = native.files.find((file) => !file.endsWith(".tar.gz") && !file.endsWith(".zip"));
    const child = spawn("java", ["-jar", packed.jar], {
      env: { ...process.env, AGENT_BIN: exe!, PORT: "18080" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs: string[] = [];
    child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
    child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
    try {
      const health = await waitForHealth("http://127.0.0.1:18080/v1/health");
      expect(health.status).toBe("UP");
      expect(String(health.version)).toContain(packed.version);
      expect(health.runtime).toBe("spring-boot");
      const actuator = await waitForHealth("http://127.0.0.1:18080/actuator/health");
      expect(actuator.status).toBe("UP");
      const page = await fetch("http://127.0.0.1:18080/");
      expect(page.headers.get("content-type") || "").toContain("text/html");
      expect(await page.text()).toContain("web console");
    } finally {
      child.kill("SIGTERM");
    }
  }, 180_000);
});
