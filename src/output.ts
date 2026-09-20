import { redactSecrets } from "./credentials.js";
import type { EvalResult } from "./eval/types.js";
import type { SessionInspect, SessionListRow } from "./session/store.js";
import type { LoopEvent, SessionEvent } from "./types.js";

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

export function formatSessionShow(session: SessionInspect, format: OutputFormat): string {
  if (format !== "text") return redactSecrets(JSON.stringify(session));
  const header = `session ${session.id}  ${session.timestamp}  ${session.model}  ${session.cwd}${
    session.title ? `  ${session.title}` : ""
  }${session.forkedFrom ? `  fork of ${session.forkedFrom}` : ""}`;
  return `${header}\n\n${session.events.map(formatSessionEvent).join("\n\n")}`;
}

export function formatSessionDelete(sessionId: string, format: OutputFormat): string {
  if (format === "text") return `Deleted ${sessionId}`;
  return JSON.stringify({ id: sessionId, deleted: true });
}

export function formatSessionFork(
  result: { id: string; forkedFrom: string },
  format: OutputFormat,
): string {
  if (format === "text") return `Forked ${result.forkedFrom} -> ${result.id}`;
  return JSON.stringify({ id: result.id, forkedFrom: result.forkedFrom });
}

export interface EvalJsonResult {
  type: "eval";
  passed: number;
  failed: number;
  results: EvalResult[];
}

export function collectEvalResult(results: EvalResult[]): EvalJsonResult {
  return {
    type: "eval",
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

export function encodeEvalResult(result: EvalJsonResult): string {
  return redactSecrets(JSON.stringify(result));
}

export function formatEvalResults(results: EvalResult[], format: OutputFormat): { stdout: string; stderr: string } {
  if (format !== "text") {
    return { stdout: encodeEvalResult(collectEvalResult(results)), stderr: "" };
  }
  const passed: string[] = [];
  const failed: string[] = [];
  for (const result of results) {
    if (result.ok) passed.push(`PASS  ${result.name}`);
    else failed.push(`FAIL  ${result.name}: ${result.error}`);
  }
  return { stdout: passed.join("\n"), stderr: failed.join("\n") };
}

function formatSessionEvent(event: SessionEvent): string {
  switch (event.type) {
    case "session_meta":
      return `meta  ${event.timestamp}  ${event.provider}  ${event.model}${
        event.forkedFrom ? `  fork of ${event.forkedFrom}` : ""
      }`;
    case "user":
      return `user  ${event.timestamp}\n${event.text}`;
    case "assistant":
      return `assistant  ${event.timestamp}\n${event.text}`;
    case "tool_call":
      return `tool_call  ${event.name}  ${event.callId}\n${JSON.stringify(event.arguments)}`;
    case "tool_result":
      return `tool_result  ${event.name}  ${event.callId}${event.isError ? "  error" : ""}\n${event.content}`;
    case "compact":
      return `compact  ${event.timestamp}\n${event.summary}`;
    case "plan":
      return `plan  ${event.timestamp}\n${event.steps.map((step) => `  [${step.status}] ${step.title}`).join("\n")}`;
    case "artifact":
      return `artifact  ${event.artifact.kind}: ${event.artifact.path}`;
  }
}
