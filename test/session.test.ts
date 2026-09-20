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
    expect(store.inspect("s1").usage).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0 });
    store.delete("s1");
    expect(store.exists("s1")).toBe(false);
    expect(store.list()).toEqual([]);
    store.delete("s1");
    expect(() => store.inspect("s1")).toThrow(/session not found/);
  });

  it("forks a transcript without mutating the source", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fork-"));
    const store = new SessionStore(dir);
    store.create({
      type: "session_meta",
      id: "s1",
      timestamp: "2026-09-20T00:00:00.000Z",
      cwd: dir,
      model: "test",
      provider: "scripted",
    });
    store.append("s1", { type: "user", id: "u1", timestamp: "2026-09-20T00:00:01.000Z", text: "hello" });
    store.append("s1", { type: "assistant", id: "a1", timestamp: "2026-09-20T00:00:02.000Z", text: "hi" });
    store.append("s1", { type: "user", id: "u2", timestamp: "2026-09-20T00:00:03.000Z", text: "later" });
    const forked = store.fork("s1", { untilEventId: "a1" });
    expect(forked.forkedFrom).toBe("s1");
    expect(forked.id).not.toBe("s1");
    const child = store.read(forked.id);
    expect(child[0]).toMatchObject({ type: "session_meta", id: forked.id, forkedFrom: "s1" });
    expect(child.map((event) => event.type)).toEqual(["session_meta", "user", "assistant"]);
    expect(assembleMessages(child).at(-1)).toMatchObject({ role: "assistant", content: "hi" });
    expect(store.read("s1")).toHaveLength(4);
    store.append(forked.id, { type: "user", id: "u3", timestamp: "2026-09-20T00:00:04.000Z", text: "branch" });
    expect(store.read("s1").some((event) => event.type === "user" && event.text === "branch")).toBe(false);
    expect(store.inspect(forked.id).forkedFrom).toBe("s1");
    expect(() => store.fork("missing")).toThrow(/session not found/);
  });

  it("rewinds the last user turn and finds the latest session for a cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-other-"));
    const store = new SessionStore(dir);
    store.create({
      type: "session_meta",
      id: "s1",
      timestamp: "2026-09-20T00:00:00.000Z",
      cwd: dir,
      model: "test",
      provider: "scripted",
    });
    store.append("s1", { type: "user", id: "u1", timestamp: "2026-09-20T00:00:01.000Z", text: "hello" });
    store.append("s1", { type: "assistant", id: "a1", timestamp: "2026-09-20T00:00:02.000Z", text: "hi" });
    store.append("s1", { type: "user", id: "u2", timestamp: "2026-09-20T00:00:03.000Z", text: "later" });
    store.append("s1", { type: "assistant", id: "a2", timestamp: "2026-09-20T00:00:04.000Z", text: "ok" });
    const dropped = store.rewind("s1");
    expect(dropped).toMatchObject({ id: "s1", removed: 2 });
    expect(store.read("s1").map((event) => event.type)).toEqual(["session_meta", "user", "assistant"]);
    const until = store.rewind("s1", { untilEventId: "u1" });
    expect(until.removed).toBe(1);
    expect(store.read("s1").map((event) => ("id" in event ? event.id : "")).filter(Boolean)).toEqual(["s1", "u1"]);
    expect(store.rewind("s1")).toMatchObject({ id: "s1", removed: 1 });
    expect(store.read("s1").map((event) => event.type)).toEqual(["session_meta"]);
    expect(() => store.rewind("s1")).toThrow(/nothing to rewind/);
    store.create({
      type: "session_meta",
      id: "s2",
      timestamp: "2026-09-20T00:00:05.000Z",
      cwd: other,
      model: "test",
      provider: "scripted",
    });
    store.append("s2", { type: "user", id: "u3", timestamp: "2026-09-20T00:00:06.000Z", text: "elsewhere" });
    expect(store.latest({ cwd: dir })?.id).toBe("s1");
    expect(store.latest({ cwd: other })?.id).toBe("s2");
    expect(store.latest()?.id).toBe("s2");
    expect(store.latest({ cwd: "/no/such" })).toBeUndefined();
    expect(() => store.rewind("missing")).toThrow(/session not found/);
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
