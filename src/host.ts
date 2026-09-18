import path from "node:path";
import { ArtifactStore } from "./artifacts/store.js";
import { createBrowserDriver } from "./browser/chrome.js";
import { BrowserSession } from "./browser/session.js";
import { loadSkills, type SkillIndex } from "./context/skills.js";
import { HookRunner } from "./hooks/hooks.js";
import { newSessionId, nowIso } from "./ids.js";
import { runTurn } from "./loop/agent-loop.js";
import { McpManager } from "./mcp/manager.js";
import { autoApprover } from "./permissions/policy.js";
import type { ClientElicitationCaps } from "./protocol/elicitation.js";
import type { ClientFsCaps } from "./protocol/fs.js";
import { parseAcpMcpServers } from "./protocol/mcp.js";
import { createSessionRuntime, type AskUserFn, type SessionRuntime } from "./runtime.js";
import { diskFileIo } from "./files/io.js";
import { SessionStore } from "./session/store.js";
import type { TaskArgs } from "./tools/extra.js";
import { ToolRegistry } from "./tools/registry.js";
import type { AgentConfig, Approver, LoopEvent, Provider, RunMode } from "./types.js";

export class AgentHost {
  readonly skills: SkillIndex;
  readonly hooks: HookRunner;
  readonly tools: ToolRegistry;
  askUser?: AskUserFn;
  clientFs: ClientFsCaps = { readTextFile: false, writeTextFile: false };
  clientTerminal = false;
  clientElicitation: ClientElicitationCaps = { form: false, url: false };
  private readonly artifacts: ArtifactStore;
  private readonly runtimes = new Map<string, SessionRuntime>();

  private constructor(
    public config: AgentConfig,
    readonly provider: Provider,
    readonly store: SessionStore,
    public approver: Approver,
    skills: SkillIndex,
    hooks: HookRunner,
    tools: ToolRegistry,
    private readonly mcp: McpManager,
    askUser?: AskUserFn,
  ) {
    this.skills = skills;
    this.hooks = hooks;
    this.tools = tools;
    this.artifacts = new ArtifactStore(config.artifactsDir, config.workspace);
    this.askUser = askUser;
  }

  static async create(
    config: AgentConfig,
    provider: Provider,
    store: SessionStore,
    approver: Approver,
    opts: { connectMcp?: boolean; askUser?: AskUserFn } = {},
  ): Promise<AgentHost> {
    const skills = loadSkills(config.workspace);
    const hooks = HookRunner.load(config.workspace);
    const mcp = opts.connectMcp === false ? new McpManager([]) : await McpManager.connect(config.workspace);
    const extraHandlers = await mcp.handlers();
    const hostRef: { host?: AgentHost } = {};
    const tools = ToolRegistry.create(config, {
      skills,
      extraHandlers,
      runSubagent: (input, signal) => {
        if (!hostRef.host) throw new Error("host not ready");
        return hostRef.host.runSubagent(input, signal);
      },
    });
    const host = new AgentHost(config, provider, store, approver, skills, hooks, tools, mcp, opts.askUser);
    hostRef.host = host;
    return host;
  }

  setRunMode(runMode: RunMode): void {
    this.config = { ...this.config, runMode };
  }

  setApprovalMode(approvalMode: AgentConfig["approvalMode"]): void {
    this.config = { ...this.config, approvalMode };
  }

  setModel(model: string): void {
    const next = model.trim();
    if (!next) throw new Error("invalid model");
    this.config = { ...this.config, model: next };
  }

  setWorkspace(workspace: string): void {
    this.config = { ...this.config, workspace: path.resolve(workspace) };
  }

  runtimeFor(sessionId: string): SessionRuntime {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      existing.askUser = this.askUser;
      return existing;
    }
    const runtime = createSessionRuntime(sessionId, this.config, {
      artifacts: this.artifacts,
      browser: new BrowserSession(createBrowserDriver(this.config.browserBackend)),
      askUser: this.askUser,
      workspace: this.config.workspace,
    });
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  createSession(cwd?: string): string {
    if (cwd) this.setWorkspace(cwd);
    const id = newSessionId();
    this.store.create({
      type: "session_meta",
      id,
      timestamp: nowIso(),
      cwd: this.config.workspace,
      model: this.config.model,
      provider: this.config.provider,
    });
    this.runtimeFor(id);
    return id;
  }

  setSessionRoots(sessionId: string, extraRoots: string[]): void {
    const runtime = this.runtimeFor(sessionId);
    runtime.extraRoots = extraRoots;
    runtime.files = diskFileIo(runtime.workspace, extraRoots);
  }

  resume(sessionId: string, cwd?: string): void {
    if (!this.store.exists(sessionId)) {
      throw new Error(`session not found: ${sessionId}`);
    }
    if (cwd) this.setWorkspace(cwd);
    const runtime = this.runtimeFor(sessionId);
    runtime.workspace = this.config.workspace;
    runtime.files = diskFileIo(runtime.workspace, runtime.extraRoots);
  }

  async closeSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    await runtime.browser.close();
    await runtime.mcp?.close();
  }

  extraRootsFor(sessionId: string): string[] {
    return this.runtimes.get(sessionId)?.extraRoots ?? [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.closeSession(sessionId);
    this.store.delete(sessionId);
  }

  async *prompt(sessionId: string, userText: string, signal: AbortSignal): AsyncGenerator<LoopEvent> {
    const runtime = this.runtimeFor(sessionId);
    yield* runTurn({
      store: this.store,
      sessionId,
      userText,
      provider: this.provider,
      tools: runtime.tools ?? this.tools,
      config: this.config,
      approver: this.approver,
      signal,
      skills: this.skills,
      hooks: this.hooks,
      runtime,
    });
  }

  async attachSessionMcp(sessionId: string, mcpServers: unknown): Promise<void> {
    const configs = parseAcpMcpServers(mcpServers);
    if (Object.keys(configs).length === 0) return;
    const extra = await McpManager.connectConfigs(configs);
    const runtime = this.runtimeFor(sessionId);
    await runtime.mcp?.close();
    runtime.mcp = extra;
    const extraHandlers = [...(await this.mcp.handlers()), ...(await extra.handlers())];
    runtime.tools = this.createTools(extraHandlers);
  }

  private createTools(extraHandlers: Awaited<ReturnType<McpManager["handlers"]>>): ToolRegistry {
    return ToolRegistry.create(this.config, {
      skills: this.skills,
      extraHandlers,
      runSubagent: (input, signal) => this.runSubagent(input, signal),
    });
  }

  async runSubagent(input: TaskArgs, signal: AbortSignal): Promise<string> {
    if (this.config.subagentDepth >= 1) {
      throw new Error("nested subagents are not allowed");
    }
    const childConfig: AgentConfig = {
      ...this.config,
      subagentDepth: this.config.subagentDepth + 1,
      maxToolIterations: Math.min(this.config.maxToolIterations, 20),
      runMode: "default",
    };
    const childId = newSessionId();
    this.store.create({
      type: "session_meta",
      id: childId,
      timestamp: nowIso(),
      cwd: childConfig.workspace,
      model: childConfig.model,
      provider: childConfig.provider,
    });
    const tools = ToolRegistry.create(childConfig, {
      skills: this.skills,
      allowTask: false,
      readOnly: input.subagent_type === "explore",
    });
    let summary = "";
    for await (const event of runTurn({
      store: this.store,
      sessionId: childId,
      userText: input.prompt,
      provider: this.provider,
      tools,
      config: childConfig,
      approver: this.config.approvalMode === "ask" ? this.approver : autoApprover(),
      signal,
      skills: this.skills,
      hooks: this.hooks,
      runtime: this.runtimeFor(childId),
    })) {
      if (event.type === "turn-end") summary = event.text;
      if (event.type === "error") summary = event.message;
    }
    return summary || "(subagent finished with no summary)";
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        await runtime.browser.close();
        await runtime.mcp?.close();
      }),
    );
    this.runtimes.clear();
    await this.mcp.close();
  }
}
