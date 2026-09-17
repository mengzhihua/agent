import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInWorkspace, toWorkspacePath } from "../src/workspace.js";

describe("workspace paths", () => {
  it("resolves files inside the root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ws-"));
    const abs = resolveInWorkspace(root, "src/a.ts");
    expect(abs).toBe(path.join(root, "src/a.ts"));
    expect(toWorkspacePath(root, abs)).toBe("src/a.ts");
  });

  it("rejects path escape", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ws-"));
    expect(() => resolveInWorkspace(root, "../secret")).toThrow(/escapes workspace/);
  });
});
