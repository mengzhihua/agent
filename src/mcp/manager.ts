import fs from "node:fs";
import path from "node:path";
import { agentHome } from "../config.js";
import type { ToolHandler } from "../tools/types.js";
import { asRecord } from "../tools/types.js";
import type { McpFile, McpServerConfig } from "./session.js";
import { McpSession, parseMcpToolName } from "./session.js";

export class McpManager {
  constructor(private readonly sessions: McpSession[]) {}

  static async connect(workspace: string): Promise<McpManager> {
    const configs = loadMcpConfigs(workspace);
    const sessions: McpSession[] = [];
    for (const [name, cfg] of Object.entries(configs)) {
      try {
        sessions.push(await McpSession.connect(name, cfg));
      } catch (err) {
        process.stderr.write(`mcp ${name} failed: ${err instanceof Error ? err.message : err}\n`);
      }
    }
    return new McpManager(sessions);
  }

  async handlers(): Promise<ToolHandler[]> {
    const handlers: ToolHandler[] = [];
    for (const session of this.sessions) {
      try {
        const defs = await session.listTools();
        for (const definition of defs) {
          handlers.push({
            definition,
            execute: async (args, ctx) => {
              const parsed = parseMcpToolName(definition.name);
              const original = parsed?.tool ?? definition.name;
              return session.callTool(original, asRecord(args), ctx.signal);
            },
          });
        }
      } catch (err) {
        process.stderr.write(
          `mcp ${session.serverName} tools/list failed: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
    return handlers.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  async close(): Promise<void> {
    await Promise.all(this.sessions.map((session) => session.close()));
  }
}

export function loadMcpConfigs(workspace: string): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  Object.assign(merged, readMcpFile(path.join(agentHome(), "mcp.json")));
  Object.assign(merged, readMcpFile(path.join(workspace, ".agent", "mcp.json")));
  return merged;
}

function readMcpFile(file: string): Record<string, McpServerConfig> {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as McpFile;
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}
