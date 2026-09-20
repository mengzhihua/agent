import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../credentials.js";
import { newSessionId, nowIso } from "../ids.js";
import type { SessionEvent } from "../types.js";
import { sessionUsage, type SessionUsage } from "../usage.js";
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
    fs.appendFileSync(this.pathFor(sessionId), `${redactSecrets(JSON.stringify(event))}\n`, "utf8");
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

  delete(sessionId: string): void {
    const file = this.pathFor(sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  fork(sourceId: string, opts: { untilEventId?: string } = {}): { id: string; forkedFrom: string } {
    const events = this.read(sourceId);
    let copied = events;
    if (opts.untilEventId) {
      const idx = events.findIndex((event) => "id" in event && event.id === opts.untilEventId);
      if (idx === -1) throw new Error(`event not found: ${opts.untilEventId}`);
      copied = events.slice(0, idx + 1);
    }
    const meta = copied.find((event) => event.type === "session_meta");
    if (!meta || meta.type !== "session_meta") {
      throw new Error(`session not found: ${sourceId}`);
    }
    const id = newSessionId();
    this.create({
      ...meta,
      id,
      timestamp: nowIso(),
      forkedFrom: sourceId,
    });
    for (const event of copied) {
      if (event.type === "session_meta") continue;
      this.append(id, event);
    }
    return { id, forkedFrom: sourceId };
  }

  inspect(sessionId: string): SessionInspect {
    const events = this.read(sessionId);
    const meta = events.find((event) => event.type === "session_meta");
    if (!meta || meta.type !== "session_meta") {
      throw new Error(`session not found: ${sessionId}`);
    }
    const last = events.at(-1);
    const firstUser = events.find((event) => event.type === "user");
    return {
      id: sessionId,
      timestamp: last?.timestamp ?? meta.timestamp,
      cwd: meta.cwd,
      model: meta.model,
      provider: meta.provider,
      title: firstUser && firstUser.type === "user" ? sessionTitle(firstUser.text) : undefined,
      forkedFrom: meta.forkedFrom,
      usage: sessionUsage(events, meta.model),
      events,
    };
  }

  list(): SessionListRow[] {
    ensureDir(this.dir);
    const files = fs.readdirSync(this.dir).filter((name) => name.endsWith(".jsonl"));
    const rows: SessionListRow[] = [];
    for (const file of files) {
      const id = file.slice(0, -".jsonl".length);
      try {
        const events = this.read(id);
        const meta = events.find((event) => event.type === "session_meta");
        const last = events.at(-1);
        const firstUser = events.find((event) => event.type === "user");
        if (meta && meta.type === "session_meta") {
          rows.push({
            id,
            timestamp: last?.timestamp ?? meta.timestamp,
            cwd: meta.cwd,
            model: meta.model,
            title: firstUser && firstUser.type === "user" ? sessionTitle(firstUser.text) : undefined,
            forkedFrom: meta.forkedFrom,
          });
        }
      } catch {
        // skip corrupt transcripts
      }
    }
    return rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
}

export interface SessionListRow {
  id: string;
  timestamp: string;
  cwd: string;
  model: string;
  title?: string;
  forkedFrom?: string;
}

export interface SessionInspect {
  id: string;
  timestamp: string;
  cwd: string;
  model: string;
  provider: string;
  title?: string;
  forkedFrom?: string;
  usage: SessionUsage;
  events: SessionEvent[];
}

export function sessionTitle(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  if (line.length <= 80) return line;
  return `${line.slice(0, 79)}…`;
}
