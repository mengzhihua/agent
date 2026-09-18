import { diskFileIo, isNotFound, MAX_TEXT_FILE_BYTES, type FileIo } from "../files/io.js";
import { resolveInWorkspace } from "../workspace.js";
import type { RequestFn } from "./rpc.js";

export interface ClientFsCaps {
  readTextFile: boolean;
  writeTextFile: boolean;
}

export function parseClientCapabilities(params: unknown): ClientFsCaps {
  const empty = { readTextFile: false, writeTextFile: false };
  if (!params || typeof params !== "object") return empty;
  const caps = (params as Record<string, unknown>).clientCapabilities;
  if (!caps || typeof caps !== "object") return empty;
  const fsCaps = (caps as Record<string, unknown>).fs;
  if (!fsCaps || typeof fsCaps !== "object") return empty;
  const row = fsCaps as Record<string, unknown>;
  return {
    readTextFile: row.readTextFile === true,
    writeTextFile: row.writeTextFile === true,
  };
}

export function hasClientFs(caps: ClientFsCaps): boolean {
  return caps.readTextFile || caps.writeTextFile;
}

export function createAcpFileIo(opts: {
  workspace: string;
  sessionId: string;
  request: RequestFn;
  caps: ClientFsCaps;
  extraRoots?: string[];
}): FileIo {
  const extraRoots = opts.extraRoots ?? [];
  const disk = diskFileIo(opts.workspace, extraRoots);
  return {
    async readText(relPath) {
      if (!opts.caps.readTextFile) return disk.readText(relPath);
      const abs = resolveInWorkspace(opts.workspace, relPath, extraRoots);
      try {
        const raw = await opts.request("fs/read_text_file", {
          sessionId: opts.sessionId,
          path: abs,
        });
        const content = fileContent(raw);
        if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) {
          throw new Error(`file too large to read (${Buffer.byteLength(content, "utf8")} bytes): ${relPath}`);
        }
        return { content, existed: true };
      } catch (err) {
        if (isNotFound(err)) return { content: "", existed: false };
        throw err;
      }
    },
    async writeText(relPath, content) {
      if (!opts.caps.writeTextFile) return disk.writeText(relPath, content);
      const abs = resolveInWorkspace(opts.workspace, relPath, extraRoots);
      await opts.request("fs/write_text_file", {
        sessionId: opts.sessionId,
        path: abs,
        content,
      });
    },
  };
}

export function fileContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof (raw as { content?: unknown }).content === "string") {
    return (raw as { content: string }).content;
  }
  return "";
}
