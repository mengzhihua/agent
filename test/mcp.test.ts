import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { McpManager } from "../src/mcp/manager.js";
import { runTurn } from "../src/loop/agent-loop.js";
import { autoApprover } from "../src/permissions/policy.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/mcp/echo-server.mjs");
const managers: McpManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

describe("MCP", () => {
  it("loads a stdio server and exposes echo as a tool", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-"));
    fs.mkdirSync(path.join(workspace, ".agent"));
    fs.writeFileSync(
      path.join(workspace, ".agent", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: { command: process.execPath, args: [server] },
        },
      }),
    );
    const manager = await McpManager.connect(workspace);
    managers.push(manager);
    const extra = await manager.handlers();
    expect(extra.map((handler) => handler.definition.name)).toContain("mcp__echo__echo");

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-sess-"));
    const store = new SessionStore(sessionDir);
    const config = loadConfig({ workspace, provider: "scripted", approvalMode: "auto", sessionDir });
    store.create({
      type: "session_meta",
      id: "m1",
      timestamp: new Date().toISOString(),
      cwd: workspace,
      model: "scripted",
      provider: "scripted",
    });
    const tools = ToolRegistry.create(config, { extraHandlers: extra });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "mcp__echo__echo", arguments: { text: "hi" } }] },
      { text: "echoed" },
    ]);
    const events = [];
    for await (const event of runTurn({
      store,
      sessionId: "m1",
      userText: "echo hi",
      provider,
      tools,
      config,
      approver: autoApprover(),
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    const tool = events.find((event) => event.type === "tool-end" && event.name === "mcp__echo__echo");
    expect(tool?.type === "tool-end" && tool.content).toBe("echo:hi");
  });
});
