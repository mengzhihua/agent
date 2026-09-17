import type { CompletionEvent, CompletionRequest, ModelMessage, Provider, ToolDefinition } from "../types.js";

function openaiTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function openaiMessages(system: string, messages: ModelMessage[]) {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const row: Record<string, unknown> = { role: "assistant", content: message.content || null };
      if (message.toolCalls?.length) {
        row.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
      }
      out.push(row);
    } else {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      });
    }
  }
  return out;
}

function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { _raw: raw, _parseError: true };
  }
}

export class OpenAIProvider implements Provider {
  readonly name = "openai";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async *complete(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionEvent> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: openaiMessages(request.system, request.messages),
        tools: request.tools.length ? openaiTools(request.tools) : undefined,
      }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const tools = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const event of readSse(res.body, signal)) {
      if (event === "[DONE]") break;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event) as Record<string, unknown>;
      } catch {
        continue;
      }
      const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage) {
        yield {
          type: "usage",
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        };
      }
      const choices = parsed.choices as Array<{ delta?: Record<string, unknown> }> | undefined;
      const delta = choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length) {
        yield { type: "text-delta", text: delta.content };
      }
      const calls = delta.tool_calls as
        | Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
        | undefined;
      if (!calls) continue;
      for (const call of calls) {
        const index = call.index ?? 0;
        const current = tools.get(index) ?? { id: "", name: "", arguments: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        tools.set(index, current);
      }
    }

    const ordered = [...tools.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, call] of ordered) {
      yield {
        type: "tool-call",
        id: call.id || `tool_${index}`,
        name: call.name,
        arguments: parseArgs(call.arguments),
      };
    }
    yield { type: "done" };
  }
}

export function createOpenAIProvider(): OpenAIProvider {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY or XAI_API_KEY is required for the openai provider");
  }
  const baseUrl =
    process.env.OPENAI_BASE_URL ??
    (process.env.XAI_API_KEY && !process.env.OPENAI_API_KEY ? "https://api.x.ai/v1" : "https://api.openai.com/v1");
  return new OpenAIProvider(apiKey, baseUrl);
}

async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n");
    buffer = chunks.pop() ?? "";
    for (const line of chunks) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      yield trimmed.slice(5).trim();
    }
  }
  if (buffer.startsWith("data:")) {
    yield buffer.slice(5).trim();
  }
}
