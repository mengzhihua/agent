import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  applyLogin,
  applyLogout,
  authStatus,
  parseLoginProvider,
  readCredentials,
  redactSecrets,
  resolveSecret,
} from "../src/credentials.js";
import { fetchWithRetry } from "../src/http.js";
import { createOpenAIProvider } from "../src/provider/openai.js";
import { SessionStore } from "../src/session/store.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cred-"));
  const prev = {
    AGENT_HOME: process.env.AGENT_HOME,
    AGENT_PROVIDER: process.env.AGENT_PROVIDER,
    AGENT_MODEL: process.env.AGENT_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };
  process.env.AGENT_HOME = home;
  delete process.env.AGENT_PROVIDER;
  delete process.env.AGENT_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  try {
    return fn(home);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("credentials", () => {
  it("saves keys to a user file and lets env win", () => {
    withHome((home) => {
      const file = applyLogin({ provider: "openai", apiKey: "sk-filekey-1234567890", baseUrl: "https://example.test/v1" });
      expect(file).toBe(path.join(home, "credentials.json"));
      if (process.platform !== "win32") {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
      expect(resolveSecret("OPENAI_API_KEY")).toBe("sk-filekey-1234567890");
      expect(resolveSecret("OPENAI_BASE_URL")).toBe("https://example.test/v1");
      expect(authStatus().openai).toBe("file");
      process.env.OPENAI_API_KEY = "sk-envkey-1234567890";
      expect(resolveSecret("OPENAI_API_KEY")).toBe("sk-envkey-1234567890");
      expect(authStatus().openai).toBe("env");
      applyLogout("openai", home);
      delete process.env.OPENAI_API_KEY;
      expect(readCredentials(home).openaiApiKey).toBeUndefined();
      expect(authStatus().openai).toBe("missing");
    });
  });

  it("detects anthropic from the credentials file", () => {
    withHome((home) => {
      applyLogin({ provider: "anthropic", apiKey: "sk-ant-filekey12345678" });
      const config = loadConfig({ workspace: home, sessionDir: path.join(home, "s") });
      expect(config.provider).toBe("anthropic");
      expect(config.model).toBe("claude-sonnet-4-5");
    });
  });

  it("creates an openai provider from the credentials file", () => {
    withHome(() => {
      applyLogin({ provider: "openai", apiKey: "sk-filekey-1234567890" });
      const provider = createOpenAIProvider();
      expect(provider.name).toBe("openai");
    });
  });

  it("parses login providers", () => {
    expect(parseLoginProvider("xai")).toBe("xai");
    expect(() => parseLoginProvider("gemini")).toThrow(/openai\|anthropic\|xai/);
  });
});

describe("redaction", () => {
  it("strips API keys from text and transcripts", () => {
    withHome(() => {
      applyLogin({ provider: "openai", apiKey: "sk-filekey-1234567890" });
      expect(redactSecrets("token sk-filekey-1234567890 here")).toBe("token [redacted] here");
      expect(redactSecrets("sk-ant-abcdefghijklmnopqrstuv")).toContain("[redacted]");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-redact-"));
      const store = new SessionStore(dir);
      store.create({
        type: "session_meta",
        id: "s1",
        timestamp: "2026-09-18T00:00:00.000Z",
        cwd: dir,
        model: "test",
        provider: "scripted",
      });
      store.append("s1", {
        type: "user",
        id: "u1",
        timestamp: "2026-09-18T00:00:01.000Z",
        text: "key sk-filekey-1234567890",
      });
      const raw = fs.readFileSync(path.join(dir, "s1.jsonl"), "utf8");
      expect(raw).not.toContain("sk-filekey-1234567890");
      expect(raw).toContain("[redacted]");
    });
  });
});

describe("fetch retry", () => {
  it("retries 503 then succeeds", async () => {
    let calls = 0;
    const res = await fetchWithRetry("https://example.test/v1", { method: "POST", body: "{}" }, {
      retries: 3,
      sleep: async () => undefined,
      fetch: async () => {
        calls += 1;
        if (calls < 3) return new Response("busy", { status: 503 });
        return new Response("ok", { status: 200 });
      },
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it("does not retry 401", async () => {
    let calls = 0;
    const res = await fetchWithRetry("https://example.test/v1", { method: "GET" }, {
      sleep: async () => undefined,
      fetch: async () => {
        calls += 1;
        return new Response("nope", { status: 401 });
      },
    });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });
});
