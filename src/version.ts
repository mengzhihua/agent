import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
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
  const here = path.dirname(fileURLToPath(import.meta.url));
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
