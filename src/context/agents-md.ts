import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentHome } from "../config.js";
import { truncate } from "../workspace.js";

const MAX_CHARS = 32 * 1024;

function readIfExists(file: string): string | undefined {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return undefined;
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

export function parentAgentFiles(workspace: string, limit = 8): { dir: string; text: string }[] {
  const found: { dir: string; text: string }[] = [];
  let dir = path.resolve(workspace);
  const home = path.resolve(os.homedir());
  const root = path.parse(dir).root;
  for (let i = 0; i < limit; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const text = readIfExists(path.join(dir, "AGENTS.md"));
    if (text) found.push({ dir, text });
    if (dir === home || dir === root) break;
  }
  return found.reverse();
}

export function loadAgentsMd(workspace: string): string {
  const chunks: string[] = [];
  const user = readIfExists(path.join(agentHome(), "AGENTS.md"));
  if (user) chunks.push(`# User AGENTS.md\n${user}`);
  for (const parent of parentAgentFiles(workspace)) {
    chunks.push(`# Parent AGENTS.md (${parent.dir})\n${parent.text}`);
  }
  const project = readIfExists(path.join(workspace, "AGENTS.md"));
  if (project) chunks.push(`# Project AGENTS.md\n${project}`);
  const override = readIfExists(path.join(workspace, "AGENTS.override.md"));
  if (override) chunks.push(`# AGENTS.override.md\n${override}`);
  if (chunks.length === 0) return "";
  return truncate(chunks.join("\n\n"), MAX_CHARS);
}
