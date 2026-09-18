import path from "node:path";
import { stdin, stdout, stderr } from "node:process";
import type { AgentHost } from "../host.js";
import { assembleMessages } from "../loop/assemble.js";
import { autoApprover } from "../permissions/policy.js";
import { sessionTitle, type SessionListRow } from "../session/store.js";
import type { AgentConfig, ApprovalMode, ApprovalRequest, LoopEvent, Risk, RunMode, SessionEvent, ToolDiff, ToolLocation } from "../types.js";
import { locationsFromToolArgs } from "../tools/types.js";
import { estimateTokens } from "../workspace.js";
import { encodeMessage, extractMessages, type Framing } from "./framing.js";
import { elicitAskUser, parseElicitationCapabilities } from "./elicitation.js";
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
export const SESSION_LIST_PAGE_SIZE = 50;

export const AVAILABLE_COMMANDS = [
  { name: "plan", description: "Switch to plan mode: read-only research, then update_plan.", input: { hint: "what to plan" } },
  { name: "execute", description: "Switch to execute mode: edit files and run tools.", input: { hint: "task" } },
  { name: "skills", description: "List available skills for this workspace." },
  { name: "yes", description: "Auto-approve write, shell, and network tools." },
  { name: "ask", description: "Ask before write, shell, or network tools." },
] as const;

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

export function modelSelectOptions(config: AgentConfig): { value: string; name: string }[] {
  const values = [config.model, "gpt-4.1", "grok-4", "claude-sonnet-4-5"];
  const seen = new Set<string>();
  const out: { value: string; name: string }[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, name: value });
  }
  return out;
}

export function acpConfigOptions(host: AgentHost): Record<string, unknown>[] {
  return [
    {
      id: "mode",
      name: "Session Mode",
      description: "Plan is read-only research; execute can edit and run tools.",
      category: "mode",
      type: "select",
      currentValue: host.config.runMode === "plan" ? "plan" : "execute",
      options: SESSION_MODES.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: host.config.model,
      options: modelSelectOptions(host.config),
    },
    {
      id: "approval",
      name: "Approvals",
      description: "Whether mutating tools need confirmation.",
      type: "select",
      currentValue: host.config.approvalMode,
      options: [
        { value: "ask", name: "Ask", description: "Ask before write, shell, or network tools." },
        { value: "auto", name: "Auto", description: "Auto-approve write, shell, and network tools." },
      ],
    },
  ];
}

export function applyConfigOption(host: AgentHost, configId: string, value: unknown): boolean {
  if (configId === "mode") {
    host.setRunMode(parseModeId(value));
    return true;
  }
  if (configId === "approval") {
    const mode = String(value);
    if (mode !== "ask" && mode !== "auto") throw new Error("invalid approval value");
    host.setApprovalMode(mode as ApprovalMode);
    return false;
  }
  if (configId === "model") {
    const model = String(value ?? "").trim();
    if (!modelSelectOptions(host.config).some((option) => option.value === model)) {
      throw new Error("invalid model value");
    }
    host.setModel(model);
    return false;
  }
  throw new Error(`unknown config option: ${configId || "?"}`);
}

function notifyConfigOptions(host: AgentHost, sessionId: string, notify: NotifyFn): void {
  notify({
    sessionId,
    update: { sessionUpdate: "config_option_update", configOptions: acpConfigOptions(host) },
  });
}

export function contextWindowSize(model: string, compactTokens: number): number {
  const id = model.toLowerCase();
  if (id.includes("claude")) return 200_000;
  if (id.includes("grok")) return 256_000;
  if (id.includes("gpt-4.1")) return 1_047_576;
  if (id.includes("gpt-4o") || id.includes("gpt-4")) return 128_000;
  return Math.max(compactTokens, 128_000);
}

export function acpUsageUpdate(host: AgentHost, sessionId: string): { sessionUpdate: "usage_update"; used: number; size: number } {
  const size = contextWindowSize(host.config.model, host.config.compactTokens);
  if (!host.store.exists(sessionId)) return { sessionUpdate: "usage_update", used: 0, size };
  const messages = assembleMessages(host.store.read(sessionId));
  const used = messages.length === 0 ? 0 : estimateTokens(messages);
  return { sessionUpdate: "usage_update", used, size };
}

function notifyUsage(host: AgentHost, sessionId: string, notify: NotifyFn): void {
  notify({ sessionId, update: acpUsageUpdate(host, sessionId) });
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
  host.askUser = async (input) => {
    if (host.clientElicitation.form) return elicitAskUser(sessionId, request, input);
    const options =
      input.choices?.length && input.choices.length > 0
        ? input.choices.map((choice, i) => ({
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
        toolCallId: input.callId ?? "ask_user",
        title: input.question,
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
      host.clientElicitation = parseElicitationCapabilities(req.params);
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: true, sse: false },
          sessionCapabilities: { additionalDirectories: {}, resume: {}, close: {}, list: {}, delete: {} },
        },
        agentInfo: { name: "agent", version: "0.18.0" },
        authMethods: [],
      };
    case "authenticate":
      return {};
    case "session/new": {
      const sessionId = host.createSession(sessionCwd(req.params));
      sessions.add(sessionId);
      host.setSessionRoots(sessionId, parseAdditionalDirectories(req.params?.additionalDirectories));
      await host.attachSessionMcp(sessionId, req.params?.mcpServers);
      notifyAvailableCommands(sessionId, notify);
      notifyUsage(host, sessionId, notify);
      return { sessionId, modes: modeState(host.config.runMode), configOptions: acpConfigOptions(host) };
    }
    case "session/load": {
      const sessionId = await restoreSession(host, sessions, req.params);
      for (const event of host.store.read(sessionId)) {
        const update = toAcpReplayUpdate(event);
        if (update) notify({ sessionId, update });
      }
      notifyAvailableCommands(sessionId, notify);
      notifyConfigOptions(host, sessionId, notify);
      notifyUsage(host, sessionId, notify);
      return null;
    }
    case "session/resume": {
      const sessionId = await restoreSession(host, sessions, req.params);
      notifyAvailableCommands(sessionId, notify);
      notifyUsage(host, sessionId, notify);
      return { sessionId, modes: modeState(host.config.runMode), configOptions: acpConfigOptions(host) };
    }
    case "session/close": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessions.has(sessionId)) throw new Error("unknown session");
      controllers.get(sessionId)?.abort();
      controllers.delete(sessionId);
      await host.closeSession(sessionId);
      sessions.delete(sessionId);
      return {};
    }
    case "session/list":
      return listAcpSessions(host, req.params);
    case "session/delete": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (sessions.has(sessionId)) {
        controllers.get(sessionId)?.abort();
        controllers.delete(sessionId);
        sessions.delete(sessionId);
      }
      await host.deleteSession(sessionId);
      return {};
    }
    case "session/set_mode": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessions.has(sessionId)) throw new Error("unknown session");
      const modeId = req.params?.modeId ?? req.params?.mode;
      host.setRunMode(parseModeId(modeId));
      notify({ sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: modeState(host.config.runMode).currentModeId } });
      notifyConfigOptions(host, sessionId, notify);
      return {};
    }
    case "session/set_config_option": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessions.has(sessionId)) throw new Error("unknown session");
      const configId = String(req.params?.configId ?? req.params?.id ?? "");
      const modeChanged = applyConfigOption(host, configId, req.params?.value);
      if (modeChanged) {
        notify({ sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: modeState(host.config.runMode).currentModeId } });
      }
      notifyConfigOptions(host, sessionId, notify);
      if (configId === "model") notifyUsage(host, sessionId, notify);
      return { configOptions: acpConfigOptions(host) };
    }
    case "session/cancel": {
      const sessionId = String(req.params?.sessionId ?? "");
      controllers.get(sessionId)?.abort();
      return {};
    }
    case "session/prompt": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessions.has(sessionId)) throw new Error("unknown session");
      const rawPrompt = promptText(req.params?.prompt);
      const slash = parseSlashCommand(rawPrompt);
      if (slash.name && applySlashCommand(host, sessionId, slash, notify) === "done") {
        notifyUsage(host, sessionId, notify);
        return { stopReason: "end_turn" };
      }
      const prompt = slash.name ? slash.rest : rawPrompt;
      if (!prompt) {
        notifyUsage(host, sessionId, notify);
        return { stopReason: "end_turn" };
      }
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
        if (host.config.approvalMode === "auto") host.approver = autoApprover();
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
          if (event.type === "usage") continue;
          notify({ sessionId, update: toAcpUpdate(event) });
        }
        const info = sessionInfoUpdate(host, sessionId);
        if (info) notify({ sessionId, update: info });
        notifyUsage(host, sessionId, notify);
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

function notifyAvailableCommands(sessionId: string, notify: NotifyFn): void {
  notify({
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: AVAILABLE_COMMANDS,
    },
  });
}

export function parseSlashCommand(text: string): { name?: string; rest: string } {
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return { rest: text };
  const name = match[1];
  if (!AVAILABLE_COMMANDS.some((command) => command.name === name)) return { rest: text };
  return { name, rest: (match[2] ?? "").trim() };
}

export function applySlashCommand(
  host: AgentHost,
  sessionId: string,
  slash: { name?: string; rest: string },
  notify: NotifyFn,
): "continue" | "done" {
  switch (slash.name) {
    case "plan":
      host.setRunMode("plan");
      notify({
        sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: modeState(host.config.runMode).currentModeId },
      });
      notifyConfigOptions(host, sessionId, notify);
      return slash.rest ? "continue" : "done";
    case "execute":
      host.setRunMode("default");
      notify({
        sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: modeState(host.config.runMode).currentModeId },
      });
      notifyConfigOptions(host, sessionId, notify);
      return slash.rest ? "continue" : "done";
    case "yes":
      host.setApprovalMode("auto");
      notifyConfigOptions(host, sessionId, notify);
      return slash.rest ? "continue" : "done";
    case "ask":
      host.setApprovalMode("ask");
      notifyConfigOptions(host, sessionId, notify);
      return slash.rest ? "continue" : "done";
    case "skills": {
      const names = host.skills.all().map((skill) => `${skill.name}: ${skill.description}`);
      notify({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: names.join("\n") || "(no skills)" },
        },
      });
      return "done";
    }
    default:
      return "continue";
  }
}

export function listAcpSessions(
  host: AgentHost,
  params?: Record<string, unknown>,
  pageSize = SESSION_LIST_PAGE_SIZE,
): { sessions: Record<string, unknown>[]; nextCursor?: string } {
  const cwd = listCwdFilter(params?.cwd);
  const offset = parseListCursor(params?.cursor);
  const rows = host.store.list().filter((row) => cwd === undefined || path.resolve(row.cwd) === cwd);
  const page = rows.slice(offset, offset + pageSize);
  const sessions = page.map((row) => toAcpSessionInfo(row, host.extraRootsFor(row.id)));
  const nextOffset = offset + page.length;
  return {
    sessions,
    ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {}),
  };
}

export function parseListCursor(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const token = typeof raw === "number" ? String(raw) : raw;
  if (typeof token !== "string" || !/^\d+$/.test(token)) throw new Error("invalid cursor");
  return Number(token);
}

function listCwdFilter(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  if (!path.isAbsolute(raw)) return "\0";
  return path.resolve(raw);
}

export function toAcpSessionInfo(row: SessionListRow, extraRoots: string[] = []): Record<string, unknown> {
  const info: Record<string, unknown> = {
    sessionId: row.id,
    cwd: row.cwd,
    updatedAt: row.timestamp,
  };
  if (row.title) info.title = row.title;
  if (extraRoots.length > 0) info.additionalDirectories = extraRoots;
  return info;
}

function sessionInfoUpdate(host: AgentHost, sessionId: string): Record<string, unknown> | undefined {
  if (!host.store.exists(sessionId)) return undefined;
  const events = host.store.read(sessionId);
  const firstUser = events.find((event) => event.type === "user");
  const last = events.at(-1);
  const update: Record<string, unknown> = { sessionUpdate: "session_info_update" };
  if (firstUser && firstUser.type === "user") update.title = sessionTitle(firstUser.text);
  if (last?.timestamp) update.updatedAt = last.timestamp;
  return update.title || update.updatedAt ? update : undefined;
}

async function restoreSession(
  host: AgentHost,
  sessions: Set<string>,
  params?: Record<string, unknown>,
): Promise<string> {
  const sessionId = String(params?.sessionId ?? "");
  host.resume(sessionId, sessionCwd(params));
  sessions.add(sessionId);
  host.setSessionRoots(sessionId, parseAdditionalDirectories(params?.additionalDirectories));
  await host.attachSessionMcp(sessionId, params?.mcpServers);
  return sessionId;
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

function acpToolCallStart(
  callId: string,
  name: string,
  args: unknown,
  locations?: ToolLocation[],
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    sessionUpdate: "tool_call",
    toolCallId: callId,
    title: name,
    name,
    kind: toolKind(name),
    status: "in_progress",
    rawInput: args,
  };
  const locs = locations ?? locationsFromToolArgs(name, args);
  if (locs?.length) update.locations = locs;
  return update;
}

function acpToolCallEnd(
  callId: string,
  output: string,
  isError?: boolean,
  locations?: ToolLocation[],
  diff?: ToolDiff,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [
    {
      type: "content",
      content: { type: "text", text: output },
    },
  ];
  if (diff) {
    content.push({
      type: "diff",
      path: diff.path,
      oldText: diff.oldText,
      newText: diff.newText,
    });
  }
  const update: Record<string, unknown> = {
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    status: isError ? "failed" : "completed",
    rawOutput: output,
    content,
  };
  if (locations?.length) update.locations = locations;
  return update;
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

export function toAcpReplayUpdate(event: SessionEvent): Record<string, unknown> | undefined {
  switch (event.type) {
    case "user":
      return {
        sessionUpdate: "user_message_chunk",
        messageId: event.id,
        content: { type: "text", text: event.text },
      };
    case "assistant":
      if (!event.text) return undefined;
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: event.id,
        content: { type: "text", text: event.text },
      };
    case "tool_call":
      return acpToolCallStart(event.callId, event.name, event.arguments);
    case "tool_result":
      return acpToolCallEnd(event.callId, event.content, event.isError);
    case "plan":
      return {
        sessionUpdate: "plan",
        entries: event.steps.map((step) => ({ content: step.title, status: step.status })),
      };
    case "artifact":
      return { sessionUpdate: "artifact", artifact: event.artifact };
    default:
      return undefined;
  }
}

export function toAcpUpdate(event: LoopEvent): Record<string, unknown> {
  switch (event.type) {
    case "text-delta":
      return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } };
    case "tool-start":
      return acpToolCallStart(event.callId, event.name, event.arguments, event.locations);
    case "tool-end":
      return acpToolCallEnd(event.callId, event.content, event.isError, event.locations, event.diff);
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
