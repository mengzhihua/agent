import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";

export interface HookSpec {
  matcher?: string;
  command: string;
}

export interface HookSet {
  PreToolUse: HookSpec[];
  PostToolUse: HookSpec[];
  Stop: HookSpec[];
}

export interface HookOutcome {
  decision: "allow" | "deny";
  reason?: string;
  append?: string;
  message?: string;
}

const EMPTY: HookSet = { PreToolUse: [], PostToolUse: [], Stop: [] };

export class HookRunner {
  constructor(
    private readonly hooks: HookSet,
    private readonly workspace: string,
  ) {}

  static load(workspace: string): HookRunner {
    return new HookRunner(loadHookSet(workspace), workspace);
  }

  static none(workspace: string): HookRunner {
    return new HookRunner(EMPTY, workspace);
  }

  async preToolUse(tool: string, args: unknown, signal: AbortSignal): Promise<HookOutcome> {
    const specs = this.matching("PreToolUse", tool);
    for (const spec of specs) {
      const result = await this.run(spec.command, { hook: "PreToolUse", tool, arguments: args }, signal);
      if (result.decision === "deny") return result;
    }
    return { decision: "allow" };
  }

  async postToolUse(
    tool: string,
    args: unknown,
    content: string,
    isError: boolean | undefined,
    signal: AbortSignal,
  ): Promise<HookOutcome> {
    const specs = this.matching("PostToolUse", tool);
    const notes: string[] = [];
    for (const spec of specs) {
      const result = await this.run(
        spec.command,
        { hook: "PostToolUse", tool, arguments: args, content, isError: Boolean(isError) },
        signal,
      );
      if (result.append) notes.push(result.append);
      if (result.message) notes.push(result.message);
    }
    return { decision: "allow", append: notes.length ? notes.join("\n") : undefined };
  }

  async stop(text: string, signal: AbortSignal): Promise<void> {
    for (const spec of this.hooks.Stop) {
      await this.run(spec.command, { hook: "Stop", text }, signal).catch(() => undefined);
    }
  }

  private matching(event: HookEvent, tool: string): HookSpec[] {
    return this.hooks[event].filter((spec) => matches(spec.matcher, tool));
  }

  private run(command: string, payload: unknown, signal: AbortSignal): Promise<HookOutcome> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: this.workspace,
        shell: true,
        signal,
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(parseHookOutput(stdout, stderr, code ?? 1));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ decision: "deny", reason: err.message });
      });
    });
  }
}

export function loadHookSet(workspace: string): HookSet {
  const file = path.join(workspace, ".agent", "hooks.json");
  if (!fs.existsSync(file)) return EMPTY;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HookSet>;
    return {
      PreToolUse: parsed.PreToolUse ?? [],
      PostToolUse: parsed.PostToolUse ?? [],
      Stop: parsed.Stop ?? [],
    };
  } catch {
    return EMPTY;
  }
}

function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return matcher === tool;
  }
}

function parseHookOutput(stdout: string, stderr: string, code: number): HookOutcome {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as HookOutcome;
      if (parsed.decision === "deny") return parsed;
      return { decision: "allow", append: parsed.append, message: parsed.message };
    } catch {
      // fall through
    }
  }
  if (code !== 0) {
    return { decision: "deny", reason: stderr.trim() || stdout.trim() || `hook exited ${code}` };
  }
  return { decision: "allow", append: trimmed || undefined };
}
