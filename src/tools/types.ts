import type { AgentConfig, ToolCall, ToolDefinition, ToolDiff, ToolLocation, ToolResult } from "../types.js";
import type { SessionRuntime } from "../runtime.js";
import { resolveInWorkspace } from "../workspace.js";

export interface ToolContext {
  config: AgentConfig;
  signal: AbortSignal;
  runtime?: SessionRuntime;
  callId?: string;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolExecuteResult>;
}

export interface ToolExecuteResult {
  content: string;
  locations?: ToolLocation[];
  diff?: ToolDiff;
}

export function asRecord(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("tool arguments must be an object");
  }
  return args as Record<string, unknown>;
}

export function asString(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (fallback !== undefined && value === undefined) return fallback;
  throw new Error(`expected string argument: ${key}`);
}

export function asOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`expected string argument: ${key}`);
}

export function asOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`expected number argument: ${key}`);
}

export function toolError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function locationsFromToolArgs(
  name: string,
  args: unknown,
  workspace?: string,
  extraRoots: string[] = [],
): ToolLocation[] | undefined {
  if (name !== "read" && name !== "apply_patch") return undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rel = (args as Record<string, unknown>).path;
  if (typeof rel !== "string" || rel.length === 0) return undefined;
  let filePath = rel;
  if (workspace) {
    try {
      filePath = resolveInWorkspace(workspace, rel, extraRoots);
    } catch {
      // keep the path as given when it is not yet resolvable
    }
  }
  const loc: ToolLocation = { path: filePath };
  if (name === "read") {
    const offset = (args as Record<string, unknown>).offset;
    if (typeof offset === "number" && Number.isFinite(offset) && offset >= 1) {
      loc.line = Math.trunc(offset);
    }
  }
  return [loc];
}

export function startLocationsForCall(
  call: ToolCall,
  workspace: string,
  extraRoots: string[] = [],
): ToolLocation[] | undefined {
  return locationsFromToolArgs(call.name, call.arguments, workspace, extraRoots);
}

export async function runTool(
  handler: ToolHandler,
  args: unknown,
  ctx: ToolContext,
): Promise<Omit<ToolResult, "callId">> {
  try {
    const raw = await handler.execute(asRecord(args), ctx);
    if (typeof raw === "string") return { name: handler.definition.name, content: raw };
    return {
      name: handler.definition.name,
      content: raw.content,
      locations: raw.locations,
      diff: raw.diff,
    };
  } catch (err) {
    return { name: handler.definition.name, content: toolError(err), isError: true };
  }
}
