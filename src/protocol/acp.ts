import { stdin, stdout, stderr } from "node:process";
import type { AgentHost } from "../host.js";
import type { LoopEvent } from "../types.js";

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

/**
 * ACP-shaped JSON-RPC over NDJSON stdio.
 * This is the reserved client protocol: CLI, a future TUI, and editors
 * should all drive the same AgentHost through these methods.
 * It is intentionally a subset, not a claim of full Zed ACP compatibility.
 */
export async function runAcpStdio(host: AgentHost): Promise<void> {
  let buffer = "";
  const sessions = new Set<string>();
  const controllers = new Map<string, AbortController>();

  const write = (msg: unknown) => {
    stdout.write(`${JSON.stringify(msg)}\n`);
  };

  const handle = async (req: RpcRequest) => {
    const id = req.id ?? null;
    try {
      const result = await dispatch(host, sessions, controllers, req, (note) => {
        write({ jsonrpc: "2.0", method: "session/update", params: note });
      });
      if (req.id !== undefined) {
        write({ jsonrpc: "2.0", id, result } satisfies RpcResponse);
      }
    } catch (err) {
      if (req.id === undefined) return;
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
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        void handle(JSON.parse(trimmed) as RpcRequest);
      } catch (err) {
        stderr.write(`acp parse error: ${err instanceof Error ? err.message : err}\n`);
      }
    }
  });

  await new Promise<void>((resolve) => {
    stdin.on("end", () => resolve());
    stdin.on("close", () => resolve());
  });
  await host.close();
}

export async function dispatch(
  host: AgentHost,
  sessions: Set<string>,
  controllers: Map<string, AbortController>,
  req: RpcRequest,
  notify: (params: unknown) => void,
): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: "0.1.0",
        agentCapabilities: { prompt: true, session: true },
        agentInfo: { name: "agent", version: "0.4.0" },
      };
    case "session/new": {
      const sessionId = host.createSession();
      sessions.add(sessionId);
      return { sessionId };
    }
    case "session/load": {
      const sessionId = String(req.params?.sessionId ?? "");
      host.resume(sessionId);
      sessions.add(sessionId);
      return { sessionId };
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
      try {
        for await (const event of host.prompt(sessionId, prompt, controller.signal)) {
          notify({ sessionId, update: toAcpUpdate(event) });
        }
        return { stopReason: "end_turn" };
      } finally {
        controllers.delete(sessionId);
      }
    }
    default:
      throw new Error(`unknown method: ${req.method ?? "?"}`);
  }
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
        status: "in_progress",
      };
    case "tool-end":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.callId,
        status: event.isError ? "failed" : "completed",
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
