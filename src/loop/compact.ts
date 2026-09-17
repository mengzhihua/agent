import type { AgentConfig, ModelMessage, Provider } from "../types.js";
import { compactPrompt } from "../prompt/system.js";
import { estimateTokens, truncate } from "../workspace.js";

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
