import type { ApprovalMode, ApprovalRequest, Approver, Risk, RunMode } from "../types.js";

export const TOOL_RISK: Record<string, Risk> = {
  read: "read",
  grep: "read",
  glob: "read",
  apply_patch: "write",
  shell: "exec",
  web_search: "network",
  skill: "read",
  update_plan: "read",
  task: "exec",
};

export function riskFor(tool: string): Risk {
  if (tool.startsWith("mcp__")) return "exec";
  return TOOL_RISK[tool] ?? "exec";
}

export function isMutatingTool(tool: string): boolean {
  if (tool === "update_plan" || tool === "skill") return false;
  const risk = riskFor(tool);
  return risk === "write" || risk === "exec";
}

export function defaultDecision(tool: string, mode: ApprovalMode): "allow" | "ask" {
  if (mode === "auto") return "allow";
  return riskFor(tool) === "read" ? "allow" : "ask";
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
  if (tool === "shell" && typeof record.command === "string") {
    return `shell: ${record.command}`;
  }
  if (tool === "apply_patch" && typeof record.path === "string") {
    return `apply_patch: ${record.path}`;
  }
  if (tool === "web_search" && typeof record.query === "string") {
    return `web_search: ${record.query}`;
  }
  if (tool === "task" && typeof record.prompt === "string") {
    return `task: ${record.prompt}`;
  }
  if (tool.startsWith("mcp__")) {
    return tool;
  }
  return `${tool} ${JSON.stringify(args)}`;
}

export async function decidePermission(
  tool: string,
  args: unknown,
  mode: ApprovalMode,
  approver: Approver,
  runMode: RunMode = "default",
): Promise<{ decision: "allow" | "deny"; summary: string }> {
  const summary = summarizeArgs(tool, args);
  if (runMode === "plan" && isMutatingTool(tool)) {
    return { decision: "deny", summary: `plan mode blocked ${summary}` };
  }
  if (defaultDecision(tool, mode) === "allow") {
    return { decision: "allow", summary };
  }
  const request: ApprovalRequest = {
    tool,
    risk: riskFor(tool),
    arguments: args,
    summary,
  };
  return { decision: await approver(request), summary };
}
