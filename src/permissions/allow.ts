import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AllowRule {
  tool: string;
  /** Shell command prefix. Omitted means any arguments for this tool. */
  command?: string;
}

export function permissionsPath(home = process.env.AGENT_HOME ?? path.join(os.homedir(), ".agent")): string {
  return path.join(home, "permissions.json");
}

export function ruleForCall(tool: string, args: unknown): AllowRule {
  if (tool === "shell") {
    const command = shellCommand(args);
    return command ? { tool, command } : { tool };
  }
  return { tool };
}

export function matchesRule(rule: AllowRule, tool: string, args: unknown): boolean {
  if (rule.tool !== tool) return false;
  if (!rule.command) return true;
  const command = shellCommand(args);
  if (!command) return false;
  return command === rule.command || command.startsWith(`${rule.command} `);
}

export function sameRule(a: AllowRule, b: AllowRule): boolean {
  return a.tool === b.tool && (a.command ?? "") === (b.command ?? "");
}

export class PermissionMemory {
  constructor(
    public persisted: AllowRule[] = [],
    public session: AllowRule[] = [],
    private readonly file?: string,
  ) {}

  static load(home?: string): PermissionMemory {
    const file = permissionsPath(home);
    return new PermissionMemory(readAllowRules(file), [], file);
  }

  static empty(file?: string): PermissionMemory {
    return new PermissionMemory([], [], file);
  }

  allows(tool: string, args: unknown): boolean {
    return [...this.persisted, ...this.session].some((rule) => matchesRule(rule, tool, args));
  }

  remember(rule: AllowRule, persist: boolean): void {
    const list = persist ? this.persisted : this.session;
    if (!list.some((existing) => sameRule(existing, rule))) list.push(rule);
    if (persist && this.file) writeAllowRules(this.file, this.persisted);
  }

  clearPersisted(): void {
    this.persisted = [];
    if (this.file) writeAllowRules(this.file, []);
  }
}

export function formatAllowRule(rule: AllowRule): string {
  return rule.command ? `${rule.tool}  ${rule.command}` : rule.tool;
}

export function formatAllowList(rules: AllowRule[], format: "text" | "json", file?: string): string {
  if (format === "json") return JSON.stringify({ path: file, allow: rules });
  if (rules.length === 0) return file ? `(no persisted allows)\n${file}` : "(no persisted allows)";
  const lines = rules.map(formatAllowRule);
  if (file) lines.push(file);
  return lines.join("\n");
}

export function readAllowRules(file: string): AllowRule[] {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { allow?: unknown };
    return parseAllowRules(raw.allow);
  } catch {
    return [];
  }
}

export function writeAllowRules(file: string, rules: AllowRule[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ allow: rules }, null, 2)}\n`, "utf8");
}

export function parseAllowRules(raw: unknown): AllowRule[] {
  if (!Array.isArray(raw)) return [];
  const out: AllowRule[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const tool = typeof (row as { tool?: unknown }).tool === "string" ? (row as { tool: string }).tool.trim() : "";
    if (!tool) continue;
    const command =
      typeof (row as { command?: unknown }).command === "string"
        ? (row as { command: string }).command.trim()
        : undefined;
    out.push(command ? { tool, command } : { tool });
  }
  return out;
}

function shellCommand(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" && command.trim() ? command.trim() : undefined;
}
