import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findChrome } from "./browser/chrome.js";
import { agentHome, loadConfig } from "./config.js";
import { defaultInstallPrefix, defaultShell, userBinDir, whichProgram } from "./platform.js";
import { pathEntryPresent } from "./path_setup.js";
import { authReport } from "./credentials.js";
import { inspectGit } from "./git-context.js";
import { detectSandboxBackend } from "./sandbox/plan.js";
import { userConfigPath } from "./user-config.js";
import { runningAsSea } from "./sea.js";
import { packageRoot, packageVersion } from "./version.js";

export function doctorReport(): string {
  const config = loadConfig({ workspace: process.cwd() });
  const chrome = findChrome();
  const binDir = process.platform === "win32" ? path.join(defaultInstallPrefix(), "bin") : userBinDir();
  const cfg = userConfigPath();
  const lines = [
    `agent ${packageVersion()}`,
    `node ${process.version}${runningAsSea() ? " (sea)" : ""}`,
    `runtime ${runningAsSea() ? `sea ${process.execPath}` : "node"}`,
    `os ${process.platform} ${process.arch} (${os.release()})`,
    `shell ${defaultShell().command}`,
    `install ${process.env.AGENT_INSTALL_ROOT ?? packageRoot() ?? defaultInstallPrefix()}`,
    `home ${agentHome()}`,
    `path ${pathEntryPresent(binDir) ? `ok (${binDir})` : `missing ${binDir} — open a new terminal or re-run the installer`}`,
    `config ${fs.existsSync(cfg) ? cfg : `${cfg} (absent)`}`,
    `workspace ${config.workspace}`,
    `git ${inspectGit(config.workspace)?.summary.replace(/^Git:\s*/, "") ?? "none"}`,
    `sandbox ${detectSandboxBackend(config.sandbox)}${whichProgram("bwrap") ? " (bwrap on PATH)" : ""}`,
    `browser ${config.browserBackend}${chrome ? ` (${chrome})` : " (no Chrome/Edge found)"}`,
    `ripgrep ${whichProgram("rg") ?? "fallback walker"}`,
    `provider ${config.provider} / ${config.model}`,
    `auth ${authReport()}`,
    `approval ${config.approvalMode}  mode ${config.runMode}`,
  ];
  return lines.join("\n");
}

export function configReport(): string {
  const config = loadConfig({ workspace: process.cwd() });
  return [
    `config ${userConfigPath()}`,
    `model ${config.model}`,
    `provider ${config.provider}`,
    `approval ${config.approvalMode}`,
    `mode ${config.runMode}`,
    `sandbox ${config.sandbox}`,
    `browser ${config.browser}`,
    `workspace ${config.workspace}`,
  ].join("\n");
}
