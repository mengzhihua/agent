import { spawn } from "node:child_process";
import type { AgentConfig } from "../types.js";
import { resolveInWorkspace, truncate } from "../workspace.js";

export async function shellTool(
  config: AgentConfig,
  command: string,
  relCwd: string | undefined,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<string> {
  const cwd = relCwd ? resolveInWorkspace(config.workspace, relCwd) : config.workspace;
  const timeout = timeoutMs ?? config.shellTimeoutMs;
  const child = spawn(command, {
    cwd,
    shell: true,
    signal,
    env: { ...process.env, TERM: "dumb" },
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

  const code: number | null = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode));
  }).finally(() => clearTimeout(timer));

  const out = truncate(
    [`cwd: ${cwd}`, `exit: ${code ?? "killed"}`, stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
      .filter(Boolean)
      .join("\n"),
    config.shellOutputLimit,
  );
  if (code !== 0) {
    throw new Error(out);
  }
  return out;
}

export function shellDefinition(config: AgentConfig) {
  return {
    name: "shell",
    description: `Run a shell command in ${config.workspace}. Non-interactive commands only. Output is truncated.`,
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
