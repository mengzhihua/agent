import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSeaAsset } from "../sea.js";
import { packageRoot } from "../version.js";

export function loadConsoleHtml(): string {
  const embedded = getSeaAsset("console.html");
  if (embedded) return embedded;
  const here = (() => {
    try {
      const href = import.meta.url;
      if (typeof href === "string" && href.length > 0) return path.dirname(fileURLToPath(href));
    } catch {
      // SEA / missing import.meta
    }
    return undefined;
  })();
  const candidates = [
    here ? path.join(here, "console.html") : "",
    here ? path.join(here, "..", "web", "console.html") : "",
    packageRoot() ? path.join(packageRoot() as string, "src", "web", "console.html") : "",
    packageRoot() ? path.join(packageRoot() as string, "dist", "web", "console.html") : "",
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      // keep looking
    }
  }
  return "<!doctype html><title>agent</title><p>agent web console is missing from this build.</p>";
}
