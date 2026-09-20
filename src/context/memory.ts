import fs from "node:fs";
import path from "node:path";
import { agentHome } from "../config.js";
import { ensureDir, truncate } from "../workspace.js";

export const MAX_MEMORY_CHARS = 8 * 1024;

export type MemoryScope = "user" | "project";

export interface MemoryFiles {
  userPath: string;
  projectPath: string;
  user: string;
  project: string;
}

export function userMemoryPath(home = agentHome()): string {
  return path.join(home, "MEMORY.md");
}

export function projectMemoryPath(workspace: string): string {
  return path.join(path.resolve(workspace), ".agent", "MEMORY.md");
}

export function loadMemory(workspace: string): MemoryFiles {
  const userPath = userMemoryPath();
  const projectPath = projectMemoryPath(workspace);
  return {
    userPath,
    projectPath,
    user: readMemoryFile(userPath),
    project: readMemoryFile(projectPath),
  };
}

export function formatMemoryPrompt(workspace: string): string {
  const files = loadMemory(workspace);
  const user = files.user.trim();
  const project = files.project.trim();
  if (!user && !project) return "";
  const parts = [
    "## Memory",
    "Durable notes across sessions. Update them with the memory tool when the user asks to remember something, or when you learn a stable preference or project fact. Do not store secrets.",
  ];
  if (user) parts.push("", "### User", truncate(user, MAX_MEMORY_CHARS));
  if (project) parts.push("", "### Project", truncate(project, MAX_MEMORY_CHARS));
  return parts.join("\n");
}

export function formatMemoryShow(files: MemoryFiles, format: "text" | "json"): string {
  if (format === "json") {
    return JSON.stringify({
      type: "memory",
      user: { path: files.userPath, text: files.user },
      project: { path: files.projectPath, text: files.project },
    });
  }
  const blocks = [
    `user  ${files.userPath}`,
    files.user || "(empty)",
    "",
    `project  ${files.projectPath}`,
    files.project || "(empty)",
  ];
  return blocks.join("\n");
}

export function readMemory(workspace: string, scope?: MemoryScope): string {
  const files = loadMemory(workspace);
  if (scope === "user") return files.user || "(empty)";
  if (scope === "project") return files.project || "(empty)";
  return formatMemoryShow(files, "text");
}

export function appendMemory(workspace: string, scope: MemoryScope, text: string): string {
  const note = normalizeNote(text);
  const file = memoryFile(workspace, scope);
  const current = readMemoryFile(file);
  if (current && current.includes(note)) {
    return `Already in ${scope} memory (${file}).`;
  }
  const next = current ? `${current}\n\n${note}` : note;
  writeMemoryFile(file, next, scope);
  return `Appended to ${scope} memory (${file}).`;
}

export function replaceMemory(workspace: string, scope: MemoryScope, text: string): string {
  const note = normalizeNote(text);
  const file = memoryFile(workspace, scope);
  writeMemoryFile(file, note, scope);
  return `Replaced ${scope} memory (${file}).`;
}

export function parseMemoryScope(raw?: string): MemoryScope {
  const name = (raw ?? "project").trim().toLowerCase();
  if (name === "user" || name === "project") return name;
  throw new Error("usage: memory scope is user|project");
}

function memoryFile(workspace: string, scope: MemoryScope): string {
  return scope === "user" ? userMemoryPath() : projectMemoryPath(workspace);
}

function readMemoryFile(file: string): string {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return "";
    return fs.readFileSync(file, "utf8").replace(/\s+$/, "");
  } catch {
    return "";
  }
}

function writeMemoryFile(file: string, text: string, scope: MemoryScope): void {
  ensureDir(path.dirname(file));
  const body = text.endsWith("\n") ? text : `${text}\n`;
  fs.writeFileSync(file, truncate(body, MAX_MEMORY_CHARS * 2), { encoding: "utf8", mode: scope === "user" ? 0o600 : 0o644 });
}

function normalizeNote(text: string): string {
  const note = text.trim();
  if (!note) throw new Error("memory text is required");
  return note;
}
