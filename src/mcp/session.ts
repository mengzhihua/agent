import { spawn } from "node:child_process";
import type { AgentConfig, ToolDefinition } from "../types.js";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpFile {
  mcpServers?: Record<string, McpServerConfig>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class McpSession {
  readonly serverName: string;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private child?: ReturnType<typeof spawn>;
  private readonly url?: string;
  private readonly headers: Record<string, string> = {};

  constructor(serverName: string, cfg: McpServerConfig) {
    this.serverName = serverName;
    this.url = cfg.url;
  }

  static async connect(serverName: string, cfg: McpServerConfig): Promise<McpSession> {
    const session = new McpSession(serverName, cfg);
    if (cfg.url) {
      await session.initializeHttp(cfg.url);
      return session;
    }
    if (!cfg.command) {
      throw new Error(`MCP server ${serverName} needs command or url`);
    }
    await session.initializeStdio(cfg);
    return session;
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = (await this.request("tools/list", {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: ToolDefinition["parameters"] }>;
    };
    const tools = result.tools ?? [];
    return tools
      .map((tool) => ({
        name: mcpToolName(this.serverName, tool.name),
        description: `[mcp:${this.serverName}] ${tool.description ?? tool.name}`,
        risk: "exec" as const,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async callTool(originalName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const result = (await this.request("tools/call", { name: originalName, arguments: args }, signal)) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((block) => block.text ?? "")
      .filter(Boolean)
      .join("\n");
    if (result.isError) throw new Error(text || "MCP tool error");
    return text || "(empty MCP result)";
  }

  originalToolName(qualified: string): string {
    const prefix = `mcp__${sanitize(this.serverName)}__`;
    return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : qualified;
  }

  async close(): Promise<void> {
    this.child?.kill("SIGTERM");
    this.child = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("MCP session closed"));
    }
    this.pending.clear();
  }

  private async initializeStdio(cfg: McpServerConfig): Promise<void> {
    this.child = spawn(cfg.command!, cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...cfg.env },
    });
    this.child.stdout?.on("data", (chunk) => this.push(Buffer.from(chunk)));
    this.child.on("error", (err) => this.failAll(err));
    this.child.on("exit", () => this.failAll(new Error(`MCP ${this.serverName} exited`)));
    await this.handshake();
  }

  private async initializeHttp(_url: string): Promise<void> {
    this.headers.accept = "application/json, text/event-stream";
    this.headers["content-type"] = "application/json";
    await this.handshake();
  }

  private async handshake(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent", version: "0.2.0" },
    });
    await this.notify("notifications/initialized", {});
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.url) {
      return await this.httpRequest(method, params, signal);
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write(payload);
    const timeout = setTimeout(() => {
      this.pending.get(id)?.reject(new Error(`MCP timeout: ${method}`));
      this.pending.delete(id);
    }, 30_000);
    signal?.addEventListener("abort", () => {
      this.pending.get(id)?.reject(new Error("aborted"));
      this.pending.delete(id);
    });
    try {
      return await result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (this.url) {
      await this.httpRequest(method, params);
      return;
    }
    this.write({ jsonrpc: "2.0", method, params });
  }

  private async httpRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.url!, {
      method: "POST",
      headers: this.headers,
      signal,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.headers["mcp-session-id"] = sid;
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status} ${method}`);
    }
    const text = await res.text();
    if (!text) return {};
    const parsed = JSON.parse(text) as JsonRpcResponse;
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result ?? {};
  }

  private write(msg: JsonRpcRequest): void {
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, "utf8");
    this.child?.stdin?.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.child?.stdin?.write(payload);
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        this.consumeNdjson();
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.onMessage(body);
    }
  }

  private consumeNdjson(): void {
    const text = this.buffer.toString("utf8");
    if (!text.includes("\n")) return;
    const lines = text.split("\n");
    this.buffer = Buffer.from(lines.pop() ?? "", "utf8");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{")) this.onMessage(trimmed);
    }
  }

  private onMessage(raw: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(raw) as JsonRpcResponse;
    } catch {
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const pending = this.pending.get(Number(msg.id));
    if (!pending) return;
    this.pending.delete(Number(msg.id));
    if (msg.error) pending.reject(new Error(msg.error.message));
    else pending.resolve(msg.result);
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${tool}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function parseMcpToolName(qualified: string): { server: string; tool: string } | undefined {
  if (!qualified.startsWith("mcp__")) return undefined;
  const rest = qualified.slice("mcp__".length);
  const idx = rest.indexOf("__");
  if (idx < 0) return undefined;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}
