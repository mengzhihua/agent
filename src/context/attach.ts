import fs from "node:fs";
import { loadIgnoreMatcher } from "../ignore.js";
import { MAX_TEXT_FILE_BYTES } from "../files/io.js";
import { toWorkspacePath, truncate, WorkspaceError, resolveInWorkspace } from "../workspace.js";

export const MAX_ATTACH_FILE_CHARS = 32 * 1024;
export const MAX_ATTACH_TOTAL_CHARS = 96 * 1024;
export const MAX_ATTACH_FILES = 24;

export interface AttachMention {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface PreloadedAttachment {
  path: string;
  content: string;
}

export interface AttachOptions {
  workspace: string;
  extraRoots?: string[];
  extraFiles?: string[];
  preloaded?: PreloadedAttachment[];
}

export function parseAtMentions(text: string): AttachMention[] {
  const mentions: AttachMention[] = [];
  const seen = new Set<string>();
  const re = /(^|[\s([{'"])@([^\s@]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const token = (match[2] ?? "").replace(/[),.;!?]+$/g, "");
    if (!token) continue;
    const parsed = parsePathToken(token);
    if (!parsed || !looksLikePath(parsed.path)) continue;
    const key = mentionKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(parsed);
  }
  return mentions;
}

export function fileUriToLocalPath(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return trimmed;
  let rest = trimmed;
  if (rest.startsWith("file://")) rest = rest.slice("file://".length);
  else if (rest.startsWith("file:")) rest = rest.slice("file:".length);
  else return trimmed;
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // keep encoded
  }
  rest = rest.replaceAll("\\", "/");
  if (/^\/\/localhost\b/i.test(rest)) rest = rest.slice("//localhost".length);
  else if (/^localhost\//i.test(rest)) rest = rest.slice("localhost".length);
  rest = rest.replace(/^\/+([A-Za-z]:)/, "$1");
  if (process.platform === "win32") return rest.replaceAll("/", "\\");
  return rest;
}

export function injectAttachments(prompt: string, opts: AttachOptions): string {
  const extraRoots = opts.extraRoots ?? [];
  const sources = collectSources(prompt, opts);
  if (sources.length === 0) return prompt;
  const blocks: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const source of sources) {
    const key = mentionKey(source.mention);
    if (seen.has(key)) continue;
    seen.add(key);
    if (blocks.length >= MAX_ATTACH_FILES) break;
    const loaded = loadSource(source, opts.workspace, extraRoots);
    const block = renderAttachment(loaded);
    if (total + block.length > MAX_ATTACH_TOTAL_CHARS) {
      blocks.push(`<file path="${escapeXml(loaded.path)}" error="attachment budget exceeded" />`);
      break;
    }
    total += block.length;
    blocks.push(block);
  }
  if (blocks.length === 0) return prompt;
  return `<attached_files>\n${blocks.join("\n")}\n</attached_files>\n\n${prompt}`;
}

type Source =
  | { kind: "path"; mention: AttachMention }
  | { kind: "embedded"; mention: AttachMention; content: string };

interface LoadedAttachment {
  path: string;
  content?: string;
  error?: string;
  startLine?: number;
  endLine?: number;
}

function collectSources(prompt: string, opts: AttachOptions): Source[] {
  const sources: Source[] = [];
  for (const item of opts.preloaded ?? []) {
    if (!item.path && !item.content) continue;
    sources.push({
      kind: "embedded",
      mention: { path: item.path || "embedded" },
      content: item.content,
    });
  }
  for (const extra of opts.extraFiles ?? []) {
    if (!extra.trim()) continue;
    sources.push({ kind: "path", mention: parsePathToken(extra.trim()) ?? { path: extra.trim() } });
  }
  for (const mention of parseAtMentions(prompt)) {
    sources.push({ kind: "path", mention });
  }
  return sources;
}

function loadSource(source: Source, workspace: string, extraRoots: string[]): LoadedAttachment {
  if (source.kind === "embedded") {
    return {
      path: displayPath(workspace, extraRoots, source.mention.path),
      content: truncate(source.content, MAX_ATTACH_FILE_CHARS),
    };
  }
  return loadAttachment(workspace, extraRoots, source.mention);
}

function loadAttachment(workspace: string, extraRoots: string[], mention: AttachMention): LoadedAttachment {
  const display = displayPath(workspace, extraRoots, mention.path);
  let abs: string;
  try {
    abs = resolveInWorkspace(workspace, fileUriToLocalPath(mention.path), extraRoots);
  } catch (err) {
    const message = err instanceof WorkspaceError || err instanceof Error ? err.message : String(err);
    return { path: display, error: message };
  }
  try {
    const info = fs.statSync(abs);
    if (!info.isFile()) return { path: display, error: "not a file" };
    const rel = toWorkspacePath(workspace, abs, extraRoots);
    if (loadIgnoreMatcher(workspace).ignores(rel, false)) {
      return { path: rel, error: "ignored" };
    }
    if (info.size > MAX_TEXT_FILE_BYTES) {
      return { path: rel, error: `file too large (${info.size} bytes)` };
    }
    const raw = fs.readFileSync(abs);
    if (raw.includes(0)) return { path: rel, error: "binary file" };
    let text = raw.toString("utf8");
    if (mention.startLine !== undefined) {
      const lines = text.split("\n");
      const start = Math.max(mention.startLine - 1, 0);
      const end = mention.endLine !== undefined ? Math.min(mention.endLine, lines.length) : lines.length;
      text = lines.slice(start, Math.max(end, start + 1)).join("\n");
    }
    return {
      path: rel,
      content: truncate(text, MAX_ATTACH_FILE_CHARS),
      startLine: mention.startLine,
      endLine: mention.endLine,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { path: display, error: "not found" };
    return { path: display, error: err instanceof Error ? err.message : String(err) };
  }
}

function renderAttachment(file: LoadedAttachment): string {
  const range =
    file.startLine !== undefined
      ? ` startLine="${file.startLine}"${file.endLine !== undefined ? ` endLine="${file.endLine}"` : ""}`
      : "";
  if (file.error) {
    return `<file path="${escapeXml(file.path)}"${range} error="${escapeXml(file.error)}" />`;
  }
  return `<file path="${escapeXml(file.path)}"${range}>\n${file.content ?? ""}\n</file>`;
}

function parsePathToken(token: string): AttachMention | undefined {
  const range = token.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (range?.[1] && looksLikePath(range[1])) {
    return {
      path: range[1],
      startLine: Number(range[2]),
      endLine: range[3] ? Number(range[3]) : undefined,
    };
  }
  if (looksLikePath(token) || token.startsWith("/") || token.startsWith("file:")) {
    return { path: token };
  }
  return { path: token };
}

function looksLikePath(file: string): boolean {
  if (!file) return false;
  return file.includes("/") || file.includes("\\") || file.includes(".") || file.startsWith("./");
}

function mentionKey(mention: AttachMention): string {
  return `${mention.path}:${mention.startLine ?? ""}:${mention.endLine ?? ""}`;
}

function displayPath(workspace: string, extraRoots: string[], target: string): string {
  const local = fileUriToLocalPath(target);
  try {
    const abs = resolveInWorkspace(workspace, local, extraRoots);
    return toWorkspacePath(workspace, abs, extraRoots);
  } catch {
    return local.replaceAll("\\", "/");
  }
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
