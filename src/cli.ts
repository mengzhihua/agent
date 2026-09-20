#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { parseArgs } from "node:util";
import path from "node:path";
import { loadConfig } from "./config.js";
import { completionScript } from "./completion.js";
import { configReport, doctorReport } from "./doctor.js";
import { runEvalTarget } from "./eval/run.js";
import { AgentHost } from "./host.js";
import { autoApprover, denyApprover } from "./permissions/policy.js";
import { createProvider } from "./provider/factory.js";
import { runAcpStdio } from "./protocol/acp.js";
import type { AskUserFn } from "./runtime.js";
import { applyLogin, applyLogout, parseLoginProvider, redactSecrets } from "./credentials.js";
import { formatInitResult, initWorkspace } from "./init.js";
import { formatMemoryShow, loadMemory, parseMemoryScope } from "./context/memory.js";
import {
  collectJsonResult,
  encodeJsonResult,
  encodeStreamLine,
  formatEvalResults,
  formatSessionDelete,
  formatSessionList,
  formatSessionShow,
  parseOutputFormat,
  type OutputFormat,
} from "./output.js";
import { runSelfUpdate, runUninstall } from "./self_update.js";
import { SessionStore } from "./session/store.js";
import type { Approver, BrowserMode, LoopEvent, ProviderName, SandboxMode } from "./types.js";
import { startAgentServer } from "./serve.js";
import { packageVersion } from "./version.js";

function usage(): string {
  return `Usage: agent [options] [prompt]
       agent acp
       agent eval <file-or-dir>
       agent session list|show|delete|export [id]
       agent memory [show]
       agent doctor
       agent config
       agent init [dir]
       agent login [--provider openai|anthropic|xai] [--key KEY]
       agent logout [--provider openai|anthropic|xai]
       agent update
       agent uninstall
       agent serve [--port 8080] [--host 0.0.0.0]
       agent completion bash|zsh|powershell

  -p, --print            Run one prompt and exit
  -q, --quiet            Hide session/tool progress on stderr
  --output-format <fmt>  text (default) | json | stream-json
  -y, --yes              Auto-approve write/shell/network tools
  --plan                 Start in plan mode (read-only + update_plan)
  -w, --workspace <dir>  Workspace root (default: cwd)
  --resume <id>          Continue a session
  --list                 List sessions (alias: agent session list)
  --file <path>          Attach a workspace file to the prompt (repeatable)
  --model <name>         Model id
  --provider <name>      openai | anthropic
  --session-dir <dir>    Transcript directory
  --sandbox <mode>       auto (default) | none
  --browser <mode>       auto (Chrome if installed) | chrome | html
  --no-mcp               Do not start MCP servers
  -V, --version          Print version
  -h, --help             Show help

Environment: OPENAI_API_KEY, OPENAI_BASE_URL, XAI_API_KEY, ANTHROPIC_API_KEY,
AGENT_MODEL, AGENT_HOME, AGENT_APPROVAL=ask|auto, AGENT_MODE=default|plan,
AGENT_ARTIFACTS, AGENT_SANDBOX=auto|none, AGENT_BROWSER=auto|chrome|html, AGENT_CHROME,
AGENT_OUTPUT_FORMAT=text|json|stream-json, AGENT_QUIET=1
User file: ~/.agent/config.json (CLI and env override the file)
Keys: env vars override ~/.agent/credentials.json (agent login)

Install (macOS/Linux): curl -fsSL https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.sh | bash
Install (Windows):     irm https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.ps1 | iex
Install prefers a native binary from GitHub Releases (Windows .exe, macOS/Linux tarball; Node not required). AGENT_REF=main installs from source. Server: agent serve or java -jar agent-server.jar.

Project files: AGENTS.md, .agentignore, .agent/skills/*/SKILL.md, .agent/mcp.json, .agent/hooks.json, .agent/MEMORY.md
Deliverables land in <workspace>/artifacts (or AGENT_ARTIFACTS).
Shell is OS-sandboxed with bubblewrap on Linux when AGENT_SANDBOX=auto and bwrap is installed.
On macOS/Windows, sandbox stays none unless a Linux bwrap backend is present.
Browser uses headless Chrome/Edge via CDP when found, otherwise static HTML fetch.
`;
}

async function main(): Promise<void> {
  if (process.argv[2] === "acp") {
    const config = loadConfig();
    const store = new SessionStore(config.sessionDir);
    const host = await AgentHost.create(
      config,
      createProvider(config),
      store,
      config.approvalMode === "auto" ? autoApprover() : denyApprover(),
    );
    await runAcpStdio(host);
    return;
  }

  if (process.argv[2] === "doctor") {
    output.write(`${doctorReport()}\n`);
    return;
  }

  if (process.argv[2] === "config") {
    output.write(`${configReport()}\n`);
    return;
  }

  if (process.argv[2] === "init") {
    const dir = path.resolve(process.argv[3] || process.cwd());
    output.write(`${formatInitResult(initWorkspace(dir))}\n`);
    return;
  }

  if (process.argv[2] === "login") {
    await runLoginCommand(process.argv.slice(3));
    return;
  }

  if (process.argv[2] === "logout") {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: { provider: { type: "string", short: "p" } },
    });
    const provider = values.provider ? parseLoginProvider(values.provider) : undefined;
    const file = applyLogout(provider);
    output.write(provider ? `Removed ${provider} credentials (${file})\n` : `Cleared credentials (${file})\n`);
    return;
  }

  if (process.argv[2] === "update") {
    runSelfUpdate();
    return;
  }

  if (process.argv[2] === "uninstall") {
    runUninstall();
    return;
  }

  if (process.argv[2] === "completion") {
    output.write(completionScript(process.argv[3] ?? ""));
    return;
  }

  if (process.argv[2] === "eval") {
    await runEvalCommand(process.argv.slice(3));
    return;
  }

  if (process.argv[2] === "serve") {
    await runServeCommand(process.argv.slice(3));
    return;
  }

  if (process.argv[2] === "session") {
    runSessionCommand(process.argv.slice(3));
    return;
  }

  if (process.argv[2] === "memory") {
    runMemoryCommand(process.argv.slice(3));
    return;
  }

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: "boolean", short: "p", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      "output-format": { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      plan: { type: "boolean", default: false },
      workspace: { type: "string", short: "w" },
      resume: { type: "string" },
      list: { type: "boolean", default: false },
      file: { type: "string", multiple: true },
      model: { type: "string" },
      provider: { type: "string" },
      "session-dir": { type: "string" },
      sandbox: { type: "string" },
      browser: { type: "string" },
      "no-mcp": { type: "boolean", default: false },
      version: { type: "boolean", short: "V", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(usage());
    return;
  }

  if (values.version) {
    console.log(packageVersion());
    return;
  }

  const config = loadConfig({
    workspace: values.workspace,
    model: values.model,
    provider: values.provider as ProviderName | undefined,
    approvalMode: values.yes ? "auto" : undefined,
    runMode: values.plan ? "plan" : undefined,
    sessionDir: values["session-dir"],
    sandbox: values.sandbox as SandboxMode | undefined,
    browser: values.browser as BrowserMode | undefined,
  });
  const store = new SessionStore(config.sessionDir);
  const format = parseOutputFormat(values["output-format"]);
  const quiet = Boolean(values.quiet) || process.env.AGENT_QUIET === "1";

  if (values.list) {
    output.write(`${formatSessionList(store.list(), format === "text" ? "text" : "json")}\n`);
    return;
  }

  const prompt = positionals.join(" ").trim();
  const print = values.print || prompt.length > 0;
  if (format !== "text" && !print) {
    throw new Error("--output-format json|stream-json requires a prompt or --print");
  }
  const approver = values.yes || config.approvalMode === "auto" ? autoApprover() : makeStdinApprover();
  const host = await AgentHost.create(config, createProvider(config), store, approver, {
    connectMcp: !values["no-mcp"],
  });

  try {
    const sessionId = values.resume ? values.resume : host.createSession();
    if (values.resume) host.resume(sessionId);
    if (!quiet && format === "text") {
      stderr.write(`session ${sessionId}  mode ${host.config.runMode}\n`);
    }

    if (print) {
      if (!prompt) throw new Error("prompt is required with --print");
      const controller = new AbortController();
      process.on("SIGINT", () => controller.abort());
      const result = await renderTurn(host, sessionId, prompt, controller.signal, format, quiet, values.file);
      if (format === "text" && !quiet) stderr.write(`\nsession ${sessionId}\n`);
      if (result.isError || result.aborted) process.exitCode = 1;
      return;
    }

    await interactive(host, sessionId);
  } finally {
    await host.close();
  }
}

async function runLoginCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      provider: { type: "string", short: "p" },
      key: { type: "string" },
      "base-url": { type: "string" },
    },
  });
  const provider = parseLoginProvider(values.provider);
  let key = values.key?.trim() ?? "";
  if (!key) {
    if (!input.isTTY) {
      throw new Error("usage: agent login --provider openai|anthropic|xai --key KEY");
    }
    const rl = createInterface({ input, output, terminal: true });
    try {
      key = (await rl.question(`API key for ${provider}: `)).trim();
    } finally {
      rl.close();
    }
  }
  const file = applyLogin({ provider, apiKey: key, baseUrl: values["base-url"] });
  output.write(`Saved ${provider} credentials to ${file}\n`);
}

async function runServeCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      token: { type: "string" },
      workspace: { type: "string", short: "w" },
      "session-dir": { type: "string" },
    },
  });
  const config = loadConfig({
    workspace: values.workspace,
    sessionDir: values["session-dir"],
    approvalMode: "auto",
  });
  const started = await startAgentServer({
    host: values.host,
    port: values.port ? Number(values.port) : undefined,
    token: values.token,
    config,
  });
  stderr.write(`agent ${packageVersion()} serve ${started.url}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      started.close().finally(() => resolve());
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function runEvalCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "output-format": { type: "string" },
    },
  });
  const target = positionals[0];
  if (!target) throw new Error("usage: agent eval <file-or-dir>");
  const format = parseOutputFormat(values["output-format"]);
  const results = await runEvalTarget(target);
  const rendered = formatEvalResults(results, format);
  if (rendered.stdout) output.write(`${rendered.stdout}\n`);
  if (rendered.stderr) stderr.write(`${rendered.stderr}\n`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

function runSessionCommand(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "output-format": { type: "string" },
      "session-dir": { type: "string" },
    },
  });
  const action = positionals[0] ?? "list";
  const sessionId = positionals[1];
  const config = loadConfig({ sessionDir: values["session-dir"] });
  const store = new SessionStore(config.sessionDir);
  const format = parseOutputFormat(values["output-format"]);
  const machine = format === "text" ? "text" : "json";

  if (action === "list") {
    output.write(`${formatSessionList(store.list(), machine)}\n`);
    return;
  }
  if (action === "show" || action === "export") {
    if (!sessionId) throw new Error(`usage: agent session ${action} <id>`);
    const shown = formatSessionShow(store.inspect(sessionId), action === "export" ? "json" : machine);
    output.write(`${shown}\n`);
    return;
  }
  if (action === "delete") {
    if (!sessionId) throw new Error("usage: agent session delete <id>");
    store.delete(sessionId);
    output.write(`${formatSessionDelete(sessionId, machine)}\n`);
    return;
  }
  throw new Error("usage: agent session list|show|delete|export [id]");
}

function runMemoryCommand(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "output-format": { type: "string" },
      scope: { type: "string" },
      workspace: { type: "string", short: "w" },
    },
  });
  const action = positionals[0] ?? "show";
  if (action !== "show") throw new Error("usage: agent memory [show]");
  const config = loadConfig({ workspace: values.workspace });
  const format = parseOutputFormat(values["output-format"]);
  const machine = format === "text" ? "text" : "json";
  const files = loadMemory(config.workspace);
  if (values.scope) {
    const scope = parseMemoryScope(values.scope);
    if (machine === "json") {
      const pathName = scope === "user" ? files.userPath : files.projectPath;
      const text = scope === "user" ? files.user : files.project;
      output.write(`${JSON.stringify({ type: "memory", scope, path: pathName, text })}\n`);
      return;
    }
    output.write(`${scope}  ${scope === "user" ? files.userPath : files.projectPath}\n${(scope === "user" ? files.user : files.project) || "(empty)"}\n`);
    return;
  }
  output.write(`${formatMemoryShow(files, machine)}\n`);
}

async function interactive(host: AgentHost, sessionId: string): Promise<void> {
  const rl = createInterface({ input, output, terminal: true });
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
        console.log("/quit  /yes  /ask  /plan  /execute  /skills  /session  /memory");
        continue;
      }
      if (line === "/session") {
        console.log(sessionId);
        continue;
      }
      if (line === "/memory") {
        console.log(formatMemoryShow(loadMemory(host.config.workspace), "text"));
        continue;
      }
      if (line === "/skills") {
        const names = host.skills.all().map((skill) => `${skill.name}: ${skill.description}`);
        console.log(names.join("\n") || "(no skills)");
        continue;
      }
      if (line === "/plan") {
        host.setRunMode("plan");
        console.log("mode: plan");
        continue;
      }
      if (line === "/execute") {
        host.setRunMode("default");
        console.log("mode: execute");
        continue;
      }
      if (line === "/yes") {
        host.config = { ...host.config, approvalMode: "auto" };
        console.log("approval: auto");
        continue;
      }
      if (line === "/ask") {
        host.config = { ...host.config, approvalMode: "ask" };
        console.log("approval: ask");
        continue;
      }
      running = new AbortController();
      if (host.config.approvalMode === "auto") {
        host.approver = autoApprover();
      } else {
        host.approver = makeReadlineApprover(rl);
      }
      host.askUser = makeAskUser(rl);
      await renderTurn(host, sessionId, line, running.signal);
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

function makeAskUser(rl: ReturnType<typeof createInterface>): AskUserFn {
  return async ({ question, choices }) => {
    const hint = choices?.length ? `\n${choices.map((choice, i) => `  ${i + 1}. ${choice}`).join("\n")}` : "";
    return (await rl.question(`ask: ${question}${hint}\n> `)).trim();
  };
}

async function renderTurn(
  host: AgentHost,
  sessionId: string,
  prompt: string,
  signal: AbortSignal,
  format: OutputFormat = "text",
  quiet = false,
  extraFiles: string[] = [],
): Promise<ReturnType<typeof collectJsonResult>> {
  const events: LoopEvent[] = [];
  let printed = false;
  for await (const event of host.prompt(sessionId, prompt, signal, extraFiles.length ? { extraFiles } : undefined)) {
    events.push(event);
    if (format === "stream-json") {
      output.write(`${encodeStreamLine(sessionId, event)}\n`);
      continue;
    }
    if (format === "json") continue;
    printEvent(event, () => {
      printed = true;
    }, quiet);
  }
  if (format === "text" && printed) output.write("\n");
  const result = collectJsonResult(sessionId, events);
  if (format === "json" || format === "stream-json") {
    output.write(`${encodeJsonResult(result)}\n`);
  }
  return result;
}

function printEvent(event: LoopEvent, markText: () => void, quiet = false): void {
  switch (event.type) {
    case "text-delta":
      markText();
      output.write(event.text);
      break;
    case "tool-start":
      if (!quiet) stderr.write(`\n→ ${event.name}\n`);
      break;
    case "tool-end":
      if (!quiet) stderr.write(event.isError ? `✗ ${event.name}\n` : `✓ ${event.name}\n`);
      break;
    case "permission":
      if (event.decision === "deny") stderr.write(`denied ${event.summary}\n`);
      break;
    case "compact-start":
      if (!quiet) stderr.write("\n(compacting context)\n");
      break;
    case "plan":
      if (!quiet) {
        stderr.write(`\nplan:\n${event.steps.map((step) => `  [${step.status}] ${step.title}`).join("\n")}\n`);
      }
      break;
    case "hook":
      if (!quiet) stderr.write(`hook ${event.hook}: ${event.message}\n`);
      break;
    case "subagent-start":
      if (!quiet) stderr.write(`subagent ${event.label}...\n`);
      break;
    case "subagent-end":
      if (!quiet) stderr.write(`subagent ${event.label} done\n`);
      break;
    case "artifact":
      if (!quiet) stderr.write(`artifact ${event.artifact.kind}: ${event.artifact.path}\n`);
      break;
    case "aborted":
      stderr.write("\naborted\n");
      break;
    case "error":
      stderr.write(`\nerror: ${redactSecrets(event.message)}\n`);
      break;
    default:
      break;
  }
}

main().catch((err) => {
  stderr.write(`${redactSecrets(err instanceof Error ? err.message : String(err))}\n`);
  process.exitCode = 1;
});
