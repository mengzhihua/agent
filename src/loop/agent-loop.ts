import { newId, nowIso } from "../ids.js";
import { decidePermission } from "../permissions/policy.js";
import type { SessionStore } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runTool } from "../tools/types.js";
import type { AgentConfig, Approver, LoopEvent, Provider, ToolCall } from "../types.js";
import { assembleMessages } from "./assemble.js";
import { shouldCompact, summarizeTranscript } from "./compact.js";
import { buildSystemPrompt } from "../prompt/system.js";

export interface RunTurnOptions {
  store: SessionStore;
  sessionId: string;
  userText: string;
  provider: Provider;
  tools: ToolRegistry;
  config: AgentConfig;
  approver: Approver;
  signal: AbortSignal;
}

export async function* runTurn(options: RunTurnOptions): AsyncGenerator<LoopEvent> {
  const { store, sessionId, userText, provider, tools, config, approver, signal } = options;
  store.append(sessionId, { type: "user", id: newId("evt"), timestamp: nowIso(), text: userText });

  try {
    for (let iter = 0; iter < config.maxToolIterations; iter++) {
      signal.throwIfAborted();

      yield* maybeCompact(options);

      const messages = assembleMessages(store.read(sessionId));
      const toolCalls: ToolCall[] = [];
      let text = "";

      for await (const event of provider.complete(
        {
          model: config.model,
          system: buildSystemPrompt(config),
          messages,
          tools: tools.definitions(),
        },
        signal,
      )) {
        if (event.type === "text-delta") {
          text += event.text;
          yield { type: "text-delta", text: event.text };
        } else if (event.type === "tool-call") {
          toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        } else if (event.type === "usage") {
          yield event;
        }
      }

      if (toolCalls.length === 0) {
        store.append(sessionId, {
          type: "assistant",
          id: newId("evt"),
          timestamp: nowIso(),
          text,
        });
        yield { type: "turn-end", text };
        return;
      }

      store.append(sessionId, {
        type: "assistant",
        id: newId("evt"),
        timestamp: nowIso(),
        text,
      });
      for (const call of toolCalls) {
        store.append(sessionId, {
          type: "tool_call",
          id: newId("evt"),
          timestamp: nowIso(),
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }

      for (const call of toolCalls) {
        yield { type: "tool-start", callId: call.id, name: call.name, arguments: call.arguments };
        const permission = await decidePermission(call.name, call.arguments, config.approvalMode, approver);
        yield { type: "permission", tool: call.name, decision: permission.decision, summary: permission.summary };

        if (permission.decision === "deny") {
          const content = `User denied permission for ${permission.summary}`;
          store.append(sessionId, {
            type: "tool_result",
            id: newId("evt"),
            timestamp: nowIso(),
            callId: call.id,
            name: call.name,
            content,
            isError: true,
          });
          yield { type: "tool-end", callId: call.id, name: call.name, content, isError: true };
          continue;
        }

        const handler = tools.get(call.name);
        const executed = handler
          ? await runTool(handler, call.arguments, { config, signal })
          : { name: call.name, content: `unknown tool: ${call.name}`, isError: true };

        store.append(sessionId, {
          type: "tool_result",
          id: newId("evt"),
          timestamp: nowIso(),
          callId: call.id,
          name: call.name,
          content: executed.content,
          isError: executed.isError,
        });
        yield {
          type: "tool-end",
          callId: call.id,
          name: call.name,
          content: executed.content,
          isError: executed.isError,
        };
      }
    }

    yield { type: "error", message: `stopped after ${config.maxToolIterations} tool iterations` };
  } catch (err) {
    if (signal.aborted) {
      yield { type: "aborted" };
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message };
  }
}

async function* maybeCompact(options: RunTurnOptions): AsyncGenerator<LoopEvent> {
  const { store, sessionId, provider, config, signal } = options;
  const events = store.read(sessionId);
  const last = events.at(-1);
  const trailingUser = last?.type === "user" ? last : undefined;
  const fullMessages = assembleMessages(events);
  if (!shouldCompact(fullMessages, config)) return;

  const prior = trailingUser ? assembleMessages(events.slice(0, -1)) : fullMessages;
  if (prior.length === 0) return;

  yield { type: "compact-start" };
  const summary = await summarizeTranscript(provider, config, prior, signal);
  store.append(sessionId, {
    type: "compact",
    id: newId("evt"),
    timestamp: nowIso(),
    summary,
  });
  if (trailingUser) {
    store.append(sessionId, {
      type: "user",
      id: newId("evt"),
      timestamp: nowIso(),
      text: trailingUser.text,
    });
  }
  yield { type: "compact-end", summary };
}
