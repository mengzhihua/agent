import { redactSecrets } from "./credentials.js";
import type { SessionListRow } from "./session/store.js";
import type { LoopEvent } from "./types.js";

export type OutputFormat = "text" | "json" | "stream-json";

export interface JsonTurnResult {
  type: "result";
  sessionId: string;
  text: string;
  isError: boolean;
  aborted: boolean;
  tools: Array<{ callId: string; name: string; isError?: boolean }>;
  usage?: { inputTokens: number; outputTokens: number };
}

export function parseOutputFormat(raw?: string): OutputFormat {
  const name = (raw ?? process.env.AGENT_OUTPUT_FORMAT ?? "text").trim().toLowerCase();
  if (!name || name === "text") return "text";
  if (name === "json") return "json";
  if (name === "stream-json" || name === "stream_json" || name === "ndjson") return "stream-json";
  throw new Error("usage: --output-format text|json|stream-json");
}

export function collectJsonResult(sessionId: string, events: LoopEvent[]): JsonTurnResult {
  let text = "";
  let isError = false;
  let aborted = false;
  const tools: JsonTurnResult["tools"] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  for (const event of events) {
    if (event.type === "turn-end") text = event.text;
    if (event.type === "error") {
      isError = true;
      if (!text) text = event.message;
    }
    if (event.type === "aborted") aborted = true;
    if (event.type === "tool-end") {
      tools.push({ callId: event.callId, name: event.name, isError: event.isError });
    }
    if (event.type === "usage") {
      sawUsage = true;
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
    }
  }
  const result: JsonTurnResult = { type: "result", sessionId, text, isError, aborted, tools };
  if (sawUsage) result.usage = { inputTokens, outputTokens };
  return result;
}

export function encodeStreamLine(sessionId: string, event: LoopEvent): string {
  return redactSecrets(JSON.stringify({ sessionId, ...event }));
}

export function encodeJsonResult(result: JsonTurnResult): string {
  return redactSecrets(JSON.stringify(result));
}

export function formatSessionList(rows: SessionListRow[], format: OutputFormat): string {
  if (format === "text") {
    if (rows.length === 0) return "No sessions.";
    return rows
      .map((row) => `${row.id}  ${row.timestamp}  ${row.model}  ${row.cwd}${row.title ? `  ${row.title}` : ""}`)
      .join("\n");
  }
  return redactSecrets(JSON.stringify(rows));
}
