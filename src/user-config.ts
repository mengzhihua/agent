import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalMode, BrowserMode, ProviderName, RunMode, SandboxMode } from "./types.js";

export interface UserFileConfig {
  model?: string;
  provider?: ProviderName;
  approvalMode?: ApprovalMode;
  runMode?: RunMode;
  sandbox?: SandboxMode;
  browser?: BrowserMode;
  compactTokens?: number;
  toolOutputLimit?: number;
}

const PROVIDERS = new Set(["openai", "anthropic", "scripted"]);
const APPROVALS = new Set(["ask", "auto", "edits"]);
const MODES = new Set(["default", "plan"]);
const SANDBOX = new Set(["auto", "none"]);
const BROWSER = new Set(["auto", "html", "chrome"]);

export function userConfigPath(home = process.env.AGENT_HOME ?? path.join(os.homedir(), ".agent")): string {
  return path.join(home, "config.json");
}

export function readUserConfig(home = process.env.AGENT_HOME ?? path.join(os.homedir(), ".agent")): UserFileConfig {
  const file = userConfigPath(home);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return parseUserConfig(raw);
  } catch (err) {
    process.stderr.write(
      `warning: ignore invalid ${file}: ${err instanceof Error ? err.message : err}\n`,
    );
    return {};
  }
}

export function parseUserConfig(raw: Record<string, unknown>): UserFileConfig {
  const out: UserFileConfig = {};
  if (typeof raw.model === "string" && raw.model.trim()) out.model = raw.model.trim();
  if (typeof raw.provider === "string" && PROVIDERS.has(raw.provider)) {
    out.provider = raw.provider as ProviderName;
  }
  if (typeof raw.approvalMode === "string" && APPROVALS.has(raw.approvalMode)) {
    out.approvalMode = raw.approvalMode as ApprovalMode;
  }
  if (typeof raw.runMode === "string" && MODES.has(raw.runMode)) {
    out.runMode = raw.runMode as RunMode;
  }
  if (typeof raw.sandbox === "string" && SANDBOX.has(raw.sandbox)) {
    out.sandbox = raw.sandbox as SandboxMode;
  }
  if (typeof raw.browser === "string" && BROWSER.has(raw.browser)) {
    out.browser = raw.browser as BrowserMode;
  }
  if (typeof raw.compactTokens === "number" && Number.isFinite(raw.compactTokens) && raw.compactTokens > 0) {
    out.compactTokens = Math.trunc(raw.compactTokens);
  }
  if (typeof raw.toolOutputLimit === "number" && Number.isFinite(raw.toolOutputLimit) && raw.toolOutputLimit > 0) {
    out.toolOutputLimit = Math.trunc(raw.toolOutputLimit);
  }
  return out;
}
