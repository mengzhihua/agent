#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { AgentHost } from "./host.js";
import { autoApprover } from "./permissions/policy.js";
import { createProvider } from "./provider/factory.js";
import { runAcpStdio } from "./protocol/acp.js";
import type { AskUserFn } from "./runtime.js";
import { SessionStore } from "./session/store.js";
import type { Approver, LoopEvent, ProviderName } from "./types.js";

function usage(): string {
  return `Usage: agent [options] [prompt]
       agent acp

  -p, --print            Run one prompt and exit
  -y, --yes              Auto-approve write/shell/network tools
  --plan                 Start in plan mode (read-only + update_plan)
  -w, --workspace <dir>  Workspace root (default: cwd)
  --resume <id>          Continue a session
  --list                 List sessions
  --model <name>         Model id
  --provider <name>      openai | anthropic
  --session-dir <dir>    Transcript directory
  --no-mcp               Do not start MCP servers
  -h, --help             Show help

Environment: OPENAI_API_KEY, OPENAI_BASE_URL, XAI_API_KEY, ANTHROPIC_API_KEY,
AGENT_MODEL, AGENT_HOME, AGENT_APPROVAL=ask|auto, AGENT_MODE=default|plan,
AGENT_ARTIFACTS

Project files: AGENTS.md, .agent/skills/*/SKILL.md, .agent/mcp.json, .agent/hooks.json
Deliverables land in <workspace>/artifacts (or AGENT_ARTIFACTS).
`;
}

async function main(): Promise<void> {
  if (process.argv[2] === "acp") {
    const config = loadConfig();
    const store = new SessionStore(config.sessionDir);
    const host = await AgentHost.create(config, createProvider(config), store, autoApprover());
    await runAcpStdio(host);
    return;
  }

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: "boolean", short: "p", default: false },
      yes: { type: "boolean", short: "y", default: false },
      plan: { type: "boolean", default: false },
      workspace: { type: "string", short: "w" },
      resume: { type: "string" },
      list: { type: "boolean", default: false },
      model: { type: "string" },
      provider: { type: "string" },
      "session-dir": { type: "string" },
      "no-mcp": { type: "boolean", default: false },
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
    runMode: values.plan ? "plan" : undefined,
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
  const approver = values.yes || config.approvalMode === "auto" ? autoApprover() : makeStdinApprover();
  const host = await AgentHost.create(config, createProvider(config), store, approver, {
    connectMcp: !values["no-mcp"],
  });

  try {
    const sessionId = values.resume ? values.resume : host.createSession();
    if (values.resume) host.resume(sessionId);
    stderr.write(`session ${sessionId}  mode ${host.config.runMode}\n`);

    if (print) {
      if (!prompt) throw new Error("prompt is required with --print");
      const controller = new AbortController();
      process.on("SIGINT", () => controller.abort());
      await renderTurn(host, sessionId, prompt, controller.signal);
      stderr.write(`\nsession ${sessionId}\n`);
      return;
    }

    await interactive(host, sessionId);
  } finally {
    await host.close();
  }
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
): Promise<void> {
  let printed = false;
  for await (const event of host.prompt(sessionId, prompt, signal)) {
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
    case "plan":
      stderr.write(`\nplan:\n${event.steps.map((step) => `  [${step.status}] ${step.title}`).join("\n")}\n`);
      break;
    case "hook":
      stderr.write(`hook ${event.hook}: ${event.message}\n`);
      break;
    case "subagent-start":
      stderr.write(`subagent ${event.label}...\n`);
      break;
    case "subagent-end":
      stderr.write(`subagent ${event.label} done\n`);
      break;
    case "artifact":
      stderr.write(`artifact ${event.artifact.kind}: ${event.artifact.path}\n`);
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
