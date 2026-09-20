import { truncate } from "./workspace.js";
import type { SessionEvent } from "./types.js";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  estimateUsd?: number;
}

/** USD per 1M tokens. Estimates from public list prices; not a bill. */
const RATES_PER_MILLION: Array<{ test: (model: string) => boolean; input: number; output: number }> = [
  { test: (m) => m.includes("claude-opus"), input: 15, output: 75 },
  { test: (m) => m.includes("claude-sonnet"), input: 3, output: 15 },
  { test: (m) => m.includes("grok-4"), input: 3, output: 15 },
  { test: (m) => m.includes("gpt-4.1"), input: 2, output: 8 },
  { test: (m) => m.includes("gpt-4o"), input: 2.5, output: 10 },
];

export function estimateUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const id = model.toLowerCase();
  const rate = RATES_PER_MILLION.find((item) => item.test(id));
  if (!rate) return undefined;
  const usd = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export function sessionUsage(events: SessionEvent[], model?: string): SessionUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  for (const event of events) {
    if (event.type !== "usage") continue;
    inputTokens += event.inputTokens;
    outputTokens += event.outputTokens;
    calls += 1;
  }
  const usage: SessionUsage = { inputTokens, outputTokens, calls };
  const usd = model ? estimateUsd(model, inputTokens, outputTokens) : undefined;
  if (usd !== undefined) usage.estimateUsd = usd;
  return usage;
}

export function formatUsageLine(usage: SessionUsage): string {
  const tokens = `tokens  ${usage.inputTokens} in / ${usage.outputTokens} out`;
  if (usage.estimateUsd === undefined) return tokens;
  return `${tokens}  (~$${usage.estimateUsd.toFixed(4)})`;
}

export function capToolOutput(content: string, limit: number): string {
  if (limit <= 0) return content;
  return truncate(content, limit);
}
