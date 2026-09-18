import { describe, expect, it } from "vitest";
import {
  collectJsonResult,
  encodeJsonResult,
  encodeStreamLine,
  formatSessionList,
  parseOutputFormat,
} from "../src/output.js";
import type { LoopEvent } from "../src/types.js";

describe("output format", () => {
  it("parses text, json, and stream-json", () => {
    expect(parseOutputFormat("")).toBe("text");
    expect(parseOutputFormat("text")).toBe("text");
    expect(parseOutputFormat("JSON")).toBe("json");
    expect(parseOutputFormat("ndjson")).toBe("stream-json");
    expect(parseOutputFormat("stream_json")).toBe("stream-json");
    expect(() => parseOutputFormat("yaml")).toThrow(/text\|json\|stream-json/);
  });

  it("collects a machine-readable turn result", () => {
    const events: LoopEvent[] = [
      { type: "text-delta", text: "hi" },
      { type: "tool-start", callId: "c1", name: "read", arguments: { path: "a.ts" } },
      { type: "tool-end", callId: "c1", name: "read", content: "ok" },
      { type: "usage", inputTokens: 10, outputTokens: 4 },
      { type: "turn-end", text: "hi" },
    ];
    const result = collectJsonResult("sess_1", events);
    expect(result).toEqual({
      type: "result",
      sessionId: "sess_1",
      text: "hi",
      isError: false,
      aborted: false,
      tools: [{ callId: "c1", name: "read", isError: undefined }],
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    expect(JSON.parse(encodeJsonResult(result)).text).toBe("hi");
    expect(JSON.parse(encodeStreamLine("sess_1", events[0]!))).toMatchObject({
      sessionId: "sess_1",
      type: "text-delta",
      text: "hi",
    });
  });

  it("marks abort and error without treating a denied tool as a failed turn", () => {
    expect(
      collectJsonResult("s", [
        { type: "tool-end", callId: "c1", name: "shell", content: "denied", isError: true },
        { type: "turn-end", text: "did not run it" },
      ]),
    ).toMatchObject({ isError: false, aborted: false, text: "did not run it" });
    expect(collectJsonResult("s", [{ type: "error", message: "boom" }]).isError).toBe(true);
    expect(collectJsonResult("s", [{ type: "aborted" }]).aborted).toBe(true);
  });

  it("formats session lists", () => {
    expect(formatSessionList([], "text")).toBe("No sessions.");
    expect(JSON.parse(formatSessionList([], "json"))).toEqual([]);
    expect(
      formatSessionList(
        [{ id: "s1", timestamp: "t", cwd: "/tmp", model: "m", title: "hello" }],
        "text",
      ),
    ).toContain("s1");
  });
});
