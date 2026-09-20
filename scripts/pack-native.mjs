#!/usr/bin/env node
/**
 * Pack Node.js SEA binaries: Windows .exe, macOS and Linux executables.
 * Cross-builds by downloading the matching official Node dist for each target.
 */
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export const NATIVE_TARGETS = [
  { id: "linux-x64", node: "linux-x64", ext: "", archive: "tar.xz", macho: false, zip: false },
  { id: "linux-arm64", node: "linux-arm64", ext: "", archive: "tar.xz", macho: false, zip: false },
  { id: "darwin-x64", node: "darwin-x64", ext: "", archive: "tar.gz", macho: true, zip: false },
  { id: "darwin-arm64", node: "darwin-arm64", ext: "", archive: "tar.gz", macho: true, zip: false },
  { id: "win-x64", node: "win-x64", ext: ".exe", archive: "zip", macho: false, zip: true },
  { id: "win-arm64", node: "win-arm64", ext: ".exe", archive: "zip", macho: false, zip: true },
];

export function nativeId(platform = process.platform, arch = process.arch) {
  const osName = platform === "win32" ? "win" : platform;
  const cpu = arch === "amd64" ? "x64" : arch;
  return `${osName}-${cpu}`;
}

export function currentNativeTarget() {
  const id = nativeId();
  const target = NATIVE_TARGETS.find((item) => item.id === id);
  if (!target) throw new Error(`unsupported platform ${id}`);
  return target;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.message})`);
  }
}

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "mengzhihua-agent-pack" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(dest);
      pipeline(res, out).then(resolve, reject);
    });
    req.on("error", reject);
  });
}

function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archive.endsWith(".zip")) {
    const py = spawnSync(
      "python3",
      ["-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", archive, destDir],
      { encoding: "utf8" },
    );
    if (py.status !== 0) {
      const unzip = spawnSync("unzip", ["-q", archive, "-d", destDir], { encoding: "utf8" });
      if (unzip.status !== 0) throw new Error(`unzip failed: ${py.stderr || unzip.stderr}`);
    }
    return;
  }
  const tar = spawnSync("tar", ["-xf", archive, "-C", destDir], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar extract failed: ${tar.stderr}`);
}

function findExtractedNode(dir, target) {
  const name = target.ext ? "node.exe" : "node";
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  throw new Error(`node binary not found in ${dir}`);
}

async function nodeBinaryFor(target, nodeVersion, cacheDir) {
  const same =
    nativeId() === target.id && path.basename(process.execPath).startsWith("node") && process.versions.node === nodeVersion;
  if (same) return process.execPath;
  const stamp = `node-v${nodeVersion}-${target.node}`;
  const archiveName = `${stamp}.${target.archive}`;
  const archive = path.join(cacheDir, archiveName);
  const extracted = path.join(cacheDir, stamp);
  const marker = path.join(extracted, ".ok");
  if (!fs.existsSync(marker)) {
    const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
    console.log(`Downloading ${url}`);
    await download(url, archive);
    fs.rmSync(extracted, { recursive: true, force: true });
    extractArchive(archive, extracted);
    fs.writeFileSync(marker, "ok\n");
  }
  return findExtractedNode(extracted, target);
}

async function bundleCli(from, version, workDir) {
  const distCli = path.join(from, "dist", "cli.js");
  if (!fs.existsSync(distCli)) run("npm", ["run", "build"], from);
  if (!fs.existsSync(distCli)) throw new Error("build did not produce dist/cli.js");
  const outfile = path.join(workDir, "sea-entry.cjs");
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [distCli],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logOverride: { "empty-import-meta": "silent" },
    banner: { js: `process.env.AGENT_EMBEDDED_VERSION ??= ${JSON.stringify(version)};` },
  });
  return outfile;
}

function writeBlob(entry, workDir) {
  const configPath = path.join(workDir, "sea-config.json");
  const blob = path.join(workDir, "sea-prep.blob");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        main: entry,
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, ["--experimental-sea-config", configPath], workDir);
  if (!fs.existsSync(blob)) throw new Error("SEA blob was not generated");
  return blob;
}

async function injectBlob(binary, blob, macho) {
  const postject = await import("postject");
  const inject = postject.inject || postject.default?.inject;
  if (typeof inject !== "function") throw new Error("postject.inject is missing");
  await inject(binary, "NODE_SEA_BLOB", fs.readFileSync(blob), {
    sentinelFuse: FUSE,
    machoSegmentName: macho ? "NODE_SEA" : undefined,
    overwrite: true,
  });
}

function makeTarGz(file, archive, innerName) {
  const dir = path.dirname(file);
  const staged = path.join(dir, innerName);
  if (staged !== file) fs.copyFileSync(file, staged);
  run("tar", ["-czf", archive, innerName], dir);
  if (staged !== file) fs.rmSync(staged, { force: true });
}

function makeZip(file, archive, innerName) {
  const py = spawnSync(
    "python3",
    [
      "-c",
      "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.write(sys.argv[2], sys.argv[3]); z.close()",
      archive,
      file,
      innerName,
    ],
    { encoding: "utf8" },
  );
  if (py.status !== 0) throw new Error(`zip failed: ${py.stderr || py.stdout}`);
}

export async function packNative(opts = {}) {
  const from = opts.from ?? root;
  const outDir = opts.outDir ?? path.join(from, "dist-release");
  const pkg = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
  const version = pkg.version;
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const targets = opts.targets ?? (opts.all ? NATIVE_TARGETS : [currentNativeTarget()]);
  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".cache", "agent-pack", `node-v${nodeVersion}`);
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sea-"));
  const files = [];
  try {
    const entry = await bundleCli(from, version, workDir);
    const blob = writeBlob(entry, workDir);
    for (const target of targets) {
      const nodeBin = await nodeBinaryFor(target, nodeVersion, cacheDir);
      const outName = `agent-${target.id}${target.ext}`;
      const outFile = path.join(outDir, outName);
      fs.copyFileSync(nodeBin, outFile);
      if (!target.ext) fs.chmodSync(outFile, 0o755);
      await injectBlob(outFile, blob, target.macho);
      if (!target.ext) fs.chmodSync(outFile, 0o755);
      files.push(outFile);
      if (target.zip) {
        const zip = path.join(outDir, `agent-${target.id}.zip`);
        makeZip(outFile, zip, `agent${target.ext}`);
        files.push(zip);
      } else {
        const tgz = path.join(outDir, `agent-${target.id}.tar.gz`);
        makeTarGz(outFile, tgz, "agent");
        files.push(tgz);
      }
      console.log(`Packed ${outName}`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return { version, outDir, files, targets: targets.map((item) => item.id) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const packed = await packNative({ all: process.argv.includes("--all") });
  for (const file of packed.files) console.log(file);
}
