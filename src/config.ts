import { detectBrowserBackend } from "./browser/chrome.js";
import os from "node:os";
import path from "node:path";
import { detectSandboxBackend } from "./sandbox/plan.js";
import type { AgentConfig, ApprovalMode, BrowserMode, ProviderName, RunMode, SandboxMode } from "./types.js";
import { readUserConfig } from "./user-config.js";

export function agentHome(): string {
  return process.env.AGENT_HOME ?? path.join(os.homedir(), ".agent");
}

export function defaultSessionDir(): string {
  return path.join(agentHome(), "sessions");
}

function detectProvider(fileProvider?: ProviderName): ProviderName {
  const explicit = process.env.AGENT_PROVIDER as ProviderName | undefined;
  if (explicit === "openai" || explicit === "anthropic" || explicit === "scripted") {
    return explicit;
  }
  if (fileProvider) return fileProvider;
  if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.XAI_API_KEY) {
    return "anthropic";
  }
  return "openai";
}

function defaultModel(provider: ProviderName, fileModel?: string): string {
  if (process.env.AGENT_MODEL) return process.env.AGENT_MODEL;
  if (fileModel) return fileModel;
  if (provider === "anthropic") return "claude-sonnet-4-5";
  if (process.env.XAI_API_KEY && !process.env.OPENAI_API_KEY) return "grok-4";
  return "gpt-4.1";
}

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const file = readUserConfig();
  const provider = overrides.provider ?? detectProvider(file.provider);
  const config: AgentConfig = {
    workspace: path.resolve(overrides.workspace ?? process.cwd()),
    model: overrides.model ?? defaultModel(provider, file.model),
    provider,
    approvalMode: (overrides.approvalMode ??
      (process.env.AGENT_APPROVAL as ApprovalMode | undefined) ??
      file.approvalMode ??
      "ask") as ApprovalMode,
    runMode: overrides.runMode ?? (process.env.AGENT_MODE as RunMode | undefined) ?? file.runMode ?? "default",
    compactTokens: overrides.compactTokens ?? Number(process.env.AGENT_COMPACT_TOKENS ?? file.compactTokens ?? 100_000),
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
    sandbox: (overrides.sandbox ??
      (process.env.AGENT_SANDBOX as SandboxMode | undefined) ??
      file.sandbox ??
      "auto") as SandboxMode,
    sandboxBackend: "none",
    browser: (overrides.browser ??
      (process.env.AGENT_BROWSER as BrowserMode | undefined) ??
      file.browser ??
      "auto") as BrowserMode,
    browserBackend: "html",
  };
  config.sandboxBackend = overrides.sandboxBackend ?? detectSandboxBackend(config.sandbox);
  config.browserBackend = overrides.browserBackend ?? detectBrowserBackend(config.browser);
  return config;
}
