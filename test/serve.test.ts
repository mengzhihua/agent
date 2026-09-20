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
      new ScriptedProvider([
        { text: "hello from serve", usage: { inputTokens: 10, outputTokens: 2 } },
        { text: "hello from serve" },
        { text: "session summary" },
      ]),
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
    const html = await fetch(`${server.url}/`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("web console");
    const catalog = await fetch(`${server.url}/v1`);
    expect(await catalog.json()).toMatchObject({ name: "agent", version: packageVersion() });
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
    expect(body).toMatchObject({ type: "result", text: "hello from serve", usage: { inputTokens: 10, outputTokens: 2 } });
    expect(body.sessionId).toBeTruthy();
    const usage = await fetch(`${server.url}/v1/sessions/${encodeURIComponent(body.sessionId)}/usage`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ id: body.sessionId, inputTokens: 10, outputTokens: 2, calls: 1 });
    const forked = await fetch(`${server.url}/v1/sessions/${encodeURIComponent(body.sessionId)}/fork`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    expect(forked.status).toBe(201);
    expect(await forked.json()).toMatchObject({ forkedFrom: body.sessionId });
    const streamed = await fetch(`${server.url}/v1/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", "x-agent-token": "secret" },
      body: JSON.stringify({ prompt: "again", workspace, stream: true }),
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const sse = await streamed.text();
    expect(sse).toContain("text-delta");
    expect(sse).toContain("hello from serve");
    expect(sse).toContain('"type":"result"');
    const compacted = await fetch(`${server.url}/v1/sessions/${encodeURIComponent(body.sessionId)}/compact`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    expect(compacted.status).toBe(200);
    expect(await compacted.json()).toMatchObject({ id: body.sessionId, summary: "session summary" });
    const rewound = await fetch(`${server.url}/v1/sessions/${encodeURIComponent(body.sessionId)}/rewind`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    expect(rewound.status).toBe(200);
    const rewoundBody = (await rewound.json()) as { id: string; removed: number };
    expect(rewoundBody).toMatchObject({ id: body.sessionId });
    expect(rewoundBody.removed).toBeGreaterThan(0);
  });
});
