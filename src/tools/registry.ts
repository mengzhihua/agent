import { SkillIndex } from "../context/skills.js";
import type { AgentConfig, ToolDefinition } from "../types.js";
import { applyPatchDefinition, applyPatchTool } from "./apply_patch.js";
import { skillTool, taskTool, updatePlanTool, type TaskArgs } from "./extra.js";
import { globDefinition, globTool } from "./glob.js";
import { grepDefinition, grepTool } from "./grep.js";
import { readDefinition, readFileTool } from "./read.js";
import { shellDefinition, shellTool } from "./shell.js";
import { asOptionalNumber, asString, type ToolContext, type ToolHandler } from "./types.js";
import { webSearchDefinition, webSearchTool } from "./web_search.js";

export interface RegistryOptions {
  skills?: SkillIndex;
  extraHandlers?: ToolHandler[];
  allowTask?: boolean;
  readOnly?: boolean;
  runSubagent?: (input: TaskArgs, signal: AbortSignal) => Promise<string>;
}

export function createBuiltinTools(config: AgentConfig, options: RegistryOptions = {}): ToolHandler[] {
  const skills = options.skills ?? new SkillIndex([]);
  const handlers: ToolHandler[] = [
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
    skillTool(config, skills),
    updatePlanTool(config),
  ];

  if (options.allowTask !== false) {
    handlers.push(taskTool(config, options.runSubagent));
  }

  if (options.readOnly) {
    const allowed = new Set(["read", "grep", "glob", "skill", "update_plan"]);
    return handlers.filter((handler) => allowed.has(handler.definition.name));
  }
  return handlers;
}

export class ToolRegistry {
  private readonly byName: Map<string, ToolHandler>;

  constructor(handlers: ToolHandler[]) {
    this.byName = new Map(handlers.map((handler) => [handler.definition.name, handler]));
  }

  definitions(): ToolDefinition[] {
    return [...this.byName.values()].map((handler) => handler.definition);
  }

  names(): string[] {
    return this.definitions().map((definition) => definition.name);
  }

  get(name: string): ToolHandler | undefined {
    return this.byName.get(name);
  }

  static create(config: AgentConfig, options: RegistryOptions = {}): ToolRegistry {
    const extra = [...(options.extraHandlers ?? [])].sort((a, b) =>
      a.definition.name.localeCompare(b.definition.name),
    );
    return new ToolRegistry([...createBuiltinTools(config, options), ...extra]);
  }

  static builtin(config: AgentConfig): ToolRegistry {
    return ToolRegistry.create(config);
  }
}

export type { TaskArgs, ToolContext, ToolHandler };
