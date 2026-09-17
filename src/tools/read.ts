import type { AgentConfig } from "../types.js";
import { resolveInWorkspace, toWorkspacePath } from "../workspace.js";

export async function readFileTool(
  workspace: string,
  relPath: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  const abs = resolveInWorkspace(workspace, relPath);
  const { readFile, stat } = await import("node:fs/promises");
  const info = await stat(abs);
  if (!info.isFile()) {
    throw new Error(`not a file: ${relPath}`);
  }
  if (info.size > 512 * 1024) {
    throw new Error(`file too large to read (${info.size} bytes): ${relPath}`);
  }
  const raw = await readFile(abs, "utf8");
  const lines = raw.split("\n");
  const start = Math.max((offset ?? 1) - 1, 0);
  const end = limit ? Math.min(start + limit, lines.length) : lines.length;
  const slice = lines.slice(start, end);
  const numbered = slice.map((line, i) => {
    const n = String(start + i + 1).padStart(6, " ");
    return `${n}|${line}`;
  });
  const header = `${toWorkspacePath(workspace, abs)} (${lines.length} lines)`;
  return [header, ...numbered].join("\n");
}

export function readDefinition(config: AgentConfig) {
  return {
    name: "read",
    description: `Read a UTF-8 text file from the workspace (${config.workspace}). Returns numbered lines.`,
    risk: "read" as const,
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        offset: { type: "integer", description: "1-indexed start line." },
        limit: { type: "integer", description: "Maximum number of lines to return." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}
