import type { McpServerConfig } from "../mcp/session.js";

export function parseAcpMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const type = typeof row.type === "string" ? row.type : typeof row.url === "string" ? "http" : "stdio";
    if (type === "sse") continue;
    if (type === "http") {
      if (typeof row.url !== "string" || !row.url) continue;
      out[name] = { url: row.url, headers: namedValues(row.headers) };
      continue;
    }
    if (typeof row.command !== "string" || !row.command) continue;
    out[name] = {
      command: row.command,
      args: Array.isArray(row.args) ? row.args.map((value) => String(value)) : [],
      env: namedValues(row.env),
    };
  }
  return out;
}

function namedValues(raw: unknown): Record<string, string> | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.name !== "string" || !row.name) continue;
      out[row.name] = String(row.value ?? "");
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}
