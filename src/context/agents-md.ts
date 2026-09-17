import fs from "node:fs";
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

export function loadAgentsMd(workspace: string): string {
  const chunks: string[] = [];
  const user = readIfExists(path.join(agentHome(), "AGENTS.md"));
  if (user) chunks.push(`# User AGENTS.md\n${user}`);
  const project = readIfExists(path.join(workspace, "AGENTS.md"));
  if (project) chunks.push(`# Project AGENTS.md\n${project}`);
  const override = readIfExists(path.join(workspace, "AGENTS.override.md"));
  if (override) chunks.push(`# AGENTS.override.md\n${override}`);
  if (chunks.length === 0) return "";
  return truncate(chunks.join("\n\n"), MAX_CHARS);
}
