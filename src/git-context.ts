import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { whichProgram } from "./platform.js";
import { truncate } from "./workspace.js";

export interface GitSnapshot {
  branch: string;
  dirty: boolean;
  changed: number;
  summary: string;
}

export function gitDir(workspace: string): string | undefined {
  const dir = path.join(workspace, ".git");
  try {
    if (fs.existsSync(dir)) return dir;
  } catch {
    // ignore
  }
  return undefined;
}

export function gitBinary(): string | undefined {
  return whichProgram("git") ?? whichProgram("git.exe");
}

export function inspectGit(workspace: string): GitSnapshot | undefined {
  if (!gitDir(workspace)) return undefined;
  const git = gitBinary();
  if (!git) {
    return { branch: "unknown", dirty: false, changed: 0, summary: "Git: .git present but git is not on PATH" };
  }
  const branch = runGit(git, workspace, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || "HEAD";
  const porcelain = runGit(git, workspace, ["status", "--porcelain=v1", "-b"]) ?? "";
  const files = porcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("##"));
  const dirty = files.length > 0;
  const changed = files.length;
  const lines = [`Git: ${branch}${dirty ? ` (dirty, ${changed} changed)` : " (clean)"}`];
  if (files.length > 0 && files.length <= 20) {
    lines.push(...files.slice(0, 20).map((line) => `  ${line}`));
  }
  return { branch, dirty, changed, summary: truncate(lines.join("\n"), 2048) };
}

function runGit(git: string, cwd: string, args: string[]): string | undefined {
  const result = spawnSync(git, args, {
    cwd,
    encoding: "utf8",
    timeout: 2500,
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  return result.stdout ?? "";
}
