import fs from "node:fs";
import path from "node:path";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function resolveInWorkspace(workspace: string, target: string): string {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, target);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkspaceError(`path escapes workspace: ${target}`);
  }
  return resolved;
}

export function toWorkspacePath(workspace: string, absolute: string): string {
  const rel = path.relative(path.resolve(workspace), absolute);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

export function estimateTokens(...parts: unknown[]): number {
  const joined = parts
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .join("\n");
  return Math.ceil(joined.length / 4);
}
