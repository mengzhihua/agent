import fs from "node:fs";
import path from "node:path";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function resolveInWorkspace(workspace: string, target: string, extraRoots: string[] = []): string {
  const primary = path.resolve(workspace);
  const roots = [primary, ...extraRoots.map((root) => path.resolve(root))];
  const candidate = path.isAbsolute(target) ? path.resolve(target) : path.resolve(primary, target);
  for (const root of roots) {
    if (containedRel(root, candidate) !== undefined) return candidate;
  }
  throw new WorkspaceError(`path escapes workspace: ${target}`);
}

export function toWorkspacePath(workspace: string, absolute: string, extraRoots: string[] = []): string {
  const cwdRel = containedRel(workspace, absolute);
  if (cwdRel !== undefined) return cwdRel;
  for (const root of extraRoots) {
    const rel = containedRel(root, absolute);
    if (rel === undefined) continue;
    const rootPosix = path.resolve(root).split(path.sep).join("/");
    return rel === "." ? rootPosix : `${rootPosix}/${rel}`;
  }
  return absolute.split(path.sep).join("/");
}

function containedRel(root: string, absolute: string): string | undefined {
  const rel = path.relative(path.resolve(root), path.resolve(absolute));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
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
