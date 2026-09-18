import fs from "node:fs";
import path from "node:path";

export interface InitResult {
  workspace: string;
  created: string[];
  skipped: string[];
}

const AGENTS_TEMPLATE = `# AGENTS.md

Project instructions for the agent. Keep this short.

- How to install, build, and test
- Paths and commands that matter
- Things not to change
`;

const MCP_TEMPLATE = `{
  "mcpServers": {}
}
`;

const HOOKS_TEMPLATE = `{
  "PreToolUse": [],
  "PostToolUse": [],
  "Stop": []
}
`;

const AGENTIGNORE_TEMPLATE = `# Extra ignore patterns for grep/glob (gitignore syntax).
# .gitignore is also respected.
`;

export function initWorkspace(workspace: string): InitResult {
  const root = path.resolve(workspace);
  fs.mkdirSync(path.join(root, ".agent", "skills"), { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  writeIfMissing(root, "AGENTS.md", AGENTS_TEMPLATE, created, skipped);
  writeIfMissing(root, ".agentignore", AGENTIGNORE_TEMPLATE, created, skipped);
  writeIfMissing(root, ".agent/mcp.json", MCP_TEMPLATE, created, skipped);
  writeIfMissing(root, ".agent/hooks.json", HOOKS_TEMPLATE, created, skipped);
  return { workspace: root, created, skipped };
}

export function formatInitResult(result: InitResult): string {
  const lines = [`Initialized ${result.workspace}`];
  if (result.created.length) lines.push(`created: ${result.created.join(", ")}`);
  if (result.skipped.length) lines.push(`exists: ${result.skipped.join(", ")}`);
  return lines.join("\n");
}

function writeIfMissing(
  root: string,
  rel: string,
  body: string,
  created: string[],
  skipped: string[],
): void {
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) {
    skipped.push(rel);
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  created.push(rel);
}
