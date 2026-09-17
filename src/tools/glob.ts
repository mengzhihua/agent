import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "../types.js";
import { resolveInWorkspace, toWorkspacePath } from "../workspace.js";

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
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

export async function globTool(
  workspace: string,
  pattern: string,
  relPath: string | undefined,
): Promise<string> {
  const cwd = relPath ? resolveInWorkspace(workspace, relPath) : resolveInWorkspace(workspace, ".");
  const matcher = globToRegExp(pattern.replaceAll("\\", "/"));
  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= 200) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const abs = path.join(dir, entry.name);
      const rel = toWorkspacePath(cwd, abs);
      if (entry.isDirectory()) {
        if (matcher.test(rel) || matcher.test(rel + "/")) {
          matches.push(toWorkspacePath(workspace, abs));
        }
        await walk(abs);
        continue;
      }
      if (matcher.test(rel)) {
        matches.push(toWorkspacePath(workspace, abs));
      }
    }
  }

  await walk(cwd);
  matches.sort();
  if (matches.length === 0) return "(no matches)";
  if (matches.length >= 200) return `${matches.join("\n")}\n...[capped at 200]`;
  return matches.join("\n");
}

export function globDefinition(config: AgentConfig) {
  return {
    name: "glob",
    description: `Find files in ${config.workspace} by glob pattern, e.g. **/*.ts`,
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
