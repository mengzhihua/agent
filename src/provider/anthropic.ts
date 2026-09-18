import { redactSecrets, resolveSecret } from "../credentials.js";
import { fetchWithRetry } from "../http.js";
import type { CompletionEvent, CompletionRequest, ModelMessage, Provider, ToolDefinition } from "../types.js";

function anthropicTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function anthropicMessages(messages: ModelMessage[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      out.push({ role: "assistant", content });
    } else {
      const last = out.at(-1);
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        is_error: message.isError ?? false,
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  constructor(private readonly apiKey: string) {}

  async *complete(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionEvent> {
    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 16_384,
        stream: true,
        system: request.system,
        tools: request.tools.length ? anthropicTools(request.tools) : undefined,
        messages: anthropicMessages(request.messages),
      }),
    });
    if (!res.ok || !res.body) {
      const body = redactSecrets(await res.text().catch(() => ""));
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Anthropic HTTP ${res.status}: missing or invalid API key. Run: agent login --provider anthropic`,
        );
      }
      throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    let currentTool: { id: string; name: string; json: string } | null = null;
    for await (const { event, data } of readAnthropicSse(res.body, signal)) {
      if (event === "content_block_delta") {
        const delta = data.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text-delta", text: delta.text };
        }
        if (delta?.type === "input_json_delta" && currentTool && delta.partial_json) {
          currentTool.json += delta.partial_json;
        }
      }
      if (event === "content_block_start") {
        const block = data.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === "tool_use" && block.id && block.name) {
          currentTool = { id: block.id, name: block.name, json: "" };
        }
      }
      if (event === "content_block_stop" && currentTool) {
        let args: unknown = {};
        try {
          args = currentTool.json ? JSON.parse(currentTool.json) : {};
        } catch {
          args = { _raw: currentTool.json, _parseError: true };
        }
        yield { type: "tool-call", id: currentTool.id, name: currentTool.name, arguments: args };
        currentTool = null;
      }
      if (event === "message_delta") {
        const usage = (data.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
        if (usage.input_tokens || usage.output_tokens) {
          yield {
            type: "usage",
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
          };
        }
      }
    }
    yield { type: "done" };
  }
}

export function createAnthropicProvider(): AnthropicProvider {
  const apiKey = resolveSecret("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("missing API key. Run: agent login --provider anthropic");
  }
  return new AnthropicProvider(apiKey);
}

async function* readAnthropicSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  while (true) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("event:")) {
        event = trimmed.slice(6).trim();
      } else if (trimmed.startsWith("data:")) {
        try {
          yield { event, data: JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown> };
        } catch {
          // ignore malformed chunks
        }
      }
    }
  }
}
