#!/usr/bin/env node
/**
 * Build this checkout and install a user-level `agent` shim.
 * Used by scripts/install.sh and scripts/install.ps1.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.message})`);
  }
}

function writeFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
}

function unixShim(root) {
  return `#!/bin/sh
export AGENT_INSTALL_ROOT="${root}"
exec node "${path.join(root, "dist", "cli.js")}" "$@"
`;
}

function windowsShim(root) {
  const cli = path.join(root, "dist", "cli.js");
  return `@echo off\r
set "AGENT_INSTALL_ROOT=${root}"\r
node "${cli}" %*\r
`;
}

function defaultPrefix() {
  return process.env.AGENT_PREFIX || path.join(os.homedir(), ".agent");
}

function linkUnix(shim) {
  const localBin = path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });
  const dest = path.join(localBin, "agent");
  try {
    fs.rmSync(dest, { force: true });
  } catch {
    // ignore
  }
  try {
    fs.symlinkSync(shim, dest);
  } catch {
    fs.copyFileSync(shim, dest);
    fs.chmodSync(dest, 0o755);
  }
  return dest;
}

function linkWindows(shim) {
  return shim;
}

function pathSetupCandidates(from, prefix) {
  return [
    path.join(from, "dist", "path_setup.js"),
    path.join(prefix, "src", "dist", "path_setup.js"),
    path.join(here, "..", "dist", "path_setup.js"),
  ];
}

async function loadPathSetup(from, prefix) {
  for (const mod of pathSetupCandidates(from, prefix)) {
    if (!fs.existsSync(mod)) continue;
    return await import(pathToFileURL(mod).href);
  }
  return null;
}

function fallbackStripPath(binDir) {
  if (process.platform === "win32") {
    const escaped = binDir.replace(/'/g, "''");
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$dir = '${escaped}'; $current = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($null -eq $current) { return }; $parts = @(); foreach ($item in $current.Split(';')) { if (-not $item) { continue }; if ($item.TrimEnd('\\').ToLower() -eq $dir.TrimEnd('\\').ToLower()) { continue }; $parts += $item }; [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    return;
  }
  const home = os.homedir();
  fs.rmSync(path.join(home, ".agent", "env.sh"), { force: true });
  const marker = "# agent PATH";
  for (const name of [".profile", ".bashrc", ".zshrc", ".zprofile"]) {
    const file = path.join(home, name);
    if (!fs.existsSync(file)) continue;
    const existing = fs.readFileSync(file, "utf8");
    if (!existing.includes(marker)) continue;
    const lines = existing.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(marker)) {
        if (i + 1 < lines.length) i += 1;
        if (i + 1 < lines.length && lines[i + 1] === "") i += 1;
        continue;
      }
      out.push(lines[i]);
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    fs.writeFileSync(file, out.length === 0 ? "" : `${out.join("\n")}\n`);
  }
}

async function applyPath(from, prefix, binDir) {
  const api = await loadPathSetup(from, prefix);
  if (!api?.ensureUserPath) return;
  const result = api.ensureUserPath(binDir);
  console.log(result.message);
}

async function stripPath(from, prefix, binDir) {
  const api = await loadPathSetup(from, prefix);
  if (api?.removeUserPath) {
    api.removeUserPath(binDir);
    return;
  }
  fallbackStripPath(binDir);
}

function uninstall(prefix) {
  const binDir = path.join(prefix, "bin");
  const src = path.join(prefix, "src");
  fs.rmSync(path.join(binDir, process.platform === "win32" ? "agent.cmd" : "agent"), { force: true });
  if (process.platform !== "win32") {
    fs.rmSync(path.join(os.homedir(), ".local", "bin", "agent"), { force: true });
  }
  fs.rmSync(src, { recursive: true, force: true });
}

async function main() {
  const prefix = path.resolve(argValue("--prefix", defaultPrefix()));
  const from = path.resolve(argValue("--from", path.join(here, "..")));
  const pathBin = process.platform === "win32" ? path.join(prefix, "bin") : path.join(os.homedir(), ".local", "bin");
  if (hasFlag("--uninstall")) {
    await stripPath(from, prefix, pathBin);
    uninstall(prefix);
    console.log(`Removed ${prefix} checkout and shims.`);
    return;
  }

  const pkg = path.join(from, "package.json");
  if (!fs.existsSync(pkg)) {
    throw new Error(`not an agent checkout: ${from}`);
  }

  if (!hasFlag("--skip-build")) {
    console.log(`Building agent from ${from}`);
    run("npm", ["install"], from);
    run("npm", ["run", "build"], from);
  } else {
    console.log(`Using existing build in ${from}`);
  }
  const cli = path.join(from, "dist", "cli.js");
  if (!fs.existsSync(cli)) {
    throw new Error("build did not produce dist/cli.js");
  }

  const binDir = path.join(prefix, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  let shim;
  if (process.platform === "win32") {
    shim = path.join(binDir, "agent.cmd");
    writeFile(shim, windowsShim(from));
  } else {
    shim = path.join(binDir, "agent");
    writeFile(shim, unixShim(from));
  }

  if (!hasFlag("--no-link")) {
    const linked = process.platform === "win32" ? linkWindows(shim) : linkUnix(shim);
    console.log(`Installed ${linked}`);
    await applyPath(from, prefix, pathBin);
  } else {
    console.log(`Installed ${shim}`);
  }

  const check = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  if (check.status === 0) {
    console.log(`agent ${String(check.stdout).trim()}  (${process.platform}/${process.arch})`);
  }
  console.log("Next: agent doctor");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
