import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { completionScript } from "../src/completion.js";
import {
  PATH_MARKER,
  appendOnce,
  ensureUserPath,
  pathEntryPresent,
  removeUserPath,
  stripMarkerBlock,
  unixEnvScript,
  unixRcSnippet,
  windowsPathAppendScript,
  windowsPathRemoveScript,
} from "../src/path_setup.js";
import { INSTALL_PS1, INSTALL_SH, updateCommand } from "../src/self_update.js";
import { parseUserConfig } from "../src/user-config.js";

describe("user config", () => {
  it("parses known fields and ignores junk", () => {
    expect(
      parseUserConfig({
        model: "grok-4",
        approvalMode: "edits",
        sandbox: "none",
        browser: "html",
        provider: "nope",
        toolOutputLimit: 12_000,
      }),
    ).toEqual({ model: "grok-4", approvalMode: "edits", sandbox: "none", browser: "html", toolOutputLimit: 12_000 });
  });

  it("loadConfig reads AGENT_HOME/config.json under env and CLI", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cfg-"));
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ model: "file-model", approvalMode: "auto", sandbox: "none" }),
    );
    const prevHome = process.env.AGENT_HOME;
    const prevModel = process.env.AGENT_MODEL;
    const prevApproval = process.env.AGENT_APPROVAL;
    process.env.AGENT_HOME = home;
    delete process.env.AGENT_MODEL;
    delete process.env.AGENT_APPROVAL;
    try {
      const fromFile = loadConfig({ workspace: home, sessionDir: path.join(home, "s") });
      expect(fromFile.model).toBe("file-model");
      expect(fromFile.approvalMode).toBe("auto");
      expect(fromFile.sandbox).toBe("none");
      process.env.AGENT_MODEL = "env-model";
      const fromEnv = loadConfig({ workspace: home, sessionDir: path.join(home, "s") });
      expect(fromEnv.model).toBe("env-model");
      const fromCli = loadConfig({ workspace: home, sessionDir: path.join(home, "s"), model: "cli-model" });
      expect(fromCli.model).toBe("cli-model");
    } finally {
      if (prevHome === undefined) delete process.env.AGENT_HOME;
      else process.env.AGENT_HOME = prevHome;
      if (prevModel === undefined) delete process.env.AGENT_MODEL;
      else process.env.AGENT_MODEL = prevModel;
      if (prevApproval === undefined) delete process.env.AGENT_APPROVAL;
      else process.env.AGENT_APPROVAL = prevApproval;
    }
  });
});

describe("PATH helper", () => {
  it("knows whether a dir is already on PATH", () => {
    const first = (process.env.PATH ?? "").split(path.delimiter).find(Boolean);
    expect(first).toBeTruthy();
    expect(pathEntryPresent(first!)).toBe(true);
    expect(pathEntryPresent(path.join(os.tmpdir(), "no-such-agent-bin"))).toBe(false);
  });

  it("writes env.sh and a profile snippet", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-path-"));
    const binDir = path.join(home, ".local", "bin");
    expect(windowsPathAppendScript(binDir)).toContain("SetEnvironmentVariable");
    expect(windowsPathAppendScript(binDir)).not.toContain("setx");
    expect(windowsPathRemoveScript(binDir)).toContain("SetEnvironmentVariable");
    expect(windowsPathRemoveScript(binDir)).not.toContain("setx");
    const skipped = ensureUserPath(binDir, { home, apply: false });
    expect(skipped.files).toEqual([]);
    expect(fs.existsSync(path.join(home, ".agent", "env.sh"))).toBe(false);
    if (process.platform === "win32") return;

    const profile = path.join(home, ".profile");
    fs.writeFileSync(profile, "keep-me\n");
    const result = ensureUserPath(binDir, { home, apply: true });
    expect(result.files.some((file) => file.endsWith("env.sh"))).toBe(true);
    const env = fs.readFileSync(path.join(home, ".agent", "env.sh"), "utf8");
    expect(env).toContain(PATH_MARKER);
    expect(env).toContain(binDir.split(path.sep).join("/"));
    const profileText = fs.readFileSync(profile, "utf8");
    expect(profileText).toContain(PATH_MARKER);
    expect(profileText).toContain("keep-me");
    expect(appendOnce(profile, unixRcSnippet(path.join(home, ".agent", "env.sh")))).toBe(false);
    expect(unixEnvScript(binDir)).toContain("export PATH=");

    fs.writeFileSync(profile, `keep-me\n${unixRcSnippet(path.join(home, ".agent", "env.sh"))}other\n`);
    expect(stripMarkerBlock(profile)).toBe(true);
    expect(fs.readFileSync(profile, "utf8")).toBe("keep-me\nother\n");

    fs.writeFileSync(profile, `keep-me\n${unixRcSnippet(path.join(home, ".agent", "env.sh"))}`);
    removeUserPath(binDir, { home, apply: true });
    expect(fs.existsSync(path.join(home, ".agent", "env.sh"))).toBe(false);
    expect(fs.readFileSync(profile, "utf8")).not.toContain(PATH_MARKER);
    expect(fs.readFileSync(profile, "utf8")).toContain("keep-me");
  });
});

describe("completion and update", () => {
  it("prints bash, zsh, and powershell scripts", () => {
    expect(completionScript("bash")).toContain("complete -F _agent agent");
    expect(completionScript("bash")).toContain("session");
    expect(completionScript("bash")).toContain("memory");
    expect(completionScript("zsh")).toContain("#compdef agent");
    expect(completionScript("zsh")).toContain("session:List, inspect, export, fork, rewind, compact, cost, or delete sessions");
    expect(completionScript("bash")).toContain("--continue");
    expect(completionScript("powershell")).toContain("Register-ArgumentCompleter");
    expect(completionScript("powershell")).toContain("'session'");
    expect(completionScript("bash")).toContain("--file");
    expect(completionScript("bash")).toContain("--accept-edits");
    expect(completionScript("zsh")).toContain("--accept-edits");
    expect(completionScript("bash")).toContain("permissions");
    expect(() => completionScript("fish")).toThrow(/bash\|zsh\|powershell/);
  });

  it("points update at the one-click installers", () => {
    const cmd = updateCommand();
    if (process.platform === "win32") {
      expect(cmd.command).toBe("powershell");
      expect(cmd.args.join(" ")).toContain(INSTALL_PS1);
    } else {
      expect(cmd.command).toBe("bash");
      expect(cmd.args.join(" ")).toContain(INSTALL_SH);
    }
  });
});
