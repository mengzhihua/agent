import type { AgentConfig, LoopEvent, ModelMessage, Provider } from "../types.js";
import { compactPrompt } from "../prompt/system.js";
import { estimateTokens, truncate } from "../workspace.js";
import { newId, nowIso } from "../ids.js";
import { assembleMessages } from "./assemble.js";
import type { SessionStore } from "../session/store.js";

function transcriptForCompact(messages: ModelMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "user") return `USER:\n${truncate(message.content, 2000)}`;
      if (message.role === "assistant") {
        const tools = (message.toolCalls ?? [])
          .map((call) => `  tool ${call.name} ${truncate(JSON.stringify(call.arguments), 300)}`)
          .join("\n");
        return `ASSISTANT:\n${truncate(message.content, 1500)}${tools ? `\n${tools}` : ""}`;
      }
      return `TOOL ${message.name}:\n${truncate(message.content, 800)}`;
    })
    .join("\n\n");
}

export async function summarizeTranscript(
  provider: Provider,
  config: AgentConfig,
  messages: ModelMessage[],
  signal: AbortSignal,
): Promise<string> {
  let summary = "";
  for await (const event of provider.complete(
    {
      model: config.model,
      system: compactPrompt(),
      messages: [{ role: "user", content: transcriptForCompact(messages) }],
      tools: [],
    },
    signal,
  )) {
    if (event.type === "text-delta") summary += event.text;
  }
  const trimmed = summary.trim();
  if (!trimmed) throw new Error("compact produced an empty summary");
  return trimmed;
}

export function shouldCompact(messages: ModelMessage[], config: AgentConfig): boolean {
  return estimateTokens(messages) >= config.compactTokens;
}

export async function* compactNow(options: {
  store: SessionStore;
  sessionId: string;
  provider: Provider;
  config: AgentConfig;
  signal: AbortSignal;
  force?: boolean;
}): AsyncGenerator<LoopEvent> {
  const { store, sessionId, provider, config, signal } = options;
  const events = store.read(sessionId);
  const last = events.at(-1);
  const trailingUser = last?.type === "user" ? last : undefined;
  const fullMessages = assembleMessages(events);
  if (!options.force && !shouldCompact(fullMessages, config)) return;

  const prior = trailingUser && !options.force ? assembleMessages(events.slice(0, -1)) : fullMessages;
  if (prior.length === 0) {
    if (options.force) throw new Error("nothing to compact");
    return;
  }

  yield { type: "compact-start" };
  const summary = await summarizeTranscript(provider, config, prior, signal);
  store.append(sessionId, {
    type: "compact",
    id: newId("evt"),
    timestamp: nowIso(),
    summary,
  });
  if (trailingUser && !options.force) {
    store.append(sessionId, {
      type: "user",
      id: newId("evt"),
      timestamp: nowIso(),
      text: trailingUser.text,
    });
  }
  yield { type: "compact-end", summary };
}
