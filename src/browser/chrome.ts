import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromeCandidates, killProcessTree, whichProgram } from "../platform.js";
import { axToNodes, type MappedNode } from "./ax.js";
import { openCdp, type CdpClient } from "./cdp.js";
import { HtmlDriver } from "./html.js";
import { sensitiveWarning, type BrowserDriver, type PageView, type Screenshot } from "./types.js";

export function findChrome(explicit?: string): string | undefined {
  for (const candidate of chromeCandidates(explicit)) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const found = whichProgram(candidate);
    if (found) return found;
  }
  return undefined;
}

export function detectBrowserBackend(mode: "auto" | "html" | "chrome", chromePath?: string): "html" | "chrome" {
  if (mode === "html") return "html";
  if (findChrome(chromePath)) return "chrome";
  if (mode === "chrome") return "chrome";
  return "html";
}

export function createBrowserDriver(backend: "html" | "chrome", chromePath?: string): BrowserDriver {
  if (backend === "chrome") {
    const bin = findChrome(chromePath);
    if (!bin) throw new Error("Chrome/Edge not found. Set AGENT_CHROME or install Google Chrome.");
    return new ChromeDriver(bin);
  }
  return new HtmlDriver();
}

export class ChromeDriver implements BrowserDriver {
  private proc?: ChildProcess;
  private cdp?: CdpClient;
  private sessionId?: string;
  private profileDir?: string;
  private current: PageView = { url: "about:blank", title: "", nodes: [] };
  private currentHtml = "";
  private refs = new Map<string, MappedNode>();

  constructor(private readonly chromePath: string) {}

  async open(url: string, signal: AbortSignal): Promise<PageView> {
    await this.ensure(signal);
    await this.cdp!.send("Page.navigate", { url }, this.sessionId);
    await this.waitReady();
    return this.refresh();
  }

  async click(ref: string, _signal: AbortSignal): Promise<PageView> {
    const node = this.require(ref);
    await this.callOnNode(node, "function() { this.click(); }");
    await this.waitReady(800);
    return this.refresh();
  }

  async type(ref: string, text: string): Promise<PageView> {
    const node = this.require(ref);
    await this.callOnNode(
      node,
      "function(value) { this.focus(); this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }",
      text,
    );
    return this.refresh();
  }

  snapshot(): PageView {
    return this.current;
  }

  html(): string {
    return this.currentHtml;
  }

  url(): string {
    return this.current.url;
  }

  async screenshot(): Promise<Screenshot> {
    await this.ensure();
    const result = await this.cdp!.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, this.sessionId);
    return { buffer: Buffer.from(result.data, "base64"), filename: "snapshot.png" };
  }

  async close(): Promise<void> {
    try {
      this.cdp?.close();
    } catch {
      // ignore
    }
    this.cdp = undefined;
    this.sessionId = undefined;
    const pid = this.proc?.pid;
    this.proc = undefined;
    if (pid) killProcessTree(pid);
    const profile = this.profileDir;
    this.profileDir = undefined;
    if (profile) {
      await delay(50);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }
    this.current = { url: "about:blank", title: "", nodes: [] };
    this.currentHtml = "";
    this.refs.clear();
  }

  private require(ref: string): MappedNode {
    const node = this.refs.get(ref);
    if (!node) throw new Error(`unknown browser ref: ${ref}`);
    return node;
  }

  private async callOnNode(node: MappedNode, fn: string, arg?: string): Promise<void> {
    if (!node.backendNodeId) throw new Error(`ref ${node.ref} has no DOM node`);
    const resolved = await this.cdp!.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: node.backendNodeId },
      this.sessionId,
    );
    await this.cdp!.send(
      "Runtime.callFunctionOn",
      {
        objectId: resolved.object.objectId,
        functionDeclaration: fn,
        arguments: arg === undefined ? [] : [{ value: arg }],
        returnByValue: true,
      },
      this.sessionId,
    );
  }

  private async refresh(): Promise<PageView> {
    const url = await this.evaluate<string>("location.href");
    const title = await this.evaluate<string>("document.title");
    this.currentHtml = await this.evaluate<string>("document.documentElement ? document.documentElement.outerHTML : ''");
    const ax = await this.cdp!.send<{ nodes: Parameters<typeof axToNodes>[0] }>(
      "Accessibility.getFullAXTree",
      {},
      this.sessionId,
    );
    let mapped = axToNodes(ax.nodes ?? []);
    if (mapped.length === 0) {
      await delay(200);
      const again = await this.cdp!.send<{ nodes: Parameters<typeof axToNodes>[0] }>(
        "Accessibility.getFullAXTree",
        {},
        this.sessionId,
      );
      mapped = axToNodes(again.nodes ?? []);
    }
    this.refs = new Map(mapped.map((node) => [node.ref, node]));
    this.current = {
      url,
      title: title || url,
      warning: sensitiveWarning(url),
      nodes: mapped.map(({ backendNodeId: _id, ...node }) => node),
    };
    return this.current;
  }

  private async waitReady(minMs = 0): Promise<void> {
    const start = Date.now();
    const deadline = start + 8_000;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate<string>("document.readyState", 1_500);
        if (state === "complete" && Date.now() - start >= minMs) return;
      } catch {
        // page may be navigating, or CDP briefly stalled
      }
      await delay(100);
    }
  }

  private async evaluate<T>(expression: string, timeoutMs?: number): Promise<T> {
    const result = await this.cdp!.send<{ result: { value?: T } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      this.sessionId,
      timeoutMs,
    );
    return result.result.value as T;
  }

  private async ensure(signal?: AbortSignal): Promise<void> {
    if (this.cdp && this.sessionId) return;
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chrome-"));
    const wsUrl = await launchChrome(this.chromePath, this.profileDir, (proc) => {
      this.proc = proc;
    }, signal);
    this.cdp = await openCdp(wsUrl);
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    const targets = await this.cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>("Target.getTargets");
    let targetId = targets.targetInfos.find((item) => item.type === "page")?.targetId;
    if (!targetId) {
      const created = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      targetId = created.targetId;
    }
    const attached = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = attached.sessionId;
    await this.cdp.send("Page.enable", {}, this.sessionId);
    await this.cdp.send("Runtime.enable", {}, this.sessionId);
    await this.cdp.send("DOM.enable", {}, this.sessionId);
    await this.cdp.send("Accessibility.enable", {}, this.sessionId);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchChrome(
  chromePath: string,
  profileDir: string,
  onProc: (proc: ChildProcess) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars",
      "--password-store=basic",
      "about:blank",
    ];
    const proc = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    onProc(proc);
    let buf = "";
    const onAbort = () => {
      proc.kill("SIGTERM");
      reject(new Error("chrome launch aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("chrome did not print a DevTools websocket (timeout)"));
    }, 20_000);
    const onData = (chunk: Buffer) => {
      buf += String(chunk);
      const match = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        proc.stderr?.off("data", onData);
        proc.stdout?.off("data", onData);
        resolve(match[1]);
      }
    };
    proc.stderr?.on("data", onData);
    proc.stdout?.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (!buf.includes("DevTools listening on")) {
        clearTimeout(timer);
        reject(new Error(`chrome exited ${code ?? "?"} before DevTools started`));
      }
    });
  });
}
