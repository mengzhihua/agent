import type { ApprovalMode, ApprovalRequest, Approver, Risk } from "../types.js";

export const TOOL_RISK: Record<string, Risk> = {
  read: "read",
  grep: "read",
  glob: "read",
  apply_patch: "write",
  shell: "exec",
  web_search: "network",
};

export function riskFor(tool: string): Risk {
  return TOOL_RISK[tool] ?? "exec";
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
  return `${tool} ${JSON.stringify(args)}`;
}

export async function decidePermission(
  tool: string,
  args: unknown,
  mode: ApprovalMode,
  approver: Approver,
): Promise<{ decision: "allow" | "deny"; summary: string }> {
  const summary = summarizeArgs(tool, args);
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
