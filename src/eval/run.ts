import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createSessionRuntime } from "../runtime.js";
import { ToolRegistry } from "../tools/registry.js";
import { runTool } from "../tools/types.js";
import type { EvalCase, EvalResult } from "./types.js";

export function loadEvalCase(file: string): EvalCase {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as EvalCase;
  if (!raw.name || !raw.workspace || !Array.isArray(raw.steps)) {
    throw new Error(`invalid eval case: ${file}`);
  }
  return raw;
}

export function listEvalFiles(target: string): string[] {
  const abs = path.resolve(target);
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  return fs
    .readdirSync(abs)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(abs, name))
    .sort();
}

export async function runEvalFile(file: string): Promise<EvalResult> {
  const evalCase = loadEvalCase(file);
  const source = path.resolve(path.dirname(file), evalCase.workspace);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `agent-eval-${evalCase.name}-`));
  fs.cpSync(source, workspace, { recursive: true });
  const config = loadConfig({
    workspace,
    provider: "scripted",
    approvalMode: "auto",
    sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-sess-")),
  });
  const tools = ToolRegistry.builtin(config);
  const runtime = createSessionRuntime("eval", config);
  const signal = new AbortController().signal;
  const outputs: EvalResult["outputs"] = [];

  try {
    for (const step of evalCase.steps) {
      const handler = tools.get(step.name);
      if (!handler) {
        return { name: evalCase.name, ok: false, error: `unknown tool: ${step.name}`, outputs };
      }
      const result = await runTool(handler, step.arguments, { config, signal, runtime });
      outputs.push({ name: result.name, content: result.content, isError: result.isError });
      if (result.isError) {
        return { name: evalCase.name, ok: false, error: `${step.name} failed: ${result.content}`, outputs };
      }
    }

    const contains = evalCase.assert?.fileContains ?? {};
    for (const [rel, needle] of Object.entries(contains)) {
      const text = fs.readFileSync(path.join(workspace, rel), "utf8");
      if (!text.includes(needle)) {
        return { name: evalCase.name, ok: false, error: `${rel} missing ${JSON.stringify(needle)}`, outputs };
      }
    }
    const forbidden = evalCase.assert?.notFileContains ?? {};
    for (const [rel, needle] of Object.entries(forbidden)) {
      const text = fs.readFileSync(path.join(workspace, rel), "utf8");
      if (text.includes(needle)) {
        return { name: evalCase.name, ok: false, error: `${rel} still contains ${JSON.stringify(needle)}`, outputs };
      }
    }
    return { name: evalCase.name, ok: true, outputs };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

export async function runEvalTarget(target: string): Promise<EvalResult[]> {
  const files = listEvalFiles(target);
  if (files.length === 0) throw new Error(`no eval JSON files in ${target}`);
  const results: EvalResult[] = [];
  for (const file of files) {
    results.push(await runEvalFile(file));
  }
  return results;
}
