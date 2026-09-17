import fs from "node:fs";
import path from "node:path";
import { agentHome } from "../config.js";
import { truncate } from "../workspace.js";

export interface Skill {
  name: string;
  description: string;
  dir: string;
  bodyPath: string;
}

export class SkillIndex {
  constructor(private readonly skills: Skill[]) {}

  all(): Skill[] {
    return this.skills;
  }

  get(name: string): Skill | undefined {
    return this.skills.find((skill) => skill.name === name);
  }

  catalog(budget = 8000): string {
    if (this.skills.length === 0) return "";
    const lines = this.skills.map((skill) => `- ${skill.name}: ${skill.description}`);
    let text = lines.join("\n");
    if (text.length > budget) {
      text = truncate(text, budget);
    }
    return [
      "## Skills",
      "When a task matches a skill, call the skill tool with its name to load the full instructions.",
      "You can also load a skill if the user writes $name or /name.",
      text,
    ].join("\n");
  }

  body(name: string): string {
    const skill = this.get(name);
    if (!skill) {
      const available = this.skills.map((item) => item.name).join(", ") || "(none)";
      throw new Error(`unknown skill: ${name}. Available: ${available}`);
    }
    return fs.readFileSync(skill.bodyPath, "utf8");
  }
}

export function parseSkillMd(raw: string, fallbackName: string): { name: string; description: string; body: string } {
  if (!raw.startsWith("---")) {
    return { name: fallbackName, description: fallbackName, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end < 0) {
    return { name: fallbackName, description: fallbackName, body: raw };
  }
  const front = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");
  const fields: Record<string, string> = {};
  for (const line of front.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return {
    name: (fields.name || fallbackName).toLowerCase(),
    description: fields.description || fallbackName,
    body,
  };
}

function loadDir(dir: string, into: Map<string, Skill>): void {
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bodyPath = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(bodyPath)) continue;
    try {
      const parsed = parseSkillMd(fs.readFileSync(bodyPath, "utf8"), entry.name);
      into.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        dir: path.join(dir, entry.name),
        bodyPath,
      });
    } catch {
      // skip unreadable skills
    }
  }
}

export function loadSkills(workspace: string): SkillIndex {
  const map = new Map<string, Skill>();
  loadDir(path.join(agentHome(), "skills"), map);
  loadDir(path.join(workspace, ".agents", "skills"), map);
  loadDir(path.join(workspace, ".agent", "skills"), map);
  return new SkillIndex([...map.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

export function skillsMentionedIn(text: string, skills: SkillIndex): Skill[] {
  const loaded: Skill[] = [];
  for (const skill of skills.all()) {
    if (text.includes(`$${skill.name}`) || text.includes(`/${skill.name}`)) {
      loaded.push(skill);
    }
  }
  return loaded;
}

export function injectExplicitSkills(text: string, skills: SkillIndex): string {
  const mentioned = skillsMentionedIn(text, skills);
  if (mentioned.length === 0) return text;
  const blocks = mentioned.map((skill) => `# ${skill.name}\n${skills.body(skill.name)}`).join("\n\n");
  return `<loaded_skills>\n${blocks}\n</loaded_skills>\n\n${text}`;
}
