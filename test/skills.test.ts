import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgentsMd } from "../src/context/agents-md.js";
import { injectExplicitSkills, loadSkills, parseSkillMd } from "../src/context/skills.js";
import { loadConfig } from "../src/config.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { ToolRegistry } from "../src/tools/registry.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/skills-project");

describe("skills and AGENTS.md", () => {
  it("parses SKILL.md frontmatter", () => {
    const parsed = parseSkillMd("---\nname: foo\ndescription: bar baz\n---\nbody\n", "dir");
    expect(parsed).toEqual({ name: "foo", description: "bar baz", body: "body\n" });
  });

  it("loads project skills and AGENTS.md into the system prompt", () => {
    const skills = loadSkills(fixture);
    expect(skills.get("hello")?.description).toMatch(/Greet/);
    expect(skills.body("hello")).toContain("hello-from-skill");
    const agents = loadAgentsMd(fixture);
    expect(agents).toContain("hello skill");
    const prompt = buildSystemPrompt(loadConfig({ workspace: fixture }), skills);
    expect(prompt).toContain("Project instructions");
    expect(prompt).toContain("- hello:");
  });

  it("injects $skill-name into the user turn", () => {
    const skills = loadSkills(fixture);
    const text = injectExplicitSkills("please $hello now", skills);
    expect(text).toContain("hello-from-skill");
    expect(text).toContain("please $hello now");
  });

  it("keeps builtin tool order stable and appends MCP-style extras last", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-"));
    const config = loadConfig({ workspace: dir, provider: "scripted" });
    const registry = ToolRegistry.create(config, {
      extraHandlers: [
        {
          definition: {
            name: "mcp__z__b",
            description: "b",
            risk: "exec",
            parameters: { type: "object", properties: {} },
          },
          execute: async () => "b",
        },
        {
          definition: {
            name: "mcp__a__a",
            description: "a",
            risk: "exec",
            parameters: { type: "object", properties: {} },
          },
          execute: async () => "a",
        },
      ],
    });
    expect(registry.names()).toEqual([
      "read",
      "grep",
      "glob",
      "apply_patch",
      "shell",
      "web_search",
      "web_fetch",
      "browser",
      "artifact",
      "ask_user",
      "memory",
      "skill",
      "update_plan",
      "task",
      "mcp__a__a",
      "mcp__z__b",
    ]);
  });
});
