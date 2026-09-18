import type { RequestFn } from "./rpc.js";

export interface TerminalExit {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalOutput {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExit;
}

export interface AcpTerminal {
  create(input: { command: string; args: string[]; cwd: string; outputByteLimit: number }): Promise<string>;
  output(terminalId: string): Promise<TerminalOutput>;
  waitForExit(terminalId: string): Promise<TerminalExit>;
  kill(terminalId: string): Promise<void>;
  release(terminalId: string): Promise<void>;
}

export function clientTerminalEnabled(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const caps = (params as Record<string, unknown>).clientCapabilities;
  if (!caps || typeof caps !== "object") return false;
  return (caps as Record<string, unknown>).terminal === true;
}

export function createAcpTerminal(sessionId: string, request: RequestFn): AcpTerminal {
  return {
    async create(input) {
      const raw = await request("terminal/create", { sessionId, ...input });
      const id = asId(raw);
      if (!id) throw new Error("terminal/create returned no terminalId");
      return id;
    },
    async output(terminalId) {
      const raw = await request("terminal/output", { sessionId, terminalId });
      return asOutput(raw);
    },
    async waitForExit(terminalId) {
      const raw = await request("terminal/wait_for_exit", { sessionId, terminalId });
      return asExit(raw);
    },
    async kill(terminalId) {
      await request("terminal/kill", { sessionId, terminalId });
    },
    async release(terminalId) {
      await request("terminal/release", { sessionId, terminalId });
    },
  };
}

function asId(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw) return raw;
  if (raw && typeof raw === "object" && typeof (raw as { terminalId?: unknown }).terminalId === "string") {
    return (raw as { terminalId: string }).terminalId;
  }
  return undefined;
}

function asExit(raw: unknown): TerminalExit {
  if (!raw || typeof raw !== "object") return { exitCode: null, signal: null };
  const row = raw as { exitCode?: unknown; signal?: unknown; exitStatus?: unknown };
  if (row.exitStatus && typeof row.exitStatus === "object") {
    return asExit(row.exitStatus);
  }
  return {
    exitCode: typeof row.exitCode === "number" ? row.exitCode : null,
    signal: typeof row.signal === "string" ? row.signal : null,
  };
}

function asOutput(raw: unknown): TerminalOutput {
  if (typeof raw === "string") return { output: raw, truncated: false };
  if (!raw || typeof raw !== "object") return { output: "", truncated: false };
  const row = raw as { output?: unknown; truncated?: unknown; exitStatus?: unknown };
  return {
    output: typeof row.output === "string" ? row.output : "",
    truncated: row.truncated === true,
    exitStatus: row.exitStatus ? asExit(row.exitStatus) : undefined,
  };
}
