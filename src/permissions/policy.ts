import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  Approver,
  Risk,
  RunMode,
  SandboxBackend,
} from "../types.js";
import { PermissionMemory, ruleForCall } from "./allow.js";

export const TOOL_RISK: Record<string, Risk> = {
  read: "read",
  grep: "read",
  glob: "read",
  apply_patch: "write",
  shell: "exec",
  web_search: "network",
  web_fetch: "network",
  browser: "exec",
  artifact: "write",
  ask_user: "read",
  memory: "write",
  skill: "read",
  update_plan: "read",
  task: "exec",
};

export function riskFor(tool: string, args?: unknown): Risk {
  const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
  const action = record?.action;
  if (tool === "web_fetch") {
    return record?.save === true ? "write" : "network";
  }
  if (tool === "ask_user") return "read";
  if (tool === "artifact") {
    return action === "list" || action === "get" ? "read" : "write";
  }
  if (tool === "memory") {
    return action === "get" || action === undefined ? "read" : "write";
  }
  if (tool === "browser") {
    if (action === "open" || action === "snapshot" || action === "screenshot" || action === "close") {
      return "network";
    }
    return "exec";
  }
  if (tool.startsWith("mcp__")) return "exec";
  return TOOL_RISK[tool] ?? "exec";
}

export function isMutatingTool(tool: string, args?: unknown): boolean {
  if (tool === "update_plan" || tool === "skill" || tool === "ask_user") return false;
  const risk = riskFor(tool, args);
  return risk === "write" || risk === "exec";
}

const CONFINED_AUTO = new Set(["apply_patch", "shell", "artifact"]);

export function parseApprovalMode(raw: string | undefined): ApprovalMode | undefined {
  const value = raw?.trim();
  if (value === "ask" || value === "auto" || value === "edits") return value;
  if (value === "acceptEdits" || value === "accept-edits") return "edits";
  return undefined;
}

export function defaultDecision(
  tool: string,
  mode: ApprovalMode,
  args?: unknown,
  sandbox: SandboxBackend = "none",
): "allow" | "ask" {
  if (mode === "auto") return "allow";
  if (riskFor(tool, args) === "read") return "allow";
  if (mode === "edits" && riskFor(tool, args) === "write") return "allow";
  if (sandbox !== "none" && CONFINED_AUTO.has(tool)) return "allow";
  return "ask";
}

export function autoApprover(): Approver {
  return async () => "allow";
}

export function denyApprover(): Approver {
  return async () => "deny";
}

export function summarizeArgs(tool: string, args: unknown): string {
  if (!args || typeof args !== "object") return `${tool} ${JSON.stringify(args)}`;
  const record = args as Record<string, unknown>;
  if (tool === "shell" && typeof record.command === "string") return `shell: ${record.command}`;
  if (tool === "apply_patch" && typeof record.path === "string") return `apply_patch: ${record.path}`;
  if (tool === "web_search" && typeof record.query === "string") return `web_search: ${record.query}`;
  if (tool === "task" && typeof record.prompt === "string") return `task: ${record.prompt}`;
  if (tool === "browser" && typeof record.action === "string") {
    return `browser ${record.action}${typeof record.url === "string" ? `: ${record.url}` : ""}`;
  }
  if (tool === "web_fetch" && typeof record.url === "string") return `web_fetch: ${record.url}`;
  if (tool === "artifact") return `artifact ${typeof record.action === "string" ? record.action : ""}`.trim();
  if (tool === "ask_user" && typeof record.question === "string") return `ask_user: ${record.question}`;
  if (tool === "memory") {
    const action = typeof record.action === "string" ? record.action : "memory";
    const scope = typeof record.scope === "string" ? record.scope : "";
    return `memory ${action}${scope ? ` ${scope}` : ""}`.trim();
  }
  if (tool.startsWith("mcp__")) return tool;
  return `${tool} ${JSON.stringify(args)}`;
}

export async function decidePermission(
  tool: string,
  args: unknown,
  mode: ApprovalMode,
  approver: Approver,
  runMode: RunMode = "default",
  sandbox: SandboxBackend = "none",
  callId?: string,
  memory?: PermissionMemory,
): Promise<{ decision: "allow" | "deny"; summary: string }> {
  const summary = summarizeArgs(tool, args);
  if (runMode === "plan" && isMutatingTool(tool, args)) {
    return { decision: "deny", summary: `plan mode blocked ${summary}` };
  }
  if (memory?.allows(tool, args)) return { decision: "allow", summary };
  if (defaultDecision(tool, mode, args, sandbox) === "allow") return { decision: "allow", summary };
  const answer = await approver({ tool, risk: riskFor(tool, args), arguments: args, summary, callId } satisfies ApprovalRequest);
  if (answer === "always" || answer === "session") {
    memory?.remember(ruleForCall(tool, args), answer === "always");
    return { decision: "allow", summary };
  }
  return { decision: answer, summary };
}

export function parseApprovalAnswer(raw: string): ApprovalDecision {
  const value = raw.trim().toLowerCase();
  if (value === "y" || value === "yes") return "allow";
  if (value === "a" || value === "always") return "always";
  if (value === "s" || value === "session") return "session";
  return "deny";
}
