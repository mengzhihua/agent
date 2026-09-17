import os from "node:os";
import path from "node:path";
import { detectSandboxBackend } from "./sandbox/plan.js";
import type { AgentConfig, ApprovalMode, ProviderName, RunMode, SandboxMode } from "./types.js";

export function agentHome(): string {
  return process.env.AGENT_HOME ?? path.join(os.homedir(), ".agent");
}

export function defaultSessionDir(): string {
  return path.join(agentHome(), "sessions");
}

function detectProvider(): ProviderName {
  const explicit = process.env.AGENT_PROVIDER as ProviderName | undefined;
  if (explicit === "openai" || explicit === "anthropic" || explicit === "scripted") {
    return explicit;
  }
  if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.XAI_API_KEY) {
    return "anthropic";
  }
  return "openai";
}

function defaultModel(provider: ProviderName): string {
  if (process.env.AGENT_MODEL) return process.env.AGENT_MODEL;
  if (provider === "anthropic") return "claude-sonnet-4-5";
  if (process.env.XAI_API_KEY && !process.env.OPENAI_API_KEY) return "grok-4";
  return "gpt-4.1";
}

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const provider = overrides.provider ?? detectProvider();
  const config: AgentConfig = {
    workspace: path.resolve(overrides.workspace ?? process.cwd()),
    model: overrides.model ?? defaultModel(provider),
    provider,
    approvalMode: (overrides.approvalMode ??
      (process.env.AGENT_APPROVAL as ApprovalMode | undefined) ??
      "ask") as ApprovalMode,
    runMode: overrides.runMode ?? (process.env.AGENT_MODE as RunMode | undefined) ?? "default",
    compactTokens: overrides.compactTokens ?? Number(process.env.AGENT_COMPACT_TOKENS ?? 100_000),
    maxToolIterations: overrides.maxToolIterations ?? 40,
    sessionDir: overrides.sessionDir ?? defaultSessionDir(),
    shellTimeoutMs: overrides.shellTimeoutMs ?? 60_000,
    shellOutputLimit: overrides.shellOutputLimit ?? 32_768,
    subagentDepth: overrides.subagentDepth ?? 0,
    artifactsDir: path.resolve(
      overrides.artifactsDir ??
        process.env.AGENT_ARTIFACTS ??
        path.join(path.resolve(overrides.workspace ?? process.cwd()), "artifacts"),
    ),
    sandbox: (overrides.sandbox ?? (process.env.AGENT_SANDBOX as SandboxMode | undefined) ?? "auto") as SandboxMode,
    sandboxBackend: "none",
  };
  config.sandboxBackend = overrides.sandboxBackend ?? detectSandboxBackend(config.sandbox);
  return config;
}
