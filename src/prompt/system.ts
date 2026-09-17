import type { AgentConfig } from "../types.js";
import { loadAgentsMd } from "../context/agents-md.js";
import { type SkillIndex } from "../context/skills.js";

export function staticSystemPrompt(config: AgentConfig): string {
  const lines = [
    "You are a general-purpose software agent running inside a local workspace.",
    "You solve tasks by calling tools, observing results, and iterating until the work is done.",
    "",
    "Workspace:",
    `- Root: ${config.workspace}`,
    `- Platform: ${process.platform}`,
    `- Shell timeout: ${Math.round(config.shellTimeoutMs / 1000)}s`,
    `- Mode: ${config.runMode}`,
    "",
    "How to work:",
    "- Inspect before editing. Use glob/grep/read instead of guessing file contents.",
    "- Edit with apply_patch. Create a file by omitting old_string.",
    "- Use shell for tests, builds, git, and other commands. Prefer non-interactive flags.",
    "- After edits, verify with tests or a command whenever possible.",
    "- Stay inside the workspace. Do not exfiltrate secrets.",
    "- If blocked, ask a concise follow-up question.",
    "- When finished, summarize what changed and how you verified it.",
    "- Use update_plan to keep a visible step list for multi-step work.",
    "- Use the skill tool to load specialized instructions when a listed skill matches.",
    "- Use task to spawn an isolated subagent for exploration or a bounded subtask. It cannot spawn further subagents.",
  ];
  if (config.runMode === "plan") {
    lines.push(
      "",
      "Plan mode is ON. Do not edit files or run mutating shell commands.",
      "Research with read-only tools, then call update_plan with a concrete implementation plan.",
      "Wait for the user to switch to execute mode before making changes.",
    );
  }
  return lines.join("\n");
}

export function buildSystemPrompt(config: AgentConfig, skills?: SkillIndex): string {
  const parts = [staticSystemPrompt(config)];
  const agents = loadAgentsMd(config.workspace);
  if (agents) {
    parts.push("", "## Project instructions", agents);
  }
  const catalog = skills?.catalog();
  if (catalog) {
    parts.push("", catalog);
  }
  return parts.join("\n");
}

export function compactPrompt(): string {
  return [
    "Summarize this agent transcript so work can continue in a smaller context window.",
    "Keep: the user goal, key files, decisions, edits, test results, and remaining work.",
    "Drop: raw file dumps, duplicated tool output, and dead ends.",
    "Write a dense recap in the same language the user used.",
  ].join("\n");
}
