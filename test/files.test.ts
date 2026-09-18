import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diskFileIo, formatNumbered } from "../src/files/io.js";
import { createAcpFileIo, parseClientCapabilities } from "../src/protocol/fs.js";
import { applyPatchTool } from "../src/tools/apply_patch.js";
import { readFileTool } from "../src/tools/read.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-files-"));
}

describe("disk FileIo", () => {
  it("reads and writes inside the workspace", async () => {
    const root = tmp();
    const io = diskFileIo(root);
    await io.writeText("a.txt", "hello");
    await expect(io.readText("a.txt")).resolves.toEqual({ content: "hello", existed: true });
    await expect(io.readText("missing.txt")).resolves.toEqual({ content: "", existed: false });
  });

  it("rejects paths that escape the workspace", async () => {
    const io = diskFileIo(tmp());
    await expect(io.readText("../secret")).rejects.toThrow(/escapes workspace/);
  });
});

describe("ACP FileIo", () => {
  it("falls back to disk when a capability is off", async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "a.txt"), "disk");
    const io = createAcpFileIo({
      workspace: root,
      sessionId: "s1",
      caps: parseClientCapabilities({}),
      request: async () => {
        throw new Error("should not call client fs");
      },
    });
    await expect(readFileTool(root, "a.txt", undefined, undefined, io)).resolves.toMatch(/disk/);
  });

  it("patches via client write without touching disk", async () => {
    const root = tmp();
    const diskPath = path.join(root, "a.txt");
    fs.writeFileSync(diskPath, "foo");
    let written = "";
    const io = createAcpFileIo({
      workspace: root,
      sessionId: "s1",
      caps: { readTextFile: true, writeTextFile: true },
      request: async (method, params) => {
        const row = params as { content?: string };
        if (method === "fs/read_text_file") return { content: "foo" };
        if (method === "fs/write_text_file") {
          written = String(row.content ?? "");
          return null;
        }
        throw new Error(method);
      },
    });
    const patched = await applyPatchTool(root, "a.txt", { old_string: "foo", new_string: "bar" }, io);
    expect(patched.summary).toMatch(/updated/);
    expect(patched.oldText).toBe("foo");
    expect(patched.newText).toBe("bar");
    expect(written).toBe("bar");
    expect(fs.readFileSync(diskPath, "utf8")).toBe("foo");
  });
});

describe("formatNumbered", () => {
  it("keeps 1-based line numbers after an offset", () => {
    const root = tmp();
    const out = formatNumbered(root, "a.txt", "a\nb\nc\n", 2, 2);
    expect(out).toMatch(/2\|b/);
    expect(out).toMatch(/3\|c/);
    expect(out).not.toMatch(/1\|a/);
  });
});
