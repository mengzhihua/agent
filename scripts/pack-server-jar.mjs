/**
 * Pack a Spring Boot executable JAR that launches the native agent CLI.
 * `java -jar agent-server.jar` serves /v1/prompt and /actuator/health.
 * Run: node scripts/pack-server-jar.mjs
 */
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { nativeId } from "./pack-native.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAVEN_VERSION = "3.9.9";

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
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
      pipeline(res, createWriteStream(dest)).then(resolve, reject);
    });
    req.on("error", reject);
  });
}

function findMaven(cacheDir) {
  if (spawnSync("mvn", ["-v"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0) {
    return { command: "mvn", argsPrefix: [] };
  }
  const home = path.join(cacheDir, `apache-maven-${MAVEN_VERSION}`);
  const bin = path.join(home, "bin", process.platform === "win32" ? "mvn.cmd" : "mvn");
  if (fs.existsSync(bin)) return { command: bin, argsPrefix: [] };
  return null;
}

async function ensureMaven(cacheDir) {
  const existing = findMaven(cacheDir);
  if (existing) return existing;
  const archive = path.join(cacheDir, `apache-maven-${MAVEN_VERSION}-bin.tar.gz`);
  const url = `https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz`;
  console.log(`Downloading ${url}`);
  await download(url, archive);
  const tar = spawnSync("tar", ["-xzf", archive, "-C", cacheDir], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`maven extract failed: ${tar.stderr}`);
  const found = findMaven(cacheDir);
  if (!found) throw new Error("Maven was downloaded but mvn is missing");
  return found;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "target") continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

export async function packServerJar(opts = {}) {
  const from = opts.from ?? root;
  const outDir = opts.outDir ?? path.join(from, "dist-release");
  const pkg = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
  const version = pkg.version;
  const javaHome = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (javaHome.status !== 0) throw new Error("Java 17+ is required to pack agent-server.jar");
  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".cache", "agent-pack");
  fs.mkdirSync(cacheDir, { recursive: true });
  const maven = await ensureMaven(path.join(cacheDir, "maven"));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "agent-jar-"));
  const javaRoot = path.join(from, "server-java");
  if (!fs.existsSync(path.join(javaRoot, "pom.xml"))) throw new Error("missing server-java/pom.xml");
  copyDir(javaRoot, stage);
  const consoleHtml = path.join(from, "src", "web", "console.html");
  if (fs.existsSync(consoleHtml)) {
    const staticDir = path.join(stage, "src/main/resources/static");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.copyFileSync(consoleHtml, path.join(staticDir, "index.html"));
  }
  let pom = fs.readFileSync(path.join(stage, "pom.xml"), "utf8");
  pom = pom.replace(/(<artifactId>agent-server<\/artifactId>\s*<version>)[^<]+/, `$1${version}`);
  fs.writeFileSync(path.join(stage, "pom.xml"), pom);
  const nativeDir = path.join(stage, "src/main/resources/native");
  fs.mkdirSync(nativeDir, { recursive: true });
  const nativeFiles = opts.nativeFiles ?? [];
  for (const file of nativeFiles) {
    const base = path.basename(file);
    if (base.startsWith("agent-") && !base.endsWith(".tar.gz") && !base.endsWith(".zip")) {
      fs.copyFileSync(file, path.join(nativeDir, base));
    }
  }
  const m2 = path.join(cacheDir, "m2");
  run(maven.command, [...maven.argsPrefix, "-q", "-DskipTests", `-Dmaven.repo.local=${m2}`, "package"], stage);
  const built = path.join(stage, "target", `agent-server-${version}.jar`);
  if (!fs.existsSync(built)) throw new Error("mvn package did not produce agent-server JAR");
  fs.mkdirSync(outDir, { recursive: true });
  const jar = path.join(outDir, "agent-server.jar");
  const versioned = path.join(outDir, `agent-server-${version}.jar`);
  fs.copyFileSync(built, jar);
  fs.copyFileSync(built, versioned);
  fs.rmSync(stage, { recursive: true, force: true });
  return { version, jar, versioned, target: nativeId() };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const packed = await packServerJar();
  console.log(packed.jar);
}
