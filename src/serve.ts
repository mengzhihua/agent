import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AgentHost } from "./host.js";
import { doctorReport } from "./doctor.js";
import { collectJsonResult, encodeJsonResult, encodeStreamLine, formatSessionDelete, formatSessionList, formatSessionShow } from "./output.js";
import { loadConsoleHtml } from "./web/load.js";
import { autoApprover } from "./permissions/policy.js";
import { createProvider } from "./provider/factory.js";
import { runningAsSea } from "./sea.js";
import { SessionStore } from "./session/store.js";
import type { AgentConfig } from "./types.js";
import { packageVersion } from "./version.js";
import { redactSecrets } from "./credentials.js";

export interface ServeOptions {
  host?: string;
  port?: number;
  token?: string;
  config: AgentConfig;
  store?: SessionStore;
  agentHost?: AgentHost;
  connectMcp?: boolean;
}

export interface StartedServer {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startAgentServer(opts: ServeOptions): Promise<StartedServer> {
  const listenHost = opts.host?.trim() || process.env.AGENT_SERVE_HOST || "0.0.0.0";
  const listenPort = Number(opts.port ?? process.env.AGENT_SERVE_PORT ?? 8080);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new Error("invalid --port");
  }
  const token = (opts.token ?? process.env.AGENT_SERVE_TOKEN ?? "").trim();
  const store = opts.store ?? new SessionStore(opts.config.sessionDir);
  let host = opts.agentHost;
  const getHost = async (): Promise<AgentHost> => {
    if (host) return host;
    host = await AgentHost.create(opts.config, createProvider(opts.config), store, autoApprover(), {
      connectMcp: opts.connectMcp,
    });
    return host;
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const server = createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const mutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    const run = () => handleRequest(req, res, { getHost, store, token });
    const task = mutating ? serialize(run) : run();
    Promise.resolve(task).catch((err) => {
      if (!res.writableEnded) {
        sendJson(res, 500, { error: redactSecrets(err instanceof Error ? err.message : String(err)) });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : listenPort;
  const displayHost = listenHost === "0.0.0.0" || listenHost === "::" ? "127.0.0.1" : listenHost;
  return {
    host: listenHost,
    port,
    url: `http://${displayHost}:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await host?.close();
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { getHost: () => Promise<AgentHost>; store: SessionStore; token: string },
): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const method = (req.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  const open =
    url.pathname === "/v1/health" ||
    url.pathname === "/actuator/health" ||
    url.pathname === "/" ||
    url.pathname === "/ui" ||
    url.pathname === "/v1";
  if (ctx.token && !open && !authorized(req, ctx.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/actuator/health")) {
    sendJson(res, 200, {
      status: "UP",
      version: packageVersion(),
      runtime: runningAsSea() ? "sea" : "node",
    });
    return;
  }
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
    const html = loadConsoleHtml();
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      ...corsHeaders(),
    });
    res.end(html);
    return;
  }
  if (method === "GET" && url.pathname === "/v1") {
    sendJson(res, 200, {
      name: "agent",
      version: packageVersion(),
      endpoints: ["/v1/health", "/v1/doctor", "/v1/prompt", "/v1/sessions", "/actuator/health", "/ui"],
    });
    return;
  }
  if (method === "GET" && url.pathname === "/v1/doctor") {
    sendJson(res, 200, { text: doctorReport() });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/prompt") {
    const body = await readJson(req);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      sendJson(res, 400, { error: "prompt is required" });
      return;
    }
    const agent = await ctx.getHost();
    const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.trim()
        ? body.sessionId.trim()
        : agent.createSession(workspace);
    if (body.sessionId) agent.resume(sessionId, workspace);
    const extraFiles = Array.isArray(body.files) ? body.files.map(String) : [];
    const controller = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const stream = wantsStream(req, body);
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...corsHeaders(),
      });
    }
    const events = [];
    for await (const event of agent.prompt(
      sessionId,
      prompt,
      controller.signal,
      extraFiles.length ? { extraFiles } : undefined,
    )) {
      events.push(event);
      if (stream) res.write(`data: ${encodeStreamLine(sessionId, event)}\n\n`);
    }
    const result = collectJsonResult(sessionId, events);
    if (stream) {
      res.write(`data: ${encodeJsonResult(result)}\n\n`);
      res.end();
      return;
    }
    sendJson(res, 200, result);
    return;
  }
  if (method === "GET" && url.pathname === "/v1/sessions") {
    sendJson(res, 200, JSON.parse(formatSessionList(ctx.store.list(), "json")));
    return;
  }
  const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    if (method === "GET") {
      try {
        sendJson(res, 200, JSON.parse(formatSessionShow(ctx.store.inspect(id), "json")));
      } catch (err) {
        sendJson(res, 404, { error: redactSecrets(err instanceof Error ? err.message : String(err)) });
      }
      return;
    }
    if (method === "DELETE") {
      if (!ctx.store.exists(id)) {
        sendJson(res, 404, { error: `session not found: ${id}` });
        return;
      }
      await (await ctx.getHost()).deleteSession(id);
      sendJson(res, 200, JSON.parse(formatSessionDelete(id, "json")));
      return;
    }
  }
  if (method === "POST" && url.pathname === "/v1/sessions") {
    const body = await readJson(req);
    const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
    const id = (await ctx.getHost()).createSession(workspace);
    sendJson(res, 201, { id });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

function wantsStream(req: IncomingMessage, body: Record<string, unknown>): boolean {
  if (body.stream === true) return true;
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/event-stream") || accept.includes("application/x-ndjson");
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${token}`) return true;
  const alt = req.headers["x-agent-token"];
  const value = Array.isArray(alt) ? alt[0] : alt;
  return value === token;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,authorization,x-agent-token",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = redactSecrets(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...corsHeaders(),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Record<string, unknown>;
}
