import { describe, expect, it } from "vitest";
import {
  collectJsonResult,
  encodeJsonResult,
  encodeStreamLine,
  formatEvalResults,
  formatSessionCompact,
  formatSessionCost,
  formatSessionFork,
  formatSessionDelete,
  formatSessionList,
  formatSessionRewind,
  formatSessionShow,
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

  it("formats session inspect, export, and delete", () => {
    const session = {
      id: "s1",
      timestamp: "t",
      cwd: "/tmp",
      model: "m",
      provider: "scripted",
      title: "hello",
      usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
      events: [
        {
          type: "session_meta" as const,
          id: "s1",
          timestamp: "t",
          cwd: "/tmp",
          model: "m",
          provider: "scripted",
        },
        { type: "user" as const, id: "u1", timestamp: "t", text: "hello" },
      ],
    };
    expect(formatSessionShow(session, "text")).toContain("user  t");
    expect(JSON.parse(formatSessionShow(session, "json"))).toMatchObject({ id: "s1", title: "hello" });
    expect(formatSessionDelete("s1", "text")).toBe("Deleted s1");
    expect(JSON.parse(formatSessionDelete("s1", "json"))).toEqual({ id: "s1", deleted: true });
    expect(formatSessionFork({ id: "s2", forkedFrom: "s1" }, "text")).toBe("Forked s1 -> s2");
    expect(JSON.parse(formatSessionFork({ id: "s2", forkedFrom: "s1" }, "json"))).toEqual({
      id: "s2",
      forkedFrom: "s1",
    });
    expect(formatSessionCost({ id: "s1", inputTokens: 10, outputTokens: 4, calls: 1 }, "text")).toContain("10 in / 4 out");
    expect(JSON.parse(formatSessionCost({ id: "s1", model: "gpt-4.1", inputTokens: 10, outputTokens: 4, calls: 1 }, "json"))).toMatchObject({
      id: "s1",
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(formatSessionRewind({ id: "s1", removed: 2 }, "text")).toBe("Rewound s1 (2 events removed)");
    expect(JSON.parse(formatSessionRewind({ id: "s1", removed: 2, untilEventId: "a1" }, "json"))).toEqual({
      id: "s1",
      removed: 2,
      untilEventId: "a1",
    });
    expect(formatSessionCompact({ id: "s1", summary: "did x" }, "text")).toBe("Compacted s1\ndid x");
    expect(JSON.parse(formatSessionCompact({ id: "s1", summary: "did x" }, "json"))).toEqual({
      id: "s1",
      summary: "did x",
    });
  });

  it("encodes eval results as a machine-readable report", () => {
    const rendered = formatEvalResults(
      [
        { name: "ok", ok: true, outputs: [] },
        { name: "bad", ok: false, error: "boom", outputs: [] },
      ],
      "text",
    );
    expect(rendered.stdout).toBe("PASS  ok");
    expect(rendered.stderr).toBe("FAIL  bad: boom");
    expect(JSON.parse(formatEvalResults([{ name: "ok", ok: true, outputs: [] }], "json").stdout)).toEqual({
      type: "eval",
      passed: 1,
      failed: 0,
      results: [{ name: "ok", ok: true, outputs: [] }],
    });
  });
});
