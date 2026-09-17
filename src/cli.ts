#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { newSessionId, nowIso } from "./ids.js";
import { runTurn } from "./loop/agent-loop.js";
import { autoApprover } from "./permissions/policy.js";
import { createProvider } from "./provider/factory.js";
import { SessionStore } from "./session/store.js";
import { ToolRegistry } from "./tools/registry.js";
import type { AgentConfig, Approver, LoopEvent, ProviderName } from "./types.js";

function usage(): string {
  return `Usage: agent [options] [prompt]

  -p, --print            Run one prompt and exit
  -y, --yes              Auto-approve write/shell/network tools
  -w, --workspace <dir>  Workspace root (default: cwd)
  --resume <id>          Continue a session
  --list                 List sessions
  --model <name>         Model id
  --provider <name>      openai | anthropic
  --session-dir <dir>    Transcript directory
  -h, --help             Show help

Environment: OPENAI_API_KEY, OPENAI_BASE_URL, XAI_API_KEY, ANTHROPIC_API_KEY,
AGENT_MODEL, AGENT_HOME, AGENT_APPROVAL=ask|auto
`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: "boolean", short: "p", default: false },
      yes: { type: "boolean", short: "y", default: false },
      workspace: { type: "string", short: "w" },
      resume: { type: "string" },
      list: { type: "boolean", default: false },
      model: { type: "string" },
      provider: { type: "string" },
      "session-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(usage());
    return;
  }

  const config = loadConfig({
    workspace: values.workspace,
    model: values.model,
    provider: values.provider as ProviderName | undefined,
    approvalMode: values.yes ? "auto" : undefined,
    sessionDir: values["session-dir"],
  });
  const store = new SessionStore(config.sessionDir);

  if (values.list) {
    const rows = store.list();
    if (rows.length === 0) {
      console.log("No sessions.");
      return;
    }
    for (const row of rows) {
      console.log(`${row.id}  ${row.timestamp}  ${row.model}  ${row.cwd}`);
    }
    return;
  }

  const prompt = positionals.join(" ").trim();
  const print = values.print || prompt.length > 0;
  const sessionId = values.resume ?? newSessionId();
  if (values.resume) {
    if (!store.exists(sessionId)) {
      throw new Error(`session not found: ${sessionId}`);
    }
  } else {
    store.create({
      type: "session_meta",
      id: sessionId,
      timestamp: nowIso(),
      cwd: config.workspace,
      model: config.model,
      provider: config.provider,
    });
  }

  const provider = createProvider(config);
  const tools = ToolRegistry.builtin(config);
  stderr.write(`session ${sessionId}\n`);

  if (print) {
    if (!prompt) throw new Error("prompt is required with --print");
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    const approver = values.yes || config.approvalMode === "auto" ? autoApprover() : makeStdinApprover();
    await renderTurn({ store, sessionId, prompt, provider, tools, config, approver, signal: controller.signal });
    stderr.write(`\nsession ${sessionId}\n`);
    return;
  }

  await interactive({ store, sessionId, provider, tools, config });
}

async function interactive(opts: {
  store: SessionStore;
  sessionId: string;
  provider: ReturnType<typeof createProvider>;
  tools: ToolRegistry;
  config: AgentConfig;
}): Promise<void> {
  const rl = createInterface({ input, output, terminal: true });
  let approvalMode = opts.config.approvalMode;
  console.log("Type a task. /help for commands. Ctrl+C cancels the current turn.");
  let running: AbortController | null = null;

  const onSigint = () => {
    if (running) {
      running.abort();
      return;
    }
    rl.close();
  };
  process.on("SIGINT", onSigint);

  try {
    while (true) {
      const line = (await rl.question("agent> ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        console.log("/quit  /yes  /ask  /session");
        continue;
      }
      if (line === "/session") {
        console.log(opts.sessionId);
        continue;
      }
      if (line === "/yes") {
        approvalMode = "auto";
        console.log("approval: auto");
        continue;
      }
      if (line === "/ask") {
        approvalMode = "ask";
        console.log("approval: ask");
        continue;
      }
      running = new AbortController();
      const config = { ...opts.config, approvalMode };
      const approver = approvalMode === "auto" ? autoApprover() : makeReadlineApprover(rl);
      await renderTurn({
        store: opts.store,
        sessionId: opts.sessionId,
        prompt: line,
        provider: opts.provider,
        tools: opts.tools,
        config,
        approver,
        signal: running.signal,
      });
      running = null;
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
}

function makeStdinApprover(): Approver {
  return async (request) => {
    if (!input.isTTY) {
      stderr.write(`denied (non-interactive): ${request.summary}\n`);
      return "deny";
    }
    const rl = createInterface({ input, output: stderr });
    try {
      const answer = (await rl.question(`Allow ${request.summary}? [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes" ? "allow" : "deny";
    } finally {
      rl.close();
    }
  };
}

function makeReadlineApprover(rl: ReturnType<typeof createInterface>): Approver {
  return async (request) => {
    const answer = (await rl.question(`Allow ${request.summary}? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes" ? "allow" : "deny";
  };
}

async function renderTurn(opts: {
  store: SessionStore;
  sessionId: string;
  prompt: string;
  provider: ReturnType<typeof createProvider>;
  tools: ToolRegistry;
  config: AgentConfig;
  approver: Approver;
  signal: AbortSignal;
}): Promise<void> {
  let printed = false;
  for await (const event of runTurn({
    store: opts.store,
    sessionId: opts.sessionId,
    userText: opts.prompt,
    provider: opts.provider,
    tools: opts.tools,
    config: opts.config,
    approver: opts.approver,
    signal: opts.signal,
  })) {
    printEvent(event, () => {
      printed = true;
    });
  }
  if (printed) output.write("\n");
}

function printEvent(event: LoopEvent, markText: () => void): void {
  switch (event.type) {
    case "text-delta":
      markText();
      output.write(event.text);
      break;
    case "tool-start":
      stderr.write(`\n→ ${event.name}\n`);
      break;
    case "tool-end":
      stderr.write(event.isError ? `✗ ${event.name}\n` : `✓ ${event.name}\n`);
      break;
    case "permission":
      if (event.decision === "deny") stderr.write(`denied ${event.summary}\n`);
      break;
    case "compact-start":
      stderr.write("\n(compacting context)\n");
      break;
    case "aborted":
      stderr.write("\naborted\n");
      break;
    case "error":
      stderr.write(`\nerror: ${event.message}\n`);
      break;
    default:
      break;
  }
}

main().catch((err) => {
  stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
});
