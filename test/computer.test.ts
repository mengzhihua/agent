import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { extractNodes, extractTitle, htmlToText, HtmlDriver } from "../src/browser/html.js";
import { BrowserSession } from "../src/browser/session.js";
import { loadConfig } from "../src/config.js";
import { AgentHost } from "../src/host.js";
import { runTurn } from "../src/loop/agent-loop.js";
import { autoApprover } from "../src/permissions/policy.js";
import { ScriptedProvider } from "../src/provider/scripted.js";
import { createSessionRuntime } from "../src/runtime.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { runTool } from "../src/tools/types.js";

const PAGE = `<!doctype html>
<html>
<head><title>Demo Page</title></head>
<body>
  <h1>Hello</h1>
  <p>Visible text.</p>
  <a href="/next">Next</a>
  <button>Go</button>
  <input type="text" name="q" placeholder="search">
  <script>secret()</script>
</body>
</html>`;

async function serveHtml(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/page`,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

function tempWorkspace(): { workspace: string; config: ReturnType<typeof loadConfig> } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-comp-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-comp-sess-"));
  const artifactsDir = path.join(workspace, "artifacts");
  const config = loadConfig({
    workspace,
    provider: "scripted",
    approvalMode: "auto",
    sessionDir,
    artifactsDir,
  });
  return { workspace, config };
}

describe("html extraction", () => {
  it("strips tags and lists interactive nodes", () => {
    expect(extractTitle(PAGE)).toBe("Demo Page");
    expect(htmlToText(PAGE)).toContain("Visible text.");
    expect(htmlToText(PAGE)).not.toContain("secret()");
    const nodes = extractNodes(PAGE);
    expect(nodes.map((node) => node.role)).toEqual(["link", "button", "textbox"]);
    expect(nodes[0]?.href).toBe("/next");
  });
});

describe("artifacts and ask_user", () => {
  it("saves and lists deliverables", async () => {
    const { config } = tempWorkspace();
    const runtime = createSessionRuntime("s1", config);
    const registry = ToolRegistry.builtin(config);
    const save = await runTool(
      registry.get("artifact")!,
      { action: "save", title: "note", filename: "note.txt", content: "hello artifact", kind: "report" },
      { config, signal: new AbortController().signal, runtime },
    );
    expect(save.content).toMatch(/saved artifacts\//);
    const listed = await runTool(
      registry.get("artifact")!,
      { action: "list" },
      { config, signal: new AbortController().signal, runtime },
    );
    expect(listed.content).toContain("note");
    expect(fs.existsSync(path.join(config.artifactsDir, "manifest.jsonl"))).toBe(true);
  });

  it("asks the attached human", async () => {
    const { config } = tempWorkspace();
    const runtime = createSessionRuntime("s1", config, {
      askUser: async ({ question, choices }) => `${question}:${choices?.join(",")}`,
    });
    const result = await runTool(
      ToolRegistry.builtin(config).get("ask_user")!,
      { question: "color?", choices: ["red", "blue"] },
      { config, signal: new AbortController().signal, runtime },
    );
    expect(result.content).toBe("User: color?:red,blue");
  });
});

describe("web_fetch and browser", () => {
  it("fetches a local page and can save it as an artifact", async () => {
    const server = await serveHtml(PAGE);
    const { config } = tempWorkspace();
    const runtime = createSessionRuntime("s1", config);
    try {
      const fetched = await runTool(
        ToolRegistry.builtin(config).get("web_fetch")!,
        { url: server.url, save: true, title: "demo" },
        { config, signal: new AbortController().signal, runtime },
      );
      expect(fetched.content).toContain("Visible text.");
      expect(fetched.content).toContain("artifact:");
      expect(runtime.artifacts.list().some((item) => item.kind === "page")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("opens a page, snapshots refs, and types into a textbox", async () => {
    const server = await serveHtml(PAGE);
    const { config } = tempWorkspace();
    const runtime = createSessionRuntime("s1", config, { browser: new BrowserSession(new HtmlDriver()) });
    const browser = ToolRegistry.builtin(config).get("browser")!;
    const ctx = { config, signal: new AbortController().signal, runtime };
    try {
      const opened = await runTool(browser, { action: "open", url: server.url }, ctx);
      expect(opened.content).toContain("Demo Page");
      expect(opened.content).toContain("e1");
      const typed = await runTool(browser, { action: "type", ref: "e3", text: "agents" }, ctx);
      expect(typed.content).toContain("value=agents");
      const shot = await runTool(browser, { action: "screenshot" }, ctx);
      expect(shot.content).toMatch(/saved /);
      expect(runtime.artifacts.list().some((item) => item.kind === "screenshot")).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("computer loop", () => {
  it("explore subagents do not get write or browser tools", () => {
    const { config } = tempWorkspace();
    const names = ToolRegistry.create(config, { readOnly: true, allowTask: false }).names();
    expect(names).toEqual(["read", "grep", "glob", "web_search", "web_fetch", "ask_user", "skill", "update_plan"]);
  });

  it("emits artifact events from web_fetch save", async () => {
    const server = await serveHtml(PAGE);
    const { workspace, config } = tempWorkspace();
    const store = new SessionStore(config.sessionDir);
    store.create({
      type: "session_meta",
      id: "c1",
      timestamp: new Date().toISOString(),
      cwd: workspace,
      model: "scripted",
      provider: "scripted",
    });
    const runtime = createSessionRuntime("c1", config);
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "t1", name: "web_fetch", arguments: { url: server.url, save: true } }] },
      { text: "Saved the page." },
    ]);
    const events = [];
    try {
      for await (const event of runTurn({
        store,
        sessionId: "c1",
        userText: "fetch it",
        provider,
        tools: ToolRegistry.builtin(config),
        config,
        approver: autoApprover(),
        signal: new AbortController().signal,
        runtime,
      })) {
        events.push(event);
      }
    } finally {
      await server.close();
    }
    expect(events.some((event) => event.type === "artifact")).toBe(true);
    expect(events.some((event) => event.type === "turn-end")).toBe(true);
    expect(store.read("c1").some((event) => event.type === "artifact")).toBe(true);
  });

  it("lets ask_user pause the turn for a human answer", async () => {
    const { config } = tempWorkspace();
    const store = new SessionStore(config.sessionDir);
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "t1", name: "ask_user", arguments: { question: "Ship it?" } }] },
      { text: "User said yes." },
    ]);
    const host = await AgentHost.create(config, provider, store, autoApprover(), {
      connectMcp: false,
      askUser: async ({ question }) => {
        expect(question).toMatch(/Ship/);
        return "yes";
      },
    });
    const sessionId = host.createSession();
    const events = [];
    for await (const event of host.prompt(sessionId, "confirm", new AbortController().signal)) {
      events.push(event);
    }
    await host.close();
    const result = events.find((event) => event.type === "tool-end" && event.name === "ask_user");
    expect(result?.type === "tool-end" && result.content).toContain("yes");
    const end = events.find((event) => event.type === "turn-end");
    expect(end?.type === "turn-end" && end.text).toBe("User said yes.");
  });
});
