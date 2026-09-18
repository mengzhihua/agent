import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellInvocation {
  command: string;
  argsPrefix: string[];
}

export function whichProgram(name: string): string | undefined {
  if (!name) return undefined;
  if (name.includes("/") || name.includes("\\")) {
    return fs.existsSync(name) ? name : undefined;
  }
  const pathEnv = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, ext ? (name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext) : name);
      try {
        fs.accessSync(full, fs.constants.F_OK);
        if (process.platform !== "win32") fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

export function defaultShell(): ShellInvocation {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    return { command: comspec, argsPrefix: ["/d", "/s", "/c"] };
  }
  const fromEnv = process.env.SHELL;
  const command = fromEnv && (fromEnv.startsWith("/") || fs.existsSync(fromEnv)) ? fromEnv : "/bin/sh";
  return { command, argsPrefix: ["-c"] };
}

export function chromeCandidates(explicit?: string): string[] {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ];
  const win = [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  const names =
    process.platform === "win32"
      ? ["chrome.exe", "msedge.exe", "chromium.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium", "chrome", "msedge"];
  return [
    explicit,
    process.env.AGENT_CHROME,
    process.env.CHROME_PATH,
    ...(process.platform === "darwin" ? mac : []),
    ...(process.platform === "win32" ? win : []),
    ...names,
  ].filter((item): item is string => Boolean(item));
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function userBinDir(): string {
  if (process.platform === "win32") return path.join(os.homedir(), ".agent", "bin");
  const local = path.join(os.homedir(), ".local", "bin");
  return local;
}

export function defaultInstallPrefix(): string {
  return process.env.AGENT_PREFIX || path.join(os.homedir(), ".agent");
}
