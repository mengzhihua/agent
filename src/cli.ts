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
import { encodeJsonResult, encodeStreamLine, formatSessionList, parseOutputFormat, collectJsonResult, type OutputFormat } from "./output.js";
import { runSelfUpdate, runUninstall } from "./self_update.js";
import { SessionStore } from "./session/store.js";
import type { Approver, BrowserMode, LoopEvent, ProviderName, SandboxMode } from "./types.js";
import { packageVersion } from "./version.js";

function usage(): string {
  return `Usage: agent [options] [prompt]
       agent acp
       agent eval <file-or-dir>
       agent doctor
       agent config
       agent init [dir]
       agent login [--provider openai|anthropic|xai] [--key KEY]
       agent logout [--provider openai|anthropic|xai]
       agent update
       agent uninstall
       agent completion bash|zsh|powershell

  -p, --print            Run one prompt and exit
  -q, --quiet            Hide session/tool progress on stderr
  --output-format <fmt>  text (default) | json | stream-json
  -y, --yes              Auto-approve write/shell/network tools
  --plan                 Start in plan mode (read-only + update_plan)
  -w, --workspace <dir>  Workspace root (default: cwd)
  --resume <id>          Continue a session
  --list                 List sessions
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

Project files: AGENTS.md, .agentignore, .agent/skills/*/SKILL.md, .agent/mcp.json, .agent/hooks.json
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
    const target = process.argv[3];
    if (!target) throw new Error("usage: agent eval <file-or-dir>");
    const results = await runEvalTarget(target);
    let failed = 0;
    for (const result of results) {
      if (result.ok) {
        output.write(`PASS  ${result.name}\n`);
      } else {
        failed += 1;
        stderr.write(`FAIL  ${result.name}: ${result.error}\n`);
      }
    }
    if (failed) process.exitCode = 1;
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
      const result = await renderTurn(host, sessionId, prompt, controller.signal, format, quiet);
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
        console.log("/quit  /yes  /ask  /plan  /execute  /skills  /session");
        continue;
      }
      if (line === "/session") {
        console.log(sessionId);
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
): Promise<ReturnType<typeof collectJsonResult>> {
  const events: LoopEvent[] = [];
  let printed = false;
  for await (const event of host.prompt(sessionId, prompt, signal)) {
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
