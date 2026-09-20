import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHost } from "../src/host.js";
import { autoApprover } from "../src/permissions/policy.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { startAgentServer, type StartedServer } from "../src/serve.js";
import { SessionStore } from "../src/session/store.js";
import { packageVersion } from "../src/version.js";
import { loadConfig } from "../src/config.js";

describe("agent serve", () => {
  let server: StartedServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("serves health, sessions, and a scripted prompt", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-serve-ws-"));
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-serve-"));
    const config = loadConfig({
      workspace,
      sessionDir,
      provider: "scripted",
      approvalMode: "auto",
    });
    const store = new SessionStore(sessionDir);
    const host = await AgentHost.create(
      config,
      new ScriptedProvider([{ text: "hello from serve" }]),
      store,
      autoApprover(),
      { connectMcp: false },
    );
    server = await startAgentServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      config,
      store,
      agentHost: host,
    });
    const health = await fetch(`${server.url}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "UP", version: packageVersion() });
    const actuator = await fetch(`${server.url}/actuator/health`);
    expect(actuator.status).toBe(200);
    const denied = await fetch(`${server.url}/v1/sessions`);
    expect(denied.status).toBe(401);
    const listed = await fetch(`${server.url}/v1/sessions`, { headers: { authorization: "Bearer secret" } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([]);
    const prompted = await fetch(`${server.url}/v1/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-token": "secret" },
      body: JSON.stringify({ prompt: "hi", workspace }),
    });
    expect(prompted.status).toBe(200);
    const body = (await prompted.json()) as { type: string; text: string; sessionId: string };
    expect(body).toMatchObject({ type: "result", text: "hello from serve" });
    expect(body.sessionId).toBeTruthy();
  });
});
