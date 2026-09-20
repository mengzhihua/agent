import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { fileUriToLocalPath, injectAttachments, parseAtMentions } from "../src/context/attach.js";

describe("prompt attachments", () => {
  it("parses @path mentions and line ranges, not emails", () => {
    expect(parseAtMentions("see @src/cli.ts and @./readme.md:2-4")).toEqual([
      { path: "src/cli.ts" },
      { path: "./readme.md", startLine: 2, endLine: 4 },
    ]);
    expect(parseAtMentions("email me at user@example.com")).toEqual([]);
    expect(parseAtMentions("hi @sam look at @pkg.json")).toEqual([{ path: "pkg.json" }]);
    expect(fileUriToLocalPath("file:///tmp/note.txt").replaceAll("\\", "/")).toBe("/tmp/note.txt");
    expect(fileUriToLocalPath("file:///C:/Users/me/note.txt").replaceAll("\\", "/")).toBe("C:/Users/me/note.txt");
    expect(fileUriToLocalPath("file://C:/Users/me/note.txt").replaceAll("\\", "/")).toBe("C:/Users/me/note.txt");
    expect(fileUriToLocalPath("file://C:\\Users\\me\\note.txt").replaceAll("\\", "/")).toBe("C:/Users/me/note.txt");
    expect(fileUriToLocalPath("file://localhost/C:/Users/me/note.txt").replaceAll("\\", "/")).toBe("C:/Users/me/note.txt");
  });

  it("inlines workspace files and skips ignored or missing optional mentions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attach-"));
    fs.writeFileSync(path.join(dir, "keep.ts"), "KEEP_TOKEN\n");
    fs.writeFileSync(path.join(dir, "secret.txt"), "SECRET_TOKEN\n");
    fs.writeFileSync(path.join(dir, ".agentignore"), "secret.txt\n");
    const text = injectAttachments("explain @keep.ts and ping @nobody", { workspace: dir });
    expect(text).toContain("<attached_files>");
    expect(text).toContain("KEEP_TOKEN");
    expect(text).toContain('path="keep.ts"');
    expect(text).toContain("explain @keep.ts and ping @nobody");
    expect(text).not.toContain("SECRET_TOKEN");
    expect(injectAttachments("hi @nobody", { workspace: dir })).toBe("hi @nobody");
  });

  it("inlines file:// URIs that stay inside the workspace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attach-uri-"));
    const note = path.join(dir, "note.txt");
    fs.writeFileSync(note, "FROM_FILE_URI\n");
    const text = injectAttachments("review", {
      workspace: dir,
      extraFiles: [`file://${note}`, pathToFileURL(note).href],
    });
    expect(text).toContain("FROM_FILE_URI");
    expect(text).not.toContain("path escapes workspace");
  });

  it("attaches --file paths and ACP preloaded text, including missing explicit files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attach-file-"));
    fs.writeFileSync(path.join(dir, "a.ts"), "AAA\n");
    const text = injectAttachments("review", {
      workspace: dir,
      extraFiles: ["a.ts", "missing.ts"],
      preloaded: [{ path: "hint.ts", content: "PRELOADED" }],
    });
    expect(text).toContain("AAA");
    expect(text).toContain("PRELOADED");
    expect(text).toContain('error="not found"');
  });

  it("slices line ranges and refuses binary files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attach-range-"));
    fs.writeFileSync(path.join(dir, "lines.ts"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const ranged = injectAttachments("see @lines.ts:2-3", { workspace: dir });
    expect(ranged).toContain("two\nthree");
    expect(ranged).not.toContain("one\n");
    const binary = injectAttachments("see @blob.bin", { workspace: dir });
    expect(binary).toContain('error="binary file"');
  });
});
