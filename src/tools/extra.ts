import type { AgentConfig, PlanStep } from "../types.js";
import { asString, type ToolHandler } from "./types.js";
import type { SkillIndex } from "../context/skills.js";

export function skillTool(_config: AgentConfig, skills: SkillIndex): ToolHandler {
  return {
    definition: {
      name: "skill",
      description: `Load a skill's SKILL.md instructions. Available: ${skills.all().map((s) => s.name).join(", ") || "(none)"}.`,
      risk: "read",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name from the catalog." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const name = asString(args, "name");
      return skills.body(name);
    },
  };
}

export function updatePlanTool(_config: AgentConfig): ToolHandler {
  return {
    definition: {
      name: "update_plan",
      description: "Create or update the visible task plan. Use in plan mode before any implementation, and keep it current while executing.",
      risk: "read",
      parameters: {
        type: "object",
        properties: {
          explanation: { type: "string", description: "Short rationale for this plan revision." },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["title", "status"],
            },
          },
        },
        required: ["steps"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const steps = parseSteps(args.steps);
      const explanation = typeof args.explanation === "string" ? args.explanation : "";
      const lines = steps.map((step) => `- [${step.status}] ${step.title}`);
      return ["Plan updated.", explanation, ...lines].filter(Boolean).join("\n");
    },
  };
}

export interface TaskArgs {
  prompt: string;
  subagent_type?: "explore" | "general";
  label?: string;
}

export function taskTool(
  _config: AgentConfig,
  runSubagent?: (input: TaskArgs, signal: AbortSignal) => Promise<string>,
): ToolHandler {
  return {
    definition: {
      name: "task",
      description:
        "Spawn an isolated subagent with its own context. Use explore for read-only codebase reconnaissance. Returns only a summary.",
      risk: "exec",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task for the subagent." },
          subagent_type: {
            type: "string",
            enum: ["explore", "general"],
            description: "explore is read-only. general can edit. Default general.",
          },
          label: { type: "string", description: "Short label for logs." },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    execute: async (args, ctx) => {
      if (!runSubagent) throw new Error("subagents are not available in this session");
      const prompt = asString(args, "prompt");
      const subagent_type = args.subagent_type === "explore" ? "explore" : "general";
      const label = typeof args.label === "string" ? args.label : subagent_type;
      return runSubagent({ prompt, subagent_type, label }, ctx.signal);
    },
  };
}

export function parseSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) throw new Error("steps must be an array");
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid plan step");
    const row = item as Record<string, unknown>;
    if (typeof row.title !== "string") throw new Error("step.title required");
    const status = row.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new Error("step.status must be pending | in_progress | completed");
    }
    return { title: row.title, status };
  });
}
