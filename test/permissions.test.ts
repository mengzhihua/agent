import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autoApprover, decidePermission, defaultDecision, denyApprover, parseApprovalAnswer, parseApprovalMode } from "../src/permissions/policy.js";
import { PermissionMemory, formatAllowList, matchesRule, parseAllowRules, ruleForCall } from "../src/permissions/allow.js";

describe("permissions", () => {
  it("allows reads without asking", () => {
    expect(defaultDecision("read", "ask")).toBe("allow");
    expect(defaultDecision("grep", "ask")).toBe("allow");
    expect(defaultDecision("glob", "ask")).toBe("allow");
  });

  it("asks for write, shell, and network unless auto", () => {
    expect(defaultDecision("apply_patch", "ask")).toBe("ask");
    expect(defaultDecision("shell", "ask")).toBe("ask");
    expect(defaultDecision("web_search", "ask")).toBe("ask");
    expect(defaultDecision("shell", "auto")).toBe("allow");
  });

  it("auto-allows workspace writes and shell when the sandbox is on", () => {
    expect(defaultDecision("apply_patch", "ask", { path: "a.ts" }, "bwrap")).toBe("allow");
    expect(defaultDecision("shell", "ask", { command: "ls" }, "bwrap")).toBe("allow");
    expect(defaultDecision("artifact", "ask", { action: "save", content: "x" }, "bwrap")).toBe("allow");
    expect(defaultDecision("web_search", "ask", { query: "x" }, "bwrap")).toBe("ask");
    expect(defaultDecision("browser", "ask", { action: "click", ref: "e1" }, "bwrap")).toBe("ask");
  });

  it("records deny from the approver", async () => {
    const result = await decidePermission("shell", { command: "rm -rf /" }, "ask", denyApprover());
    expect(result.decision).toBe("deny");
    expect(result.summary).toContain("rm -rf");
  });

  it("auto-approves in auto mode", async () => {
    const result = await decidePermission("apply_patch", { path: "a.ts" }, "auto", autoApprover());
    expect(result.decision).toBe("allow");
  });

  it("blocks mutating tools in plan mode", async () => {
    const result = await decidePermission("apply_patch", { path: "a.ts" }, "auto", autoApprover(), "plan");
    expect(result.decision).toBe("deny");
  });

  it("lets plan mode research the web but blocks saves and clicks", async () => {
    const fetchOk = await decidePermission(
      "web_fetch",
      { url: "http://127.0.0.1/docs" },
      "auto",
      autoApprover(),
      "plan",
    );
    expect(fetchOk.decision).toBe("allow");
    const save = await decidePermission(
      "web_fetch",
      { url: "http://127.0.0.1/docs", save: true },
      "auto",
      autoApprover(),
      "plan",
    );
    expect(save.decision).toBe("deny");
    const open = await decidePermission(
      "browser",
      { action: "open", url: "http://127.0.0.1/" },
      "auto",
      autoApprover(),
      "plan",
    );
    expect(open.decision).toBe("allow");
    const click = await decidePermission("browser", { action: "click", ref: "e1" }, "auto", autoApprover(), "plan");
    expect(click.decision).toBe("deny");
    const list = await decidePermission("artifact", { action: "list" }, "auto", autoApprover(), "plan");
    expect(list.decision).toBe("allow");
    const memoryGet = await decidePermission("memory", { action: "get" }, "auto", autoApprover(), "plan");
    expect(memoryGet.decision).toBe("allow");
    const memoryWrite = await decidePermission(
      "memory",
      { action: "append", scope: "project", text: "x" },
      "auto",
      autoApprover(),
      "plan",
    );
    expect(memoryWrite.decision).toBe("deny");
    const artifactSave = await decidePermission(
      "artifact",
      { action: "save", content: "x", filename: "x.txt" },
      "auto",
      autoApprover(),
      "plan",
    );
    expect(artifactSave.decision).toBe("deny");
  });

  it("auto-approves writes in edits mode but still asks for shell and network", () => {
    expect(defaultDecision("apply_patch", "edits", { path: "a.ts" })).toBe("allow");
    expect(defaultDecision("artifact", "edits", { action: "save", content: "x" })).toBe("allow");
    expect(defaultDecision("memory", "edits", { action: "append", text: "x" })).toBe("allow");
    expect(defaultDecision("web_fetch", "edits", { url: "http://127.0.0.1/", save: true })).toBe("allow");
    expect(defaultDecision("shell", "edits", { command: "ls" })).toBe("ask");
    expect(defaultDecision("web_search", "edits", { query: "x" })).toBe("ask");
    expect(defaultDecision("browser", "edits", { action: "click", ref: "e1" })).toBe("ask");
  });

  it("parses approval modes and prompt answers", () => {
    expect(parseApprovalMode("edits")).toBe("edits");
    expect(parseApprovalMode("accept-edits")).toBe("edits");
    expect(parseApprovalMode("acceptEdits")).toBe("edits");
    expect(parseApprovalMode("nope")).toBeUndefined();
    expect(parseApprovalAnswer("y")).toBe("allow");
    expect(parseApprovalAnswer("always")).toBe("always");
    expect(parseApprovalAnswer("s")).toBe("session");
    expect(parseApprovalAnswer("n")).toBe("deny");
  });

  it("remembers session and persisted shell prefixes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-allow-"));
    const file = path.join(dir, "permissions.json");
    const memory = PermissionMemory.empty(file);
    const session = await decidePermission(
      "shell",
      { command: "npm test" },
      "ask",
      async () => "session",
      "default",
      "none",
      undefined,
      memory,
    );
    expect(session.decision).toBe("allow");
    const again = await decidePermission(
      "shell",
      { command: "npm test --watch" },
      "ask",
      denyApprover(),
      "default",
      "none",
      undefined,
      memory,
    );
    expect(again.decision).toBe("allow");
    const other = await decidePermission(
      "shell",
      { command: "rm -rf /" },
      "ask",
      denyApprover(),
      "default",
      "none",
      undefined,
      memory,
    );
    expect(other.decision).toBe("deny");

    const persist = PermissionMemory.empty(file);
    await decidePermission(
      "apply_patch",
      { path: "a.ts" },
      "ask",
      async () => "always",
      "default",
      "none",
      undefined,
      persist,
    );
    const reloaded = PermissionMemory.load(dir);
    expect(reloaded.allows("apply_patch", { path: "b.ts" })).toBe(true);
    expect(parseAllowRules([{ tool: "shell", command: "npm test" }])).toEqual([{ tool: "shell", command: "npm test" }]);
    expect(matchesRule({ tool: "shell", command: "npm test" }, "shell", { command: "npm test --ci" })).toBe(true);
    expect(ruleForCall("shell", { command: " npm test " })).toEqual({ tool: "shell", command: "npm test" });
    expect(formatAllowList([{ tool: "shell", command: "npm test" }], "text", file)).toContain("shell  npm test");
    persist.clearPersisted();
    expect(PermissionMemory.load(dir).persisted).toEqual([]);
    expect(formatAllowList([], "text", file)).toContain("(no persisted allows)");
  });
});
