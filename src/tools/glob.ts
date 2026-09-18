import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { agentIgnoreFile, loadIgnoreMatcher, normalizeGlobPattern, RG_SKIP_GLOBS, type IgnoreMatcher } from "../ignore.js";
import { whichProgram } from "../platform.js";
import type { AgentConfig } from "../types.js";
import { resolveInWorkspace, toWorkspacePath } from "../workspace.js";

function rgBin(): string | undefined {
  if (fs.existsSync("/exec-daemon/rg")) return "/exec-daemon/rg";
  return whichProgram("rg");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlobPattern(pattern);
  let regex = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        const afterSlash = normalized[i + 2] === "/";
        regex += afterSlash ? ".*?" : ".*";
        i += afterSlash ? 2 : 1;
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }
  return new RegExp(`^${regex}$`);
}

async function runRgFiles(
  bin: string,
  workspace: string,
  pattern: string,
  searchPath: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const args = ["--files", "--hidden", "-g", normalizeGlobPattern(pattern), searchPath];
  for (const skip of RG_SKIP_GLOBS) args.push("--glob", skip);
  const ignoreFile = agentIgnoreFile(workspace);
  if (ignoreFile) args.push("--ignore-file", ignoreFile);
  return await new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: workspace, signal });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        resolve(undefined);
        return;
      }
      const files = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      resolve(files);
    });
  });
}

async function walkGlob(
  workspace: string,
  cwd: string,
  matcher: IgnoreMatcher,
  pattern: string,
  extraRoots: string[],
): Promise<string[]> {
  const rx = globToRegExp(pattern);
  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= 200) return;
      const abs = path.join(dir, entry.name);
      const rel = toWorkspacePath(cwd, abs);
      const ignoreRel = toWorkspacePath(workspace, abs, extraRoots);
      if (entry.isDirectory()) {
        if (matcher.ignoresDir(ignoreRel)) continue;
        if (rx.test(rel) || rx.test(`${rel}/`)) {
          matches.push(toWorkspacePath(workspace, abs, extraRoots));
        }
        await walk(abs);
        continue;
      }
      if (matcher.ignores(ignoreRel, false)) continue;
      if (rx.test(rel) || rx.test(entry.name)) {
        matches.push(toWorkspacePath(workspace, abs, extraRoots));
      }
    }
  }

  await walk(cwd);
  return matches;
}

export async function globTool(
  workspace: string,
  pattern: string,
  relPath: string | undefined,
  extraRoots: string[] = [],
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const cwd = relPath ? resolveInWorkspace(workspace, relPath, extraRoots) : resolveInWorkspace(workspace, ".", extraRoots);
  const matcher = loadIgnoreMatcher(workspace);
  const bin = rgBin();
  let matches: string[] | undefined;
  if (bin) {
    const listed = await runRgFiles(bin, workspace, pattern, cwd, signal);
    if (listed) {
      matches = listed.map((file) => {
        const abs = path.isAbsolute(file) ? file : path.resolve(workspace, file);
        return toWorkspacePath(workspace, abs, extraRoots);
      });
    }
  }
  if (!matches) matches = await walkGlob(workspace, cwd, matcher, pattern, extraRoots);
  matches.sort();
  if (matches.length === 0) return "(no matches)";
  if (matches.length >= 200) return `${matches.slice(0, 200).join("\n")}\n...[capped at 200]`;
  return matches.join("\n");
}

export function globDefinition(config: AgentConfig) {
  return {
    name: "glob",
    description: `Find files in ${config.workspace} by glob pattern, e.g. **/*.ts. Skips gitignore, .agentignore, and common build directories.`,
    risk: "read" as const,
    parameters: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Glob pattern relative to path or workspace." },
        path: { type: "string", description: "Optional subdirectory to search." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  };
}
