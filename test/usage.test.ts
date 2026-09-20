import { describe, expect, it } from "vitest";
import { capToolOutput, estimateUsd, formatUsageLine, sessionUsage } from "../src/usage.js";

describe("usage", () => {
  it("sums persisted usage events and estimates USD for known models", () => {
    const usage = sessionUsage(
      [
        { type: "usage", id: "1", timestamp: "t", inputTokens: 1000, outputTokens: 200 },
        { type: "user", id: "2", timestamp: "t", text: "hi" },
        { type: "usage", id: "3", timestamp: "t", inputTokens: 500, outputTokens: 50 },
      ],
      "gpt-4.1",
    );
    expect(usage).toMatchObject({ inputTokens: 1500, outputTokens: 250, calls: 2 });
    expect(usage.estimateUsd).toBeCloseTo((1500 * 2 + 250 * 8) / 1_000_000);
    expect(formatUsageLine(usage)).toContain("1500 in / 250 out");
    expect(formatUsageLine(usage)).toContain("~$");
    expect(estimateUsd("mystery-model", 100, 100)).toBeUndefined();
    expect(formatUsageLine({ inputTokens: 1, outputTokens: 2, calls: 1 })).toBe("tokens  1 in / 2 out");
  });

  it("caps tool output with a truncated marker", () => {
    const out = capToolOutput("abcdefghij", 4);
    expect(out).toContain("abcd");
    expect(out).toMatch(/truncated 6 chars/);
    expect(capToolOutput("short", 40)).toBe("short");
  });
});
