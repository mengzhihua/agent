import { spawn } from "node:child_process";
import type { AcpTerminal } from "../protocol/terminal.js";
import { planShell } from "../sandbox/plan.js";
import type { AgentConfig } from "../types.js";
import { resolveInWorkspace, truncate } from "../workspace.js";

export interface ShellRunOptions {
  terminal?: AcpTerminal;
  onTerminal?: (terminalId: string) => void;
  extraRoots?: string[];
}

export async function shellTool(
  config: AgentConfig,
  command: string,
  relCwd: string | undefined,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  extras: ShellRunOptions = {},
): Promise<string> {
  const extraRoots = extras.extraRoots ?? [];
  const cwd = relCwd ? resolveInWorkspace(config.workspace, relCwd, extraRoots) : config.workspace;
  const timeout = timeoutMs ?? config.shellTimeoutMs;
  if (extras.terminal) {
    return runViaClientTerminal(config, command, cwd, timeout, signal, extras.terminal, extras.onTerminal);
  }
  return runLocal(config, command, cwd, timeout, signal, extraRoots);
}

async function runLocal(
  config: AgentConfig,
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
  extraRoots: string[] = [],
): Promise<string> {
  const plan = planShell(config, command, cwd, extraRoots);
  const child = spawn(plan.file, plan.args, {
    cwd: plan.cwd,
    shell: plan.shell,
    signal,
    env: plan.env,
  });

  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeout);

  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode));
  }).finally(() => clearTimeout(timer));

  const out = formatShell(cwd, plan.backend, code, stdout, stderr, config.shellOutputLimit);
  if (code !== 0) throw new Error(out);
  return out;
}

async function runViaClientTerminal(
  config: AgentConfig,
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
  terminal: AcpTerminal,
  onTerminal?: (terminalId: string) => void,
): Promise<string> {
  const shell = process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/sh";
  const terminalId = await terminal.create({
    command: shell,
    args: ["-c", command],
    cwd,
    outputByteLimit: config.shellOutputLimit,
  });
  onTerminal?.(terminalId);

  let outcome: "exit" | "timeout" | "abort" = "exit";
  try {
    const raced = await raceTerminal(terminal, terminalId, timeout, signal);
    outcome = raced.type;
    if (raced.type !== "exit") {
      await terminal.kill(terminalId).catch(() => undefined);
    }
    const snap = await terminal.output(terminalId);
    const code = snap.exitStatus?.exitCode ?? (raced.type === "exit" ? raced.exit.exitCode : null);
    const out = formatShell(cwd, "client-terminal", code, snap.output, "", config.shellOutputLimit);
    if (outcome === "timeout") throw new Error(`${out}\n(timeout)`);
    if (outcome === "abort" || code !== 0) throw new Error(out);
    return out;
  } finally {
    await terminal.release(terminalId).catch(() => undefined);
  }
}

function raceTerminal(
  terminal: AcpTerminal,
  terminalId: string,
  timeout: number,
  signal: AbortSignal,
): Promise<{ type: "exit"; exit: { exitCode: number | null; signal: string | null } } | { type: "timeout" } | { type: "abort" }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: { type: "exit"; exit: { exitCode: number | null; signal: string | null } } | { type: "timeout" } | { type: "abort" }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ type: "timeout" }), timeout);
    const onAbort = () => finish({ type: "abort" });
    if (signal.aborted) {
      finish({ type: "abort" });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    terminal.waitForExit(terminalId).then(
      (exit) => finish({ type: "exit", exit }),
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      },
    );
  });
}

function formatShell(
  cwd: string,
  sandbox: string,
  code: number | null,
  stdout: string,
  stderr: string,
  limit: number,
): string {
  return truncate(
    [
      `cwd: ${cwd}`,
      `sandbox: ${sandbox}`,
      `exit: ${code ?? "killed"}`,
      stdout && `stdout:\n${stdout}`,
      stderr && `stderr:\n${stderr}`,
    ]
      .filter(Boolean)
      .join("\n"),
    limit,
  );
}

export function shellDefinition(config: AgentConfig) {
  const sandboxed = config.sandboxBackend !== "none";
  return {
    name: "shell",
    description: sandboxed
      ? `Run a shell command in ${config.workspace}. Sandboxed (${config.sandboxBackend}): no network, host FS read-only except the workspace. Non-interactive only. Editors with ACP terminal run the command in the client instead.`
      : `Run a shell command in ${config.workspace}. Non-interactive commands only. Output is truncated. Editors with ACP terminal run the command in the client instead.`,
    risk: "exec" as const,
    parameters: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: { type: "string", description: "Optional working directory relative to the workspace." },
        timeout_ms: { type: "integer", description: "Timeout in milliseconds." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };
}
