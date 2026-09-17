import { diskFileIo, formatNumbered, MAX_TEXT_FILE_BYTES, type FileIo } from "../files/io.js";
import type { AgentConfig } from "../types.js";

export async function readFileTool(
  workspace: string,
  relPath: string,
  offset?: number,
  limit?: number,
  io: FileIo = diskFileIo(workspace),
): Promise<string> {
  const { content, existed } = await io.readText(relPath);
  if (!existed) throw new Error(`not a file: ${relPath}`);
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) {
    throw new Error(`file too large to read (${Buffer.byteLength(content, "utf8")} bytes): ${relPath}`);
  }
  return formatNumbered(workspace, relPath, content, offset, limit);
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
