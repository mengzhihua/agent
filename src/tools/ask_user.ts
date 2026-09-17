import type { AgentConfig } from "../types.js";
import { asString, type ToolHandler } from "./types.js";

export function askUserTool(_config: AgentConfig): ToolHandler {
  return {
    definition: {
      name: "ask_user",
      description:
        "Ask the human a question and wait. Use for missing credentials, ambiguous intent, or handing over a sensitive browser page.",
      risk: "read",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          choices: { type: "array", items: { type: "string" }, description: "Optional multiple-choice options." },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    execute: async (args, ctx) => {
      const question = asString(args, "question");
      const choices = Array.isArray(args.choices) ? args.choices.map((item) => String(item)) : undefined;
      if (!ctx.runtime?.askUser) {
        throw new Error(`No human is attached. Question was: ${question}`);
      }
      const answer = await ctx.runtime.askUser({ question, choices });
      return `User: ${answer}`;
    },
  };
}
