import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/session/store.js";
import { assembleMessages } from "../src/loop/assemble.js";

describe("session store", () => {
  it("appends JSONL and lists sessions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sess-"));
    const store = new SessionStore(dir);
    store.create({
      type: "session_meta",
      id: "s1",
      timestamp: "2026-09-17T00:00:00.000Z",
      cwd: "/tmp",
      model: "test",
      provider: "scripted",
    });
    store.append("s1", { type: "user", id: "u1", timestamp: "2026-09-17T00:00:01.000Z", text: "hello" });
    expect(store.read("s1")).toHaveLength(2);
    expect(store.list()[0]).toMatchObject({ id: "s1", title: "hello" });
    expect(store.inspect("s1")).toMatchObject({
      id: "s1",
      cwd: "/tmp",
      model: "test",
      provider: "scripted",
      title: "hello",
    });
    expect(store.inspect("s1").events).toHaveLength(2);
    store.delete("s1");
    expect(store.exists("s1")).toBe(false);
    expect(store.list()).toEqual([]);
    store.delete("s1");
    expect(() => store.inspect("s1")).toThrow(/session not found/);
  });
});

describe("assembleMessages", () => {
  it("groups tool calls onto the assistant message", () => {
    const messages = assembleMessages([
      { type: "user", id: "1", timestamp: "t", text: "fix it" },
      { type: "assistant", id: "2", timestamp: "t", text: "looking" },
      { type: "tool_call", id: "3", timestamp: "t", callId: "c1", name: "read", arguments: { path: "a.ts" } },
      { type: "tool_result", id: "4", timestamp: "t", callId: "c1", name: "read", content: "ok" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "looking",
        toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.ts" } }],
      },
      { role: "tool", toolCallId: "c1", name: "read", content: "ok", isError: undefined },
    ]);
  });

  it("starts from the latest compact summary", () => {
    const messages = assembleMessages([
      { type: "user", id: "1", timestamp: "t", text: "old" },
      { type: "compact", id: "2", timestamp: "t", summary: "did x" },
      { type: "user", id: "3", timestamp: "t", text: "continue" },
    ]);
    expect(messages[0]).toEqual({
      role: "user",
      content: "<compact_summary>\ndid x\n</compact_summary>",
    });
    expect(messages.at(-1)).toEqual({ role: "user", content: "continue" });
  });
});
