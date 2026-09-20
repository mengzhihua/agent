import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sourceDir(): string | undefined {
  const href = import.meta.url;
  if (typeof href !== "string" || href.length === 0) return undefined;
  try {
    return path.dirname(fileURLToPath(href));
  } catch {
    return undefined;
  }
}

export function packageVersion(): string {
  const embedded = process.env.AGENT_EMBEDDED_VERSION?.trim();
  if (embedded) return embedded;
  const here = sourceDir();
  if (!here) return "0.0.0";
  for (const candidate of [path.join(here, "..", "package.json"), path.join(here, "../..", "package.json")]) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (raw.name === "agent" && typeof raw.version === "string") return raw.version;
    } catch {
      // keep looking
    }
  }
  return "0.0.0";
}

export function packageRoot(): string | undefined {
  if (process.env.AGENT_EMBEDDED_VERSION) return undefined;
  const here = sourceDir();
  if (!here) return undefined;
  for (const candidate of [path.join(here, ".."), path.join(here, "../..")]) {
    const pkg = path.join(candidate, "package.json");
    try {
      const raw = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
      if (raw.name === "agent") return path.resolve(candidate);
    } catch {
      // keep looking
    }
  }
  return undefined;
}
