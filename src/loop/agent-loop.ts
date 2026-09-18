import { injectExplicitSkills, loadSkills, type SkillIndex } from "../context/skills.js";
import { HookRunner } from "../hooks/hooks.js";
import { newId, nowIso } from "../ids.js";
import { decidePermission, riskFor } from "../permissions/policy.js";
import { buildSystemPrompt } from "../prompt/system.js";
import { createSessionRuntime, type SessionRuntime } from "../runtime.js";
import type { SessionStore } from "../session/store.js";
import { parseSteps } from "../tools/extra.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runTool, startLocationsForCall } from "../tools/types.js";
import type { AgentConfig, Approver, LoopEvent, Provider, ToolCall, ToolDiff, ToolLocation } from "../types.js";
import { assembleMessages } from "./assemble.js";
import { shouldCompact, summarizeTranscript } from "./compact.js";

export interface RunTurnOptions {
  store: SessionStore;
  sessionId: string;
  userText: string;
  provider: Provider;
  tools: ToolRegistry;
  config: AgentConfig;
  approver: Approver;
  signal: AbortSignal;
  skills?: SkillIndex;
  hooks?: HookRunner;
  runtime?: SessionRuntime;
}

export async function* runTurn(options: RunTurnOptions): AsyncGenerator<LoopEvent> {
  const { store, sessionId, provider, tools, config, approver, signal } = options;
  const skills = options.skills ?? loadSkills(config.workspace);
  const hooks = options.hooks ?? HookRunner.load(config.workspace);
  const runtime = options.runtime ?? createSessionRuntime(sessionId, config);
  const userText = injectExplicitSkills(options.userText, skills);
  store.append(sessionId, { type: "user", id: newId("evt"), timestamp: nowIso(), text: userText });

  try {
    for (let iter = 0; iter < config.maxToolIterations; iter++) {
      signal.throwIfAborted();

      yield* maybeCompact(options);

      const messages = assembleMessages(store.read(sessionId));
      const toolCalls: ToolCall[] = [];
      let text = "";

      for await (const event of provider.complete(
        {
          model: config.model,
          system: buildSystemPrompt(config, skills),
          messages,
          tools: tools.definitions(),
        },
        signal,
      )) {
        if (event.type === "text-delta") {
          text += event.text;
          yield { type: "text-delta", text: event.text };
        } else if (event.type === "tool-call") {
          toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        } else if (event.type === "usage") {
          yield event;
        }
      }

      if (toolCalls.length === 0) {
        store.append(sessionId, {
          type: "assistant",
          id: newId("evt"),
          timestamp: nowIso(),
          text,
        });
        await hooks.stop(text, signal);
        yield { type: "turn-end", text };
        return;
      }

      store.append(sessionId, {
        type: "assistant",
        id: newId("evt"),
        timestamp: nowIso(),
        text,
      });
      for (const call of toolCalls) {
        store.append(sessionId, {
          type: "tool_call",
          id: newId("evt"),
          timestamp: nowIso(),
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }

      for (const batch of toolBatches(toolCalls)) {
        const runnable: ToolCall[] = [];
        for (const call of batch) {
          yield {
            type: "tool-start",
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
            locations: startLocationsForCall(call, runtime.workspace, runtime.extraRoots),
          };
          if (call.name === "task") {
            const args = (call.arguments ?? {}) as Record<string, unknown>;
            yield {
              type: "subagent-start",
              label: typeof args.label === "string" ? args.label : "task",
            };
          }

          const permission = await decidePermission(
            call.name,
            call.arguments,
            config.approvalMode,
            approver,
            config.runMode,
            config.sandboxBackend,
            call.id,
          );
          yield { type: "permission", tool: call.name, decision: permission.decision, summary: permission.summary };

          if (permission.decision === "deny") {
            yield* finishTool(store, sessionId, call, permission.summary, true);
            continue;
          }

          const pre = await hooks.preToolUse(call.name, call.arguments, signal);
          if (pre.decision === "deny") {
            const content = `Hook blocked ${call.name}: ${pre.reason ?? "denied"}`;
            yield { type: "hook", hook: "PreToolUse", tool: call.name, message: content };
            yield* finishTool(store, sessionId, call, content, true);
            continue;
          }
          runnable.push(call);
        }

        if (runnable.length === 0) continue;
        const artifactMark = runtime.artifacts.count();
        const executed = await Promise.all(
          runnable.map((call) => {
            const handler = tools.get(call.name);
            return handler
              ? runTool(handler, call.arguments, { config, signal, runtime, callId: call.id })
              : Promise.resolve({ name: call.name, content: `unknown tool: ${call.name}`, isError: true });
          }),
        );

        for (const artifact of runtime.artifacts.addedSince(artifactMark)) {
          store.append(sessionId, {
            type: "artifact",
            id: newId("evt"),
            timestamp: nowIso(),
            artifact,
          });
          yield { type: "artifact", artifact };
        }

        for (let i = 0; i < runnable.length; i++) {
          const call = runnable[i]!;
          const result = executed[i]!;
          const post = await hooks.postToolUse(
            call.name,
            call.arguments,
            result.content,
            result.isError,
            signal,
          );
          const content = post.append ? `${result.content}\n${post.append}` : result.content;
          if (post.append) {
            yield { type: "hook", hook: "PostToolUse", tool: call.name, message: post.append };
          }

          if (call.name === "update_plan" && !result.isError) {
            try {
              const args = (call.arguments ?? {}) as Record<string, unknown>;
              const steps = parseSteps(args.steps);
              const explanation = typeof args.explanation === "string" ? args.explanation : undefined;
              store.append(sessionId, {
                type: "plan",
                id: newId("evt"),
                timestamp: nowIso(),
                steps,
                explanation,
              });
              yield { type: "plan", steps, explanation };
            } catch {
              // plan event is best-effort
            }
          }

          if (call.name === "task") {
            const args = (call.arguments ?? {}) as Record<string, unknown>;
            yield {
              type: "subagent-end",
              label: typeof args.label === "string" ? args.label : "task",
            };
          }

          yield* finishTool(store, sessionId, call, content, result.isError, {
            locations: result.locations,
            diff: result.diff,
          });
        }
      }
    }

    yield { type: "error", message: `stopped after ${config.maxToolIterations} tool iterations` };
  } catch (err) {
    if (signal.aborted) {
      yield { type: "aborted" };
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message };
  }
}

export function canRunInParallel(name: string, args?: unknown): boolean {
  if (name === "ask_user" || name === "update_plan" || name === "task") return false;
  return riskFor(name, args) === "read";
}

export function toolBatches(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = [];
  for (const call of calls) {
    const last = batches.at(-1);
    if (
      last &&
      last.length > 0 &&
      canRunInParallel(last[0]!.name, last[0]!.arguments) &&
      canRunInParallel(call.name, call.arguments)
    ) {
      last.push(call);
    } else {
      batches.push([call]);
    }
  }
  return batches;
}

async function* finishTool(
  store: SessionStore,
  sessionId: string,
  call: ToolCall,
  content: string,
  isError?: boolean,
  extra?: { locations?: ToolLocation[]; diff?: ToolDiff },
): AsyncGenerator<LoopEvent> {
  store.append(sessionId, {
    type: "tool_result",
    id: newId("evt"),
    timestamp: nowIso(),
    callId: call.id,
    name: call.name,
    content,
    isError,
  });
  yield {
    type: "tool-end",
    callId: call.id,
    name: call.name,
    content,
    isError,
    locations: extra?.locations,
    diff: extra?.diff,
  };
}

async function* maybeCompact(options: RunTurnOptions): AsyncGenerator<LoopEvent> {
  const { store, sessionId, provider, config, signal } = options;
  const events = store.read(sessionId);
  const last = events.at(-1);
  const trailingUser = last?.type === "user" ? last : undefined;
  const fullMessages = assembleMessages(events);
  if (!shouldCompact(fullMessages, config)) return;

  const prior = trailingUser ? assembleMessages(events.slice(0, -1)) : fullMessages;
  if (prior.length === 0) return;

  yield { type: "compact-start" };
  const summary = await summarizeTranscript(provider, config, prior, signal);
  store.append(sessionId, {
    type: "compact",
    id: newId("evt"),
    timestamp: nowIso(),
    summary,
  });
  if (trailingUser) {
    store.append(sessionId, {
      type: "user",
      id: newId("evt"),
      timestamp: nowIso(),
      text: trailingUser.text,
    });
  }
  yield { type: "compact-end", summary };
}
