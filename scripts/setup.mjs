#!/usr/bin/env node
/**
 * Build this checkout and install a user-level `agent` shim.
 * Used by scripts/install.sh and scripts/install.ps1.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function linkUnix(shim, prefix) {
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
  const pathEnv = process.env.PATH ?? "";
  if (!pathEnv.split(path.delimiter).some((dir) => path.resolve(dir) === path.resolve(localBin))) {
    console.log(`Add ${localBin} to PATH if \`agent\` is not found.`);
  }
  return dest;
}

function linkWindows(shim) {
  const userPath = process.env.Path || process.env.PATH || "";
  const binDir = path.dirname(shim);
  if (!userPath.split(";").some((dir) => dir.toLowerCase() === binDir.toLowerCase())) {
    console.log(`Add ${binDir} to your user PATH, then open a new terminal.`);
    console.log(`  setx PATH "${binDir};%PATH%"`);
  }
  return shim;
}

function uninstall(prefix) {
  const binDir = path.join(prefix, "bin");
  const src = path.join(prefix, "src");
  fs.rmSync(path.join(binDir, process.platform === "win32" ? "agent.cmd" : "agent"), { force: true });
  if (process.platform !== "win32") {
    fs.rmSync(path.join(os.homedir(), ".local", "bin", "agent"), { force: true });
  }
  fs.rmSync(src, { recursive: true, force: true });
  console.log(`Removed ${prefix} checkout and shims.`);
}

const prefix = path.resolve(argValue("--prefix", defaultPrefix()));
if (hasFlag("--uninstall")) {
  uninstall(prefix);
  process.exit(0);
}

const from = path.resolve(argValue("--from", path.join(here, "..")));
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
  const linked = process.platform === "win32" ? linkWindows(shim) : linkUnix(shim, prefix);
  console.log(`Installed ${linked}`);
} else {
  console.log(`Installed ${shim}`);
}

const check = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
if (check.status === 0) {
  console.log(`agent ${String(check.stdout).trim()}  (${process.platform}/${process.arch})`);
}
console.log("Next: agent doctor");
