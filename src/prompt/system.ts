import type { AgentConfig, ToolDefinition } from "../types.js";

export function buildSystemPrompt(config: AgentConfig): string {
  return [
    "You are a general-purpose software agent running inside a local workspace.",
    "You solve tasks by calling tools, observing results, and iterating until the work is done.",
    "",
    "Workspace:",
    `- Root: ${config.workspace}`,
    `- Platform: ${process.platform}`,
    `- Shell timeout: ${Math.round(config.shellTimeoutMs / 1000)}s`,
    "",
    "How to work:",
    "- Inspect before editing. Use glob/grep/read instead of guessing file contents.",
    "- Edit with apply_patch. Create a file by omitting old_string.",
    "- Use shell for tests, builds, git, and other commands. Prefer non-interactive flags.",
    "- After edits, verify with tests or a command whenever possible.",
    "- Stay inside the workspace. Do not exfiltrate secrets.",
    "- If blocked, ask a concise follow-up question.",
    "- When finished, summarize what changed and how you verified it.",
  ].join("\n");
}

export function compactPrompt(): string {
  return [
    "Summarize this agent transcript so work can continue in a smaller context window.",
    "Keep: the user goal, key files, decisions, edits, test results, and remaining work.",
    "Drop: raw file dumps, duplicated tool output, and dead ends.",
    "Write a dense recap in the same language the user used.",
  ].join("\n");
}
