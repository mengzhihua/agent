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

  it("records deny from the approver", async () => {
    const result = await decidePermission("shell", { command: "rm -rf /" }, "ask", denyApprover());
    expect(result.decision).toBe("deny");
    expect(result.summary).toContain("rm -rf");
  });

  it("auto-approves in auto mode", async () => {
    const result = await decidePermission("apply_patch", { path: "a.ts" }, "auto", autoApprover());
    expect(result.decision).toBe("allow");
  });
});
