#!/usr/bin/env node
/**
 * Pack a runnable GitHub Release tarball: compiled dist + setup scripts.
 * Users need Node.js 22+; they do not need npm or TypeScript.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) throw new Error(`missing ${from}`);
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else copyFile(src, dest);
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.message})`);
  }
}

export function packRelease(opts = {}) {
  const from = opts.from ?? root;
  const outDir = opts.outDir ?? path.join(from, "dist-release");
  const pkg = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
  const version = pkg.version;
  if (!version) throw new Error("package.json is missing version");
  const distCli = path.join(from, "dist", "cli.js");
  if (!fs.existsSync(distCli)) {
    run("npm", ["run", "build"], from);
  }
  if (!fs.existsSync(distCli)) throw new Error("build did not produce dist/cli.js");

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pack-"));
  const folder = `agent-${version}`;
  const dest = path.join(stageRoot, folder);
  fs.mkdirSync(dest, { recursive: true });

  copyDir(path.join(from, "dist"), path.join(dest, "dist"));
  copyFile(path.join(from, "scripts", "setup.mjs"), path.join(dest, "scripts", "setup.mjs"));
  copyFile(path.join(from, "scripts", "install.sh"), path.join(dest, "scripts", "install.sh"));
  copyFile(path.join(from, "scripts", "install.ps1"), path.join(dest, "scripts", "install.ps1"));
  copyFile(path.join(from, "README.md"), path.join(dest, "README.md"));
  fs.chmodSync(path.join(dest, "scripts", "setup.mjs"), 0o755);
  fs.chmodSync(path.join(dest, "scripts", "install.sh"), 0o755);

  const releasePkg = {
    name: pkg.name,
    version,
    private: true,
    type: "module",
    description: pkg.description,
    bin: { agent: "./dist/cli.js" },
    files: ["dist", "scripts", "README.md"],
    engines: pkg.engines,
    scripts: { agent: "node dist/cli.js" },
  };
  fs.writeFileSync(path.join(dest, "package.json"), `${JSON.stringify(releasePkg, null, 2)}\n`);

  const notes = [
    `# agent ${version}`,
    "",
    "Node.js 22+ is required. npm and TypeScript are not.",
    "",
    "macOS / Linux:",
    "",
    "```bash",
    "curl -fsSL https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.sh | bash",
    "```",
    "",
    "Windows PowerShell:",
    "",
    "```powershell",
    "irm https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.ps1 | iex",
    "```",
    "",
    "The installer downloads this release tarball and writes an `agent` shim. Then run `agent doctor`.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "NOTES.md"), notes);

  const tarball = path.join(outDir, "agent.tgz");
  const versioned = path.join(outDir, `agent-${version}.tgz`);
  run("tar", ["-czf", tarball, folder], stageRoot);
  fs.copyFileSync(tarball, versioned);

  const sums = [`${sha256(tarball)}  agent.tgz`, `${sha256(versioned)}  agent-${version}.tgz`].join("\n");
  fs.writeFileSync(path.join(outDir, "SHA256SUMS"), `${sums}\n`);
  fs.rmSync(stageRoot, { recursive: true, force: true });

  return { version, outDir, tarball, versioned, notes: path.join(outDir, "NOTES.md") };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const packed = packRelease();
  console.log(`Packed agent ${packed.version}`);
  console.log(packed.tarball);
  console.log(packed.versioned);
}
