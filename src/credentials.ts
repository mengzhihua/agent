import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LoginProvider = "openai" | "anthropic" | "xai";

export type AuthSource = "env" | "file" | "missing";

export interface StoredCredentials {
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  xaiApiKey?: string;
  anthropicApiKey?: string;
}

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "XAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

export function credentialsPath(home = process.env.AGENT_HOME ?? path.join(os.homedir(), ".agent")): string {
  return path.join(home, "credentials.json");
}

export function readCredentials(home = process.env.AGENT_HOME ?? path.join(os.homedir(), ".agent")): StoredCredentials {
  const file = credentialsPath(home);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return parseCredentials(raw);
  } catch (err) {
    process.stderr.write(
      `warning: ignore invalid ${file}: ${err instanceof Error ? err.message : err}\n`,
    );
    return {};
  }
}

export function parseCredentials(raw: Record<string, unknown>): StoredCredentials {
  const out: StoredCredentials = {};
  if (typeof raw.openaiApiKey === "string" && raw.openaiApiKey.trim()) out.openaiApiKey = raw.openaiApiKey.trim();
  if (typeof raw.openaiBaseUrl === "string" && raw.openaiBaseUrl.trim()) out.openaiBaseUrl = raw.openaiBaseUrl.trim();
  if (typeof raw.xaiApiKey === "string" && raw.xaiApiKey.trim()) out.xaiApiKey = raw.xaiApiKey.trim();
  if (typeof raw.anthropicApiKey === "string" && raw.anthropicApiKey.trim()) {
    out.anthropicApiKey = raw.anthropicApiKey.trim();
  }
  return out;
}

export function writeCredentials(
  creds: StoredCredentials,
  home = process.env.AGENT_HOME ?? path.join(os.homedir(), ".agent"),
): string {
  const file = credentialsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows may ignore chmod
  }
  return file;
}

export function resolveSecret(name: (typeof ENV_KEYS)[number]): string | undefined {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  const file = readCredentials();
  if (name === "OPENAI_API_KEY") return file.openaiApiKey;
  if (name === "OPENAI_BASE_URL") return file.openaiBaseUrl;
  if (name === "XAI_API_KEY") return file.xaiApiKey;
  if (name === "ANTHROPIC_API_KEY") return file.anthropicApiKey;
  return undefined;
}

export function authStatus(): Record<"openai" | "anthropic" | "xai", AuthSource> {
  return {
    openai: sourceOf("OPENAI_API_KEY"),
    anthropic: sourceOf("ANTHROPIC_API_KEY"),
    xai: sourceOf("XAI_API_KEY"),
  };
}

export function authReport(): string {
  const status = authStatus();
  return `openai ${status.openai}  anthropic ${status.anthropic}  xai ${status.xai}`;
}

function sourceOf(name: (typeof ENV_KEYS)[number]): AuthSource {
  if (process.env[name]?.trim()) return "env";
  const file = readCredentials();
  if (name === "OPENAI_API_KEY" && file.openaiApiKey) return "file";
  if (name === "ANTHROPIC_API_KEY" && file.anthropicApiKey) return "file";
  if (name === "XAI_API_KEY" && file.xaiApiKey) return "file";
  return "missing";
}

export function applyLogin(input: {
  provider: LoginProvider;
  apiKey: string;
  baseUrl?: string;
  home?: string;
}): string {
  const key = input.apiKey.trim();
  if (!key) throw new Error("API key is required");
  const home = input.home;
  const current = readCredentials(home);
  if (input.provider === "openai") {
    current.openaiApiKey = key;
    if (input.baseUrl?.trim()) current.openaiBaseUrl = input.baseUrl.trim();
  } else if (input.provider === "xai") {
    current.xaiApiKey = key;
  } else {
    current.anthropicApiKey = key;
  }
  return writeCredentials(current, home);
}

export function applyLogout(provider?: LoginProvider, home?: string): string {
  const current = readCredentials(home);
  if (!provider) {
    return writeCredentials({}, home);
  }
  if (provider === "openai") {
    delete current.openaiApiKey;
    delete current.openaiBaseUrl;
  } else if (provider === "xai") {
    delete current.xaiApiKey;
  } else {
    delete current.anthropicApiKey;
  }
  return writeCredentials(current, home);
}

export function secretValues(): string[] {
  const out: string[] = [];
  for (const name of ENV_KEYS) {
    const value = process.env[name]?.trim();
    if (value && value.length >= 8) out.push(value);
  }
  const file = readCredentials();
  for (const value of Object.values(file)) {
    if (typeof value === "string" && value.length >= 8) out.push(value);
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secretValues()) {
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  out = out.replace(/\bxai-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
  return out;
}

export function parseLoginProvider(raw: string | undefined): LoginProvider {
  const name = (raw ?? "openai").trim().toLowerCase();
  if (name === "openai" || name === "anthropic" || name === "xai") return name;
  throw new Error("usage: agent login --provider openai|anthropic|xai [--key KEY]");
}
