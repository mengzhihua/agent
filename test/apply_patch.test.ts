import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchTool } from "../src/tools/apply_patch.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-patch-"));
}

describe("apply_patch", () => {
  it("creates a new file", async () => {
    const root = tmpWorkspace();
    const result = await applyPatchTool(root, "hello.txt", { new_string: "hi\n" });
    expect(result).toMatch(/created/);
    expect(fs.readFileSync(path.join(root, "hello.txt"), "utf8")).toBe("hi\n");
  });

  it("replaces a unique string", async () => {
    const root = tmpWorkspace();
    fs.writeFileSync(path.join(root, "a.txt"), "foo bar foo");
    await expect(
      applyPatchTool(root, "a.txt", { old_string: "foo bar foo", new_string: "baz" }),
    ).resolves.toMatch(/updated/);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("baz");
  });

  it("rejects non-unique old_string", async () => {
    const root = tmpWorkspace();
    fs.writeFileSync(path.join(root, "a.txt"), "foo\nfoo\n");
    await expect(applyPatchTool(root, "a.txt", { old_string: "foo", new_string: "bar" })).rejects.toThrow(
      /matched 2 times/,
    );
  });

  it("rejects create when file exists", async () => {
    const root = tmpWorkspace();
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    await expect(applyPatchTool(root, "a.txt", { new_string: "y" })).rejects.toThrow(/already exists/);
  });
});
