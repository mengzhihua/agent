import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "../types.js";
import { resolveInWorkspace, toWorkspacePath, truncate } from "../workspace.js";

function hasRipgrep(): boolean {
  return fs.existsSync("/exec-daemon/rg") || fs.existsSync("/usr/bin/rg");
}

function rgBin(): string {
  return fs.existsSync("/exec-daemon/rg") ? "/exec-daemon/rg" : "rg";
}

async function runRg(
  workspace: string,
  pattern: string,
  searchPath: string,
  glob: string | undefined,
  maxMatches: number,
  signal: AbortSignal,
): Promise<string> {
  const args = ["-n", "--hidden", "--glob", "!.git", "--max-count", String(maxMatches), pattern, searchPath];
  if (glob) args.splice(1, 0, "--glob", glob);
  const bin = rgBin();
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: workspace, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolve(stdout.trim() || "(no matches)");
      else reject(new Error(stderr.trim() || `rg exited ${code}`));
    });
  });
}

async function walkGrep(
  workspace: string,
  root: string,
  pattern: string,
  globFilter: string | undefined,
  maxMatches: number,
  extraRoots: string[] = [],
): Promise<string> {
  const regex = new RegExp(pattern);
  const hits: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (hits.length >= maxMatches) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (globFilter && !entry.name.includes(globFilter.replace(/^\*\./, ".").replace("*", ""))) {
        // best-effort fallback; rg path is preferred
      }
      try {
        const text = await fsp.readFile(abs, "utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            hits.push(`${toWorkspacePath(workspace, abs, extraRoots)}:${i + 1}:${lines[i]}`);
            if (hits.length >= maxMatches) return;
          }
        }
      } catch {
        // skip binary / unreadable
      }
    }
  }
  await walk(root);
  return hits.length ? hits.join("\n") : "(no matches)";
}

export async function grepTool(
  workspace: string,
  pattern: string,
  relPath: string | undefined,
  glob: string | undefined,
  maxMatches: number,
  signal: AbortSignal,
  extraRoots: string[] = [],
): Promise<string> {
  const root = relPath ? resolveInWorkspace(workspace, relPath, extraRoots) : resolveInWorkspace(workspace, ".", extraRoots);
  const output = hasRipgrep()
    ? await runRg(workspace, pattern, root, glob, maxMatches, signal)
    : await walkGrep(workspace, root, pattern, glob, maxMatches, extraRoots);
  return truncate(output, 64 * 1024);
}

export function grepDefinition(config: AgentConfig) {
  return {
    name: "grep",
    description: `Search file contents in ${config.workspace} with a regex. Returns path:line:content.`,
    risk: "read" as const,
    parameters: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "JavaScript / ripgrep regular expression." },
        path: { type: "string", description: "Subdirectory or file to search, relative to workspace." },
        glob: { type: "string", description: "Optional glob filter, e.g. *.ts" },
        max_matches: { type: "integer", description: "Maximum matches to return. Default 50." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  };
}
