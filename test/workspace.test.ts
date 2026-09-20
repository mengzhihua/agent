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

  it("keeps absolute paths that stay in the workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ws-abs-"));
    const file = path.join(root, "note.txt");
    expect(resolveInWorkspace(root, file)).toBe(path.resolve(file));
  });

  it("allows extra roots for sibling and absolute paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ws-"));
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "agent-extra-"));
    fs.writeFileSync(path.join(extra, "lib.ts"), "export const n = 1;\n");
    const abs = resolveInWorkspace(root, path.join(extra, "lib.ts"), [extra]);
    expect(abs).toBe(path.join(extra, "lib.ts"));
    const rel = path.relative(root, path.join(extra, "lib.ts"));
    expect(resolveInWorkspace(root, rel, [extra])).toBe(path.join(extra, "lib.ts"));
    expect(() => resolveInWorkspace(root, rel)).toThrow(/escapes workspace/);
    expect(toWorkspacePath(root, abs, [extra])).toBe(path.join(extra, "lib.ts").split(path.sep).join("/"));
  });
});
