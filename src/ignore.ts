import fs from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "target/",
  ".env",
  ".env.*",
];

export const RG_SKIP_GLOBS = [
  "!.git/**",
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/coverage/**",
  "!**/.venv/**",
  "!**/venv/**",
  "!**/__pycache__/**",
  "!**/target/**",
];

export interface IgnoreRule {
  negated: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

export class IgnoreMatcher {
  constructor(readonly rules: IgnoreRule[]) {}

  get hasNegation(): boolean {
    return this.rules.some((rule) => rule.negated);
  }

  ignores(relPosix: string, isDir = false): boolean {
    const rel = normalizeRel(relPosix);
    if (!rel || rel === ".") return false;
    const parts = rel.split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
      const last = i === parts.length - 1;
      if (!last && this.matches(acc, true)) return true;
      if (last) return this.matches(acc, isDir);
    }
    return false;
  }

  ignoresDir(relPosix: string): boolean {
    return this.ignores(relPosix, true);
  }

  private matches(rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDir) continue;
      if (rule.regex.test(rel)) ignored = !rule.negated;
    }
    return ignored;
  }
}

export function parseIgnoreLine(raw: string): IgnoreRule | undefined {
  let line = raw.trim();
  if (!line || line.startsWith("#")) return undefined;
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }
  if (line.startsWith("\\")) line = line.slice(1);
  let directoryOnly = false;
  if (line.endsWith("/")) {
    directoryOnly = true;
    line = line.slice(0, -1);
  }
  let anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  if (line.includes("/")) anchored = true;
  if (!line) return undefined;
  return { negated, directoryOnly, regex: globToIgnoreRegex(line, anchored) };
}

export function loadIgnoreMatcher(root: string): IgnoreMatcher {
  const lines = [...DEFAULT_IGNORE_PATTERNS];
  for (const name of [".gitignore", ".ignore", ".agentignore"]) {
    const file = path.join(root, name);
    try {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      lines.push(...fs.readFileSync(file, "utf8").split(/\r?\n/));
    } catch {
      // skip unreadable ignore files
    }
  }
  return new IgnoreMatcher(lines.map(parseIgnoreLine).filter((rule): rule is IgnoreRule => Boolean(rule)));
}

export function agentIgnoreFile(root: string): string | undefined {
  const file = path.join(root, ".agentignore");
  return fs.existsSync(file) ? file : undefined;
}

export function normalizeGlobPattern(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/");
  if (!normalized.includes("/")) return `**/${normalized}`;
  return normalized;
}

function globToIgnoreRegex(glob: string, anchored: boolean): RegExp {
  let regex = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      const afterSlash = glob[i + 2] === "/";
      regex += afterSlash ? "(?:.*/)?" : ".*";
      i += afterSlash ? 2 : 1;
    } else if (ch === "*") {
      regex += "[^/]*";
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }
  const body = anchored ? `^${regex}(?:/.*)?$` : `(?:^|/)${regex}(?:/.*)?$`;
  return new RegExp(body);
}

function normalizeRel(relPosix: string): string {
  return relPosix.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
