import type { ModelMessage, SessionEvent } from "../types.js";

export function eventsAfterCompact(events: SessionEvent[]): {
  summary?: string;
  rest: SessionEvent[];
} {
  let compactAt = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.type === "compact") compactAt = i;
  }
  if (compactAt < 0) {
    return { rest: events.filter((event) => event.type !== "session_meta") };
  }
  const compact = events[compactAt];
  return {
    summary: compact?.type === "compact" ? compact.summary : undefined,
    rest: events.slice(compactAt + 1).filter((event) => event.type !== "session_meta"),
  };
}

export function assembleMessages(events: SessionEvent[]): ModelMessage[] {
  const { summary, rest } = eventsAfterCompact(events);
  const messages: ModelMessage[] = [];
  if (summary) {
    messages.push({
      role: "user",
      content: `<compact_summary>\n${summary}\n</compact_summary>`,
    });
  }

  for (let i = 0; i < rest.length; i++) {
    const event = rest[i]!;
    if (event.type === "user") {
      messages.push({ role: "user", content: event.text });
      continue;
    }
    if (event.type === "assistant") {
      const toolCalls = [];
      let j = i + 1;
      while (j < rest.length && rest[j]?.type === "tool_call") {
        const call = rest[j]!;
        if (call.type === "tool_call") {
          toolCalls.push({ id: call.callId, name: call.name, arguments: call.arguments });
        }
        j++;
      }
      messages.push({
        role: "assistant",
        content: event.text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      });
      i = j - 1;
      continue;
    }
    if (event.type === "tool_result") {
      messages.push({
        role: "tool",
        toolCallId: event.callId,
        name: event.name,
        content: event.content,
        isError: event.isError,
      });
    }
    // skip session_meta, compact, plan, and unknown events
  }
  return messages;
}
