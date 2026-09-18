import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectEvalResult } from "../src/output.js";
import { runEvalFile, runEvalTarget } from "../src/eval/run.js";

const evalsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "evals");

describe("eval runner", () => {
  it("replays the broken-add golden trace", async () => {
    const result = await runEvalFile(path.join(evalsDir, "broken-add.json"));
    expect(result.ok, result.error).toBe(true);
    const shell = result.outputs.find((item) => item.name === "shell");
    expect(shell?.content).toMatch(/ok/);
  });

  it("runs every json case in a directory", async () => {
    const results = await runEvalTarget(evalsDir);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(collectEvalResult(results)).toMatchObject({ type: "eval", failed: 0, passed: results.length });
  });
});
