import type { CompletionEvent, CompletionRequest, Provider } from "../types.js";

export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private readonly queue: Array<{
    text?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
    usage?: { inputTokens: number; outputTokens: number };
  }>;

  constructor(
    scripts: Array<{
      text?: string;
      toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
      usage?: { inputTokens: number; outputTokens: number };
    }>,
  ) {
    this.queue = [...scripts];
  }

  remaining(): number {
    return this.queue.length;
  }

  async *complete(_request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionEvent> {
    signal.throwIfAborted();
    const next = this.queue.shift();
    if (!next) {
      throw new Error("scripted provider exhausted");
    }
    if (next.text) {
      yield { type: "text-delta", text: next.text };
    }
    for (const call of next.toolCalls ?? []) {
      yield { type: "tool-call", id: call.id, name: call.name, arguments: call.arguments };
    }
    if (next.usage) {
      yield { type: "usage", inputTokens: next.usage.inputTokens, outputTokens: next.usage.outputTokens };
    }
    yield { type: "done" };
  }
}
