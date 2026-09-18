import os from "node:os";
import { findChrome } from "./browser/chrome.js";
import { agentHome, loadConfig } from "./config.js";
import { defaultInstallPrefix, defaultShell, whichProgram } from "./platform.js";
import { detectSandboxBackend } from "./sandbox/plan.js";
import { packageRoot, packageVersion } from "./version.js";

export function doctorReport(): string {
  const config = loadConfig({ workspace: process.cwd() });
  const chrome = findChrome();
  const lines = [
    `agent ${packageVersion()}`,
    `node ${process.version}`,
    `os ${process.platform} ${process.arch} (${os.release()})`,
    `shell ${defaultShell().command}`,
    `install ${process.env.AGENT_INSTALL_ROOT ?? packageRoot() ?? defaultInstallPrefix()}`,
    `home ${agentHome()}`,
    `workspace ${config.workspace}`,
    `sandbox ${detectSandboxBackend(config.sandbox)}${whichProgram("bwrap") ? " (bwrap on PATH)" : ""}`,
    `browser ${config.browserBackend}${chrome ? ` (${chrome})` : " (no Chrome/Edge found)"}`,
    `ripgrep ${whichProgram("rg") ?? "fallback walker"}`,
    `provider ${config.provider} / ${config.model}`,
  ];
  return lines.join("\n");
}
