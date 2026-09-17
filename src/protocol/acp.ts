import path from "node:path";
import { stdin, stdout, stderr } from "node:process";
import type { AgentHost } from "../host.js";
import type { ApprovalRequest, LoopEvent, Risk, RunMode } from "../types.js";
import { encodeMessage, extractMessages, type Framing } from "./framing.js";
import { createAcpFileIo, hasClientFs, parseClientCapabilities } from "./fs.js";
import type { NotifyFn, RequestFn } from "./rpc.js";
import { clientTerminalEnabled, createAcpTerminal } from "./terminal.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const ACP_PROTOCOL_VERSION = 1;

export const SESSION_MODES = [
  { id: "execute", name: "Execute", description: "Edit files and run tools in the workspace." },
  { id: "plan", name: "Plan", description: "Read-only research, then update_plan." },
] as const;

export { type NotifyFn, type RequestFn } from "./rpc.js";

export function modeState(runMode: RunMode): { currentModeId: string; availableModes: typeof SESSION_MODES } {
  return {
    currentModeId: runMode === "plan" ? "plan" : "execute",
    availableModes: SESSION_MODES,
  };
}

export function parseModeId(raw: unknown): RunMode {
  const id = String(raw ?? "");
  if (id === "plan" || id === "architect") return "plan";
  return "default";
}

export function permissionKind(risk: Risk): string {
  if (risk === "write") return "edit";
  if (risk === "exec") return "execute";
  if (risk === "network") return "fetch";
  return "read";
}

export function parsePermissionOutcome(raw: unknown): "allow" | "deny" {
  if (!raw || typeof raw !== "object") return "deny";
  const root = raw as Record<string, unknown>;
  const outcome = root.outcome ?? raw;
  if (outcome === "allow" || outcome === "selected") return "allow";
  if (outcome === "deny" || outcome === "reject" || outcome === "cancelled") return "deny";
  if (outcome && typeof outcome === "object") {
    const tagged = outcome as Record<string, unknown>;
    const tag = String(tagged.outcome ?? tagged.type ?? "");
    if (tag === "cancelled" || tag === "rejected") return "deny";
    const optionId = String(tagged.optionId ?? tagged.option_id ?? "");
    if (tag === "selected" && optionId.startsWith("allow")) return "allow";
    if (optionId.startsWith("allow")) return "allow";
    if (optionId.startsWith("reject") || optionId.startsWith("deny")) return "deny";
  }
  if (typeof root.optionId === "string" && root.optionId.startsWith("allow")) return "allow";
  return "deny";
}

export function bindAcpApprover(host: AgentHost, sessionId: string, request: RequestFn): void {
  host.approver = async (approval: ApprovalRequest) => {
    const raw = await request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: approval.callId ?? approval.tool,
        title: approval.summary,
        kind: permissionKind(approval.risk),
        status: "pending",
        rawInput: approval.arguments,
      },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    return parsePermissionOutcome(raw);
  };
  host.askUser = async ({ question, choices }) => {
    const options =
      choices?.length && choices.length > 0
        ? choices.map((choice, i) => ({
            optionId: `allow-choice-${i}`,
            name: choice,
            kind: "allow_once" as const,
          }))
        : [
            { optionId: "allow-once", name: "Continue", kind: "allow_once" as const },
            { optionId: "reject-once", name: "Cancel", kind: "reject_once" as const },
          ];
    const raw = await request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "ask_user",
        title: question,
        kind: "other",
        status: "pending",
      },
      options,
    });
    if (parsePermissionOutcome(raw) === "deny") return "cancelled";
    const optionId = selectedOptionId(raw);
    const hit = options.find((option) => option.optionId === optionId);
    return hit?.name ?? "ok";
  };
}

function selectedOptionId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const root = raw as Record<string, unknown>;
  if (typeof root.optionId === "string") return root.optionId;
  const outcome = root.outcome;
  if (outcome && typeof outcome === "object" && typeof (outcome as { optionId?: unknown }).optionId === "string") {
    return (outcome as { optionId: string }).optionId;
  }
  return undefined;
}

/**
 * ACP-shaped JSON-RPC over stdio (NDJSON or LSP Content-Length).
 * Same AgentHost as the CLI. Not a claim of full Zed registry compatibility.
 */
export async function runAcpStdio(host: AgentHost): Promise<void> {
  const sessions = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  let framing: Framing | undefined;
  let nextId = 1;
  let buffer = "";

  const write = (msg: unknown) => {
    stdout.write(encodeMessage(msg, framing ?? "ndjson"));
  };

  const request: RequestFn = (method, params) => {
    const id = `agent-${nextId++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ jsonrpc: "2.0", id, method, params });
    });
  };

  const handle = async (msg: RpcRequest & RpcResponse) => {
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
      return;
    }

    const id = msg.id ?? null;
    try {
      const result = await dispatch(host, sessions, controllers, msg, (note) => {
        write({ jsonrpc: "2.0", method: "session/update", params: note });
      }, request);
      if (msg.id !== undefined) {
        write({ jsonrpc: "2.0", id, result } satisfies RpcResponse);
      }
    } catch (err) {
      if (msg.id === undefined) return;
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      } satisfies RpcResponse);
    }
  };

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    buffer += chunk;
    try {
      const extracted = extractMessages(buffer, framing);
      framing = extracted.framing ?? framing;
      buffer = extracted.rest;
      for (const message of extracted.messages) {
        void handle(message as RpcRequest & RpcResponse);
      }
    } catch (err) {
      stderr.write(`acp parse error: ${err instanceof Error ? err.message : err}\n`);
    }
  });

  await new Promise<void>((resolve) => {
    stdin.on("end", () => resolve());
    stdin.on("close", () => resolve());
  });
  for (const waiter of pending.values()) waiter.reject(new Error("ACP stdin closed"));
  pending.clear();
  await host.close();
}

export async function dispatch(
  host: AgentHost,
  sessions: Set<string>,
  controllers: Map<string, AbortController>,
  req: RpcRequest,
  notify: NotifyFn,
  request?: RequestFn,
): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      host.clientFs = parseClientCapabilities(req.params);
      host.clientTerminal = clientTerminalEnabled(req.params);
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: true, sse: false },
          sessionCapabilities: { additionalDirectories: {} },
        },
        agentInfo: { name: "agent", version: "0.10.0" },
        authMethods: [],
      };
    case "authenticate":
      return {};
    case "session/new": {
      const sessionId = host.createSession(sessionCwd(req.params));
      sessions.add(sessionId);
      host.setSessionRoots(sessionId, parseAdditionalDirectories(req.params?.additionalDirectories));
      await host.attachSessionMcp(sessionId, req.params?.mcpServers);
      return { sessionId, modes: modeState(host.config.runMode) };
    }
    case "session/load": {
      const sessionId = String(req.params?.sessionId ?? "");
      host.resume(sessionId, sessionCwd(req.params));
      sessions.add(sessionId);
      host.setSessionRoots(sessionId, parseAdditionalDirectories(req.params?.additionalDirectories));
      await host.attachSessionMcp(sessionId, req.params?.mcpServers);
      return { sessionId, modes: modeState(host.config.runMode) };
    }
    case "session/set_mode": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessions.has(sessionId)) throw new Error("unknown session");
      const modeId = req.params?.modeId ?? req.params?.mode;
      host.setRunMode(parseModeId(modeId));
      notify({ sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: modeState(host.config.runMode).currentModeId } });
      return {};
    }
    case "session/cancel": {
      const sessionId = String(req.params?.sessionId ?? "");
      controllers.get(sessionId)?.abort();
      return {};
    }
    case "session/prompt": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessions.has(sessionId)) throw new Error("unknown session");
      const prompt = promptText(req.params?.prompt);
      const controller = new AbortController();
      controllers.set(sessionId, controller);
      const previousApprover = host.approver;
      const previousAsk = host.askUser;
      const runtime = host.runtimeFor(sessionId);
      const previousFiles = runtime.files;
      const previousTerminal = runtime.terminal;
      const previousOnTerminal = runtime.onTerminal;
      if (request) {
        bindAcpApprover(host, sessionId, request);
        if (host.config.approvalMode === "auto") host.approver = previousApprover;
        if (hasClientFs(host.clientFs)) {
          runtime.files = createAcpFileIo({
            workspace: runtime.workspace,
            sessionId,
            request,
            caps: host.clientFs,
            extraRoots: runtime.extraRoots,
          });
        }
        if (host.clientTerminal) {
          runtime.terminal = createAcpTerminal(sessionId, request);
          runtime.onTerminal = (callId, terminalId) => {
            notify({
              sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: callId,
                status: "in_progress",
                content: [{ type: "terminal", terminalId }],
              },
            });
          };
        }
      }
      try {
        for await (const event of host.prompt(sessionId, prompt, controller.signal)) {
          notify({ sessionId, update: toAcpUpdate(event) });
        }
        return { stopReason: controller.signal.aborted ? "cancelled" : "end_turn" };
      } finally {
        host.approver = previousApprover;
        host.askUser = previousAsk;
        runtime.files = previousFiles;
        runtime.terminal = previousTerminal;
        runtime.onTerminal = previousOnTerminal;
        controllers.delete(sessionId);
      }
    }
    default:
      throw new Error(`unknown method: ${req.method ?? "?"}`);
  }
}

function sessionCwd(params?: Record<string, unknown>): string | undefined {
  const cwd = params?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  return path.resolve(cwd);
}

export function parseAdditionalDirectories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim() || !path.isAbsolute(item)) continue;
    const resolved = path.resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function toolKind(name: string): string {
  if (name === "read") return "read";
  if (name === "apply_patch") return "edit";
  if (name === "grep" || name === "glob") return "search";
  if (name === "shell") return "execute";
  if (name === "web_search" || name === "web_fetch" || name === "browser") return "fetch";
  return "other";
}

export function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((block) => {
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: unknown }).text);
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function toAcpUpdate(event: LoopEvent): Record<string, unknown> {
  switch (event.type) {
    case "text-delta":
      return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } };
    case "tool-start":
      return {
        sessionUpdate: "tool_call",
        toolCallId: event.callId,
        title: event.name,
        kind: toolKind(event.name),
        status: "in_progress",
      };
    case "tool-end":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.callId,
        status: event.isError ? "failed" : "completed",
        rawOutput: event.content,
        content: [
          {
            type: "content",
            content: { type: "text", text: event.content },
          },
        ],
      };
    case "plan":
      return {
        sessionUpdate: "plan",
        entries: event.steps.map((step) => ({ content: step.title, status: step.status })),
      };
    case "turn-end":
      return { sessionUpdate: "turn_end" };
    case "artifact":
      return { sessionUpdate: "artifact", artifact: event.artifact };
    case "aborted":
      return { sessionUpdate: "cancelled" };
    case "error":
      return { sessionUpdate: "error", message: event.message };
    default:
      return { sessionUpdate: event.type };
  }
}
