import { SkillIndex } from "../context/skills.js";
import type { AgentConfig, ToolDefinition, ToolLocation } from "../types.js";
import { resolveInWorkspace } from "../workspace.js";
import { applyPatchDefinition, applyPatchTool } from "./apply_patch.js";
import { artifactTool } from "./artifact.js";
import { askUserTool } from "./ask_user.js";
import { browserTool } from "./browser.js";
import { skillTool, taskTool, updatePlanTool, type TaskArgs } from "./extra.js";
import { globDefinition, globTool } from "./glob.js";
import { grepDefinition, grepTool } from "./grep.js";
import { memoryTool } from "./memory.js";
import { readDefinition, readFileTool } from "./read.js";
import { shellDefinition, shellTool } from "./shell.js";
import { asOptionalNumber, asString, type ToolContext, type ToolExecuteResult, type ToolHandler } from "./types.js";
import { webFetchHandler } from "./web_fetch.js";
import { webSearchDefinition, webSearchTool } from "./web_search.js";

function workspaceOf(ctx: ToolContext): string {
  return ctx.runtime?.workspace ?? ctx.config.workspace;
}

function extraRootsOf(ctx: ToolContext): string[] {
  return ctx.runtime?.extraRoots ?? [];
}

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
      execute: async (args, ctx) => {
        const rel = asString(args, "path");
        const offset = asOptionalNumber(args, "offset");
        const content = await readFileTool(
          workspaceOf(ctx),
          rel,
          offset,
          asOptionalNumber(args, "limit"),
          ctx.runtime?.files,
          extraRootsOf(ctx),
        );
        const loc: ToolLocation = { path: resolveInWorkspace(workspaceOf(ctx), rel, extraRootsOf(ctx)) };
        if (offset !== undefined) loc.line = offset;
        return { content, locations: [loc] } satisfies ToolExecuteResult;
      },
    },
    {
      definition: grepDefinition(config),
      execute: async (args, ctx) =>
        grepTool(
          workspaceOf(ctx),
          asString(args, "pattern"),
          typeof args.path === "string" ? args.path : undefined,
          typeof args.glob === "string" ? args.glob : undefined,
          asOptionalNumber(args, "max_matches") ?? 50,
          ctx.signal,
          extraRootsOf(ctx),
        ),
    },
    {
      definition: globDefinition(config),
      execute: async (args, ctx) =>
        globTool(
          workspaceOf(ctx),
          asString(args, "pattern"),
          typeof args.path === "string" ? args.path : undefined,
          extraRootsOf(ctx),
          ctx.signal,
        ),
    },
    {
      definition: applyPatchDefinition(config),
      execute: async (args, ctx) => {
        const result = await applyPatchTool(
          workspaceOf(ctx),
          asString(args, "path"),
          args,
          ctx.runtime?.files,
          extraRootsOf(ctx),
        );
        return {
          content: result.summary,
          locations: [{ path: result.absPath }],
          diff: { path: result.absPath, oldText: result.oldText, newText: result.newText },
        } satisfies ToolExecuteResult;
      },
    },
    {
      definition: shellDefinition(config),
      execute: async (args, ctx) =>
        shellTool(
          { ...ctx.config, workspace: workspaceOf(ctx) },
          asString(args, "command"),
          typeof args.cwd === "string" ? args.cwd : undefined,
          asOptionalNumber(args, "timeout_ms"),
          ctx.signal,
          {
            terminal: ctx.runtime?.terminal,
            onTerminal:
              ctx.runtime?.onTerminal && ctx.callId
                ? (terminalId) => ctx.runtime!.onTerminal!(ctx.callId!, terminalId)
                : undefined,
            extraRoots: extraRootsOf(ctx),
          },
        ),
    },
    {
      definition: webSearchDefinition(config),
      execute: async (args, ctx) =>
        webSearchTool(asString(args, "query"), asOptionalNumber(args, "count") ?? 5, ctx.signal),
    },
    webFetchHandler(config),
    browserTool(config),
    artifactTool(config),
    askUserTool(config),
    memoryTool(config),
    skillTool(config, skills),
    updatePlanTool(config),
  ];

  if (options.allowTask !== false) {
    handlers.push(taskTool(config, options.runSubagent));
  }

  if (options.readOnly) {
    const allowed = new Set(["read", "grep", "glob", "skill", "update_plan", "web_search", "web_fetch", "ask_user"]);
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
