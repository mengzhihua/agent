/**
 * Pack a runnable GitHub Release tarball: compiled dist + setup scripts.
 * Users need Node.js 22+; they do not need npm or TypeScript.
 * Run: node scripts/pack-release.mjs
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

  writeNotes(outDir, version, readChangelog(from, version));


  const tarball = path.join(outDir, "agent.tgz");
  const versioned = path.join(outDir, `agent-${version}.tgz`);
  run("tar", ["-czf", tarball, folder], stageRoot);
  fs.copyFileSync(tarball, versioned);

  const sums = [`${sha256(tarball)}  agent.tgz`, `${sha256(versioned)}  agent-${version}.tgz`].join("\n");
  fs.writeFileSync(path.join(outDir, "SHA256SUMS"), `${sums}\n`);
  fs.rmSync(stageRoot, { recursive: true, force: true });

  return { version, outDir, tarball, versioned, notes: path.join(outDir, "NOTES.md") };
}

export function changelogSection(markdown, version) {
  const header = `## ${version}`;
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return "";
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

function readChangelog(from, version) {
  const file = path.join(from, "CHANGELOG.md");
  if (!fs.existsSync(file)) return "";
  return changelogSection(fs.readFileSync(file, "utf8"), version);
}

export function writeNotes(outDir, version, changelog = "") {
  const changes = changelog.trim() ? ["## Changes", "", changelog.trim(), ""] : [];
  const notes = [
    `# agent ${version}`,
    "",
    ...changes,
    "Preferred: native binaries. Node.js is not required.",
    "",
    "| Platform | Asset |",
    "| --- | --- |",
    "| Windows x64 | `agent-win-x64.exe` or `agent-win-x64.zip` |",
    "| Windows arm64 | `agent-win-arm64.exe` |",
    "| macOS Apple Silicon | `agent-darwin-arm64.tar.gz` (codesigned on macOS 14) |",
    "| macOS Intel | `agent-darwin-x64.tar.gz` |",
    "| Linux x64 | `agent-linux-x64.tar.gz` |",
    "| Linux arm64 | `agent-linux-arm64.tar.gz` |",
    "| Server (Java 17+) | `agent-server.jar` |",
    "| Fallback (needs Node 22) | `agent.tgz` |",
    "",
    "Install:",
    "",
    "```bash",
    "curl -fsSL https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.sh | bash",
    "```",
    "",
    "```powershell",
    "irm https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.ps1 | iex",
    "```",
    "",
    "HTTP server: `agent serve --port 8080` opens a web console at `/`. `java -jar agent-server.jar` is the same API.",
    "Stream a turn: `curl -N localhost:8080/v1/prompt -H 'accept: text/event-stream' -d '{\"prompt\":\"hi\",\"stream\":true}'`.",
    "Health: `GET /v1/health` and `GET /actuator/health`. Prompt: `POST /v1/prompt`.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "NOTES.md"), notes);
  return path.join(outDir, "NOTES.md");
}

export function writeChecksums(outDir) {
  const names = fs.readdirSync(outDir).filter((name) => name !== "SHA256SUMS" && name !== "NOTES.md").sort();
  const lines = names
    .filter((name) => fs.statSync(path.join(outDir, name)).isFile())
    .map((name) => `${sha256(path.join(outDir, name))}  ${name}`);
  fs.writeFileSync(path.join(outDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

export function finalizeRelease(opts = {}) {
  const from = opts.from ?? root;
  const outDir = opts.outDir ?? path.join(from, "dist-release");
  const pkg = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
  writeNotes(outDir, pkg.version, readChangelog(from, pkg.version));
  writeChecksums(outDir);
  return { version: pkg.version, outDir };
}

export async function packAll(opts = {}) {
  const packed = packRelease(opts);
  const argv = opts.argv ?? process.argv.slice(2);
  const all = Boolean(opts.all || argv.includes("--all"));
  let nativeFiles = [];
  if (!argv.includes("--no-native")) {
    const { packNative } = await import("./pack-native.mjs");
    const native = await packNative({ from: opts.from, outDir: packed.outDir, all, argv });
    nativeFiles = native.files;
  }
  if (!argv.includes("--no-jar")) {
    const { packServerJar } = await import("./pack-server-jar.mjs");
    await packServerJar({ from: opts.from, outDir: packed.outDir, nativeFiles });
  }
  writeNotes(packed.outDir, packed.version, readChangelog(opts.from ?? root, packed.version));
  writeChecksums(packed.outDir);
  return packed;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--finalize")) {
    const packed = finalizeRelease();
    console.log(`Finalized agent ${packed.version}`);
    console.log(packed.outDir);
  } else {
    const packed = await packAll();
    console.log(`Packed agent ${packed.version}`);
    console.log(packed.outDir);
  }
}
