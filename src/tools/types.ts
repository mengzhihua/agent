import type { AgentConfig, ToolDefinition, ToolResult } from "../types.js";
import type { SessionRuntime } from "../runtime.js";

export interface ToolContext {
  config: AgentConfig;
  signal: AbortSignal;
  runtime?: SessionRuntime;
  callId?: string;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
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

export async function runTool(
  handler: ToolHandler,
  args: unknown,
  ctx: ToolContext,
): Promise<Omit<ToolResult, "callId">> {
  try {
    const content = await handler.execute(asRecord(args), ctx);
    return { name: handler.definition.name, content };
  } catch (err) {
    return { name: handler.definition.name, content: toolError(err), isError: true };
  }
}
