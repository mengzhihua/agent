export type Risk = "read" | "write" | "exec" | "network";

export type ApprovalMode = "ask" | "auto";

export type ProviderName = "openai" | "anthropic" | "scripted";

export type RunMode = "default" | "plan";

export type SandboxMode = "auto" | "none";

export type SandboxBackend = "bwrap" | "none";

export type BrowserMode = "auto" | "html" | "chrome";

export type BrowserBackend = "html" | "chrome";

export interface PlanStep {
  title: string;
  status: "pending" | "in_progress" | "completed";
}

export interface AgentConfig {
  workspace: string;
  model: string;
  provider: ProviderName;
  approvalMode: ApprovalMode;
  runMode: RunMode;
  compactTokens: number;
  maxToolIterations: number;
  sessionDir: string;
  shellTimeoutMs: number;
  shellOutputLimit: number;
  subagentDepth: number;
  artifactsDir: string;
  sandbox: SandboxMode;
  sandboxBackend: SandboxBackend;
  browser: BrowserMode;
  browserBackend: BrowserBackend;
}

export interface Artifact {
  id: string;
  title: string;
  kind: "file" | "page" | "screenshot" | "download" | "report";
  path: string;
  createdAt: string;
}

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  risk: Risk;
  parameters: ToolParameterSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
  locations?: ToolLocation[];
  diff?: ToolDiff;
}

export interface ToolLocation {
  path: string;
  line?: number;
}

export interface ToolDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type CompletionEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done" };

export interface CompletionRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
}

export interface Provider {
  readonly name: string;
  complete(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CompletionEvent>;
}

export type ApprovalRequest = {
  tool: string;
  risk: Risk;
  arguments: unknown;
  summary: string;
  callId?: string;
};

export type Approver = (request: ApprovalRequest) => Promise<"allow" | "deny">;

export type SessionEvent =
  | {
      type: "session_meta";
      id: string;
      timestamp: string;
      cwd: string;
      model: string;
      provider: string;
    }
  | { type: "user"; id: string; timestamp: string; text: string }
  | { type: "assistant"; id: string; timestamp: string; text: string }
  | {
      type: "tool_call";
      id: string;
      timestamp: string;
      callId: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "tool_result";
      id: string;
      timestamp: string;
      callId: string;
      name: string;
      content: string;
      isError?: boolean;
    }
  | { type: "compact"; id: string; timestamp: string; summary: string }
  | {
      type: "plan";
      id: string;
      timestamp: string;
      steps: PlanStep[];
      explanation?: string;
    }
  | {
      type: "artifact";
      id: string;
      timestamp: string;
      artifact: Artifact;
    };

export type LoopEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; callId: string; name: string; arguments: unknown; locations?: ToolLocation[] }
  | {
      type: "tool-end";
      callId: string;
      name: string;
      content: string;
      isError?: boolean;
      locations?: ToolLocation[];
      diff?: ToolDiff;
    }
  | { type: "permission"; tool: string; decision: "allow" | "deny"; summary: string }
  | { type: "compact-start" }
  | { type: "compact-end"; summary: string }
  | { type: "plan"; steps: PlanStep[]; explanation?: string }
  | { type: "hook"; hook: string; tool?: string; message: string }
  | { type: "subagent-start"; label: string }
  | { type: "subagent-end"; label: string }
  | { type: "artifact"; artifact: Artifact }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn-end"; text: string }
  | { type: "aborted" }
  | { type: "error"; message: string };
