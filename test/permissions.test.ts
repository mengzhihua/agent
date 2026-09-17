import { describe, expect, it } from "vitest";
import { autoApprover, decidePermission, defaultDecision, denyApprover } from "../src/permissions/policy.js";

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
    const artifactSave = await decidePermission(
      "artifact",
      { action: "save", content: "x", filename: "x.txt" },
      "auto",
      autoApprover(),
      "plan",
    );
    expect(artifactSave.decision).toBe("deny");
  });
});
