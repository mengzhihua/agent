import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultInstallPrefix, userBinDir } from "./platform.js";
import { removeUserPath } from "./path_setup.js";

export const INSTALL_REPO = "mengzhihua/agent";
export const INSTALL_SH = `https://raw.githubusercontent.com/${INSTALL_REPO}/main/scripts/install.sh`;
export const INSTALL_PS1 = `https://raw.githubusercontent.com/${INSTALL_REPO}/main/scripts/install.ps1`;

export function updateCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: ["-NoProfile", "-Command", `irm ${INSTALL_PS1} | iex`],
    };
  }
  return {
    command: "bash",
    args: ["-lc", `curl -fsSL ${INSTALL_SH} | bash`],
  };
}

export function runSelfUpdate(): void {
  const { command, args } = updateCommand();
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, AGENT_PREFIX: process.env.AGENT_PREFIX || defaultInstallPrefix() },
  });
  if (result.status !== 0) {
    throw new Error(`update failed (${result.status ?? result.error?.message ?? "unknown"})`);
  }
}

export function runUninstall(): void {
  const prefix = defaultInstallPrefix();
  const candidates = [
    process.env.AGENT_INSTALL_ROOT ? path.join(process.env.AGENT_INSTALL_ROOT, "scripts", "setup.mjs") : "",
    path.join(prefix, "src", "scripts", "setup.mjs"),
  ].filter(Boolean);
  const setup = candidates.find((file) => fs.existsSync(file));
  if (setup) {
    const result = spawnSync(process.execPath, [setup, "--prefix", prefix, "--uninstall"], { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`uninstall failed (${result.status ?? "unknown"})`);
    }
  } else {
    fs.rmSync(path.join(prefix, "src"), { recursive: true, force: true });
    fs.rmSync(path.join(prefix, "bin", "agent"), { force: true });
    fs.rmSync(path.join(prefix, "bin", "agent.cmd"), { force: true });
    fs.rmSync(path.join(prefix, "bin", "agent.exe"), { force: true });
    fs.rmSync(path.join(userBinDir(), "agent"), { force: true });
    fs.rmSync(path.join(userBinDir(), "agent.cmd"), { force: true });
    fs.rmSync(path.join(userBinDir(), "agent.exe"), { force: true });
  }
  const binDir = process.platform === "win32" ? path.join(prefix, "bin") : userBinDir();
  removeUserPath(binDir);
  console.log(`Uninstalled agent from ${prefix}`);
}
