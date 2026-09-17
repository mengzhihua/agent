import fs from "node:fs";
import path from "node:path";
import type { SessionEvent } from "../types.js";
import { ensureDir } from "../workspace.js";

export class SessionStore {
  constructor(private readonly dir: string) {
    ensureDir(dir);
  }

  pathFor(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  exists(sessionId: string): boolean {
    return fs.existsSync(this.pathFor(sessionId));
  }

  create(meta: Extract<SessionEvent, { type: "session_meta" }>): void {
    if (this.exists(meta.id)) {
      throw new Error(`session already exists: ${meta.id}`);
    }
    this.append(meta.id, meta);
  }

  append(sessionId: string, event: SessionEvent): void {
    ensureDir(this.dir);
    fs.appendFileSync(this.pathFor(sessionId), `${JSON.stringify(event)}\n`, "utf8");
  }

  read(sessionId: string): SessionEvent[] {
    const file = this.pathFor(sessionId);
    if (!fs.existsSync(file)) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const raw = fs.readFileSync(file, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionEvent);
  }

  list(): { id: string; timestamp: string; cwd: string; model: string }[] {
    ensureDir(this.dir);
    const files = fs.readdirSync(this.dir).filter((name) => name.endsWith(".jsonl"));
    const rows = [];
    for (const file of files) {
      const id = file.slice(0, -".jsonl".length);
      try {
        const events = this.read(id);
        const meta = events.find((event) => event.type === "session_meta");
        const last = events.at(-1);
        if (meta && meta.type === "session_meta") {
          rows.push({
            id,
            timestamp: last?.timestamp ?? meta.timestamp,
            cwd: meta.cwd,
            model: meta.model,
          });
        }
      } catch {
        // skip corrupt transcripts
      }
    }
    return rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
}
