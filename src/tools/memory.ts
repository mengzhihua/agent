import type { AgentConfig } from "../types.js";
import { appendMemory, parseMemoryScope, readMemory, replaceMemory } from "../context/memory.js";
import { asOptionalString, asString, type ToolHandler } from "./types.js";

export function memoryTool(_config: AgentConfig): ToolHandler {
  return {
    definition: {
      name: "memory",
      description:
        "Read or update durable notes that persist across sessions. scope=user writes ~/.agent/MEMORY.md; scope=project writes .agent/MEMORY.md. Use for stable preferences and project facts. Do not store secrets.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "append", "replace"], description: "get reads, append adds a note, replace overwrites that scope." },
          scope: { type: "string", enum: ["user", "project"], description: "Default project. get without scope returns both." },
          text: { type: "string", description: "Note text for append or replace." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    execute: async (args, ctx) => {
      const action = asString(args, "action");
      const workspace = ctx.runtime?.workspace ?? ctx.config.workspace;
      const scopeRaw = asOptionalString(args, "scope");
      if (action === "get") {
        return readMemory(workspace, scopeRaw ? parseMemoryScope(scopeRaw) : undefined);
      }
      const scope = parseMemoryScope(scopeRaw);
      const text = asString(args, "text");
      if (action === "append") return appendMemory(workspace, scope, text);
      if (action === "replace") return replaceMemory(workspace, scope, text);
      throw new Error("usage: memory action is get|append|replace");
    },
  };
}
