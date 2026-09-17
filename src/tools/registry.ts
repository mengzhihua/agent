import type { AgentConfig, ToolDefinition } from "../types.js";
import { applyPatchDefinition, applyPatchTool } from "./apply_patch.js";
import { globDefinition, globTool } from "./glob.js";
import { grepDefinition, grepTool } from "./grep.js";
import { readDefinition, readFileTool } from "./read.js";
import { shellDefinition, shellTool } from "./shell.js";
import { asOptionalNumber, asString, type ToolContext, type ToolHandler } from "./types.js";
import { webSearchDefinition, webSearchTool } from "./web_search.js";

export function createBuiltinTools(config: AgentConfig): ToolHandler[] {
  return [
    {
      definition: readDefinition(config),
      execute: async (args, _ctx) =>
        readFileTool(config.workspace, asString(args, "path"), asOptionalNumber(args, "offset"), asOptionalNumber(args, "limit")),
    },
    {
      definition: grepDefinition(config),
      execute: async (args, ctx) =>
        grepTool(
          config.workspace,
          asString(args, "pattern"),
          typeof args.path === "string" ? args.path : undefined,
          typeof args.glob === "string" ? args.glob : undefined,
          asOptionalNumber(args, "max_matches") ?? 50,
          ctx.signal,
        ),
    },
    {
      definition: globDefinition(config),
      execute: async (args, _ctx) =>
        globTool(config.workspace, asString(args, "pattern"), typeof args.path === "string" ? args.path : undefined),
    },
    {
      definition: applyPatchDefinition(config),
      execute: async (args, _ctx) => applyPatchTool(config.workspace, asString(args, "path"), args),
    },
    {
      definition: shellDefinition(config),
      execute: async (args, ctx) =>
        shellTool(
          config,
          asString(args, "command"),
          typeof args.cwd === "string" ? args.cwd : undefined,
          asOptionalNumber(args, "timeout_ms"),
          ctx.signal,
        ),
    },
    {
      definition: webSearchDefinition(config),
      execute: async (args, ctx) =>
        webSearchTool(asString(args, "query"), asOptionalNumber(args, "count") ?? 5, ctx.signal),
    },
  ];
}

export class ToolRegistry {
  private readonly byName: Map<string, ToolHandler>;

  constructor(handlers: ToolHandler[]) {
    this.byName = new Map(handlers.map((handler) => [handler.definition.name, handler]));
  }

  definitions(): ToolDefinition[] {
    return [...this.byName.values()].map((handler) => handler.definition);
  }

  get(name: string): ToolHandler | undefined {
    return this.byName.get(name);
  }

  static builtin(config: AgentConfig): ToolRegistry {
    return new ToolRegistry(createBuiltinTools(config));
  }
}

export type { ToolContext, ToolHandler };
