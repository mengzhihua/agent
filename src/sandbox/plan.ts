import type { AgentConfig, SandboxBackend } from "../types.js";
import { bwrapArgs, hasBwrap } from "./bwrap.js";
import { filterSandboxEnv } from "./env.js";

export interface ShellPlan {
  file: string;
  args: string[];
  cwd: string;
  shell: boolean;
  env: NodeJS.ProcessEnv;
  backend: SandboxBackend;
}

export function detectSandboxBackend(mode: AgentConfig["sandbox"]): SandboxBackend {
  if (mode === "none") return "none";
  return hasBwrap() ? "bwrap" : "none";
}

export function planShell(config: AgentConfig, command: string, cwd: string): ShellPlan {
  const env = filterSandboxEnv();
  if (config.sandboxBackend === "bwrap") {
    return {
      file: "bwrap",
      args: bwrapArgs(config.workspace, cwd, command, [config.artifactsDir]),
      cwd: config.workspace,
      shell: false,
      env,
      backend: "bwrap",
    };
  }
  return {
    file: command,
    args: [],
    cwd,
    shell: true,
    env,
    backend: "none",
  };
}
