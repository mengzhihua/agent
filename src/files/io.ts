import fsp from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace, toWorkspacePath } from "../workspace.js";

export const MAX_TEXT_FILE_BYTES = 512 * 1024;

export interface TextFile {
  content: string;
  existed: boolean;
}

export interface FileIo {
  readText(relPath: string): Promise<TextFile>;
  writeText(relPath: string, content: string): Promise<void>;
}

export function diskFileIo(workspace: string, extraRoots: string[] = []): FileIo {
  return {
    async readText(relPath) {
      const abs = resolveInWorkspace(workspace, relPath, extraRoots);
      try {
        const info = await fsp.stat(abs);
        if (!info.isFile()) throw new Error(`not a file: ${relPath}`);
        if (info.size > MAX_TEXT_FILE_BYTES) {
          throw new Error(`file too large to read (${info.size} bytes): ${relPath}`);
        }
        return { content: await fsp.readFile(abs, "utf8"), existed: true };
      } catch (err) {
        if (isNotFound(err)) return { content: "", existed: false };
        throw err;
      }
    },
    async writeText(relPath, content) {
      const abs = resolveInWorkspace(workspace, relPath, extraRoots);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, "utf8");
    },
  };
}

export function formatNumbered(
  workspace: string,
  relPath: string,
  raw: string,
  offset?: number,
  limit?: number,
  extraRoots: string[] = [],
): string {
  const abs = resolveInWorkspace(workspace, relPath, extraRoots);
  const lines = raw.split("\n");
  const start = Math.max((offset ?? 1) - 1, 0);
  const end = limit ? Math.min(start + limit, lines.length) : lines.length;
  const slice = lines.slice(start, end);
  const numbered = slice.map((line, i) => {
    const n = String(start + i + 1).padStart(6, " ");
    return `${n}|${line}`;
  });
  const header = `${toWorkspacePath(workspace, abs, extraRoots)} (${lines.length} lines)`;
  return [header, ...numbered].join("\n");
}

export function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /enoent|not found|no such file|does not exist/i.test(message);
}
