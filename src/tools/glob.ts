import { glob } from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "../types.js";
import { resolveInWorkspace, toWorkspacePath } from "../workspace.js";

export async function globTool(
  workspace: string,
  pattern: string,
  relPath: string | undefined,
): Promise<string> {
  const cwd = relPath ? resolveInWorkspace(workspace, relPath) : resolveInWorkspace(workspace, ".");
  const matches: string[] = [];
  for await (const entry of glob(pattern, { cwd })) {
    const abs = path.resolve(cwd, String(entry));
    matches.push(toWorkspacePath(workspace, abs));
    if (matches.length >= 200) break;
  }
  matches.sort();
  if (matches.length === 0) return "(no matches)";
  if (matches.length === 200) return `${matches.join("\n")}\n...[capped at 200]`;
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
