import { describe, expect, it } from "vitest";
import { changelogSection } from "../scripts/pack-release.mjs";

describe("release notes", () => {
  it("keeps only the matching version section", () => {
    const notes = changelogSection("# Changelog\n\n## 0.35.0\n\n- permissions\n\n## 0.34.0\n\n- edits\n", "0.35.0");
    expect(notes).toBe("- permissions");
    expect(changelogSection("# Changelog\n", "0.35.0")).toBe("");
  });
});
