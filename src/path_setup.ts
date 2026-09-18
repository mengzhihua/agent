import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const PATH_MARKER = "# agent PATH";

export interface PathSetupResult {
  binDir: string;
  alreadyOnPath: boolean;
  changed: boolean;
  files: string[];
  message: string;
}

export function pathEntryPresent(binDir: string, pathEnv = process.env.PATH ?? process.env.Path ?? ""): boolean {
  const want = path.resolve(binDir);
  return pathEnv.split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      return path.resolve(dir) === want;
    } catch {
      return dir.replace(/[/\\]+$/, "").toLowerCase() === want.replace(/[/\\]+$/, "").toLowerCase();
    }
  });
}

export function unixEnvScript(binDir: string): string {
  const posix = binDir.split(path.sep).join("/");
  return `${PATH_MARKER}\nexport PATH="${posix}:$PATH"\n`;
}

export function unixRcSnippet(envFile: string): string {
  const posix = envFile.split(path.sep).join("/");
  return `${PATH_MARKER}\n[ -f "${posix}" ] && . "${posix}"\n`;
}

export function appendOnce(file: string, block: string): boolean {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.includes(PATH_MARKER)) return false;
  const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "" : "\n";
  const body = block.endsWith("\n") ? block : `${block}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${existing}${prefix}${existing.length === 0 ? "" : "\n"}${body}`);
  return true;
}

export function stripMarkerBlock(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const existing = fs.readFileSync(file, "utf8");
  if (!existing.includes(PATH_MARKER)) return false;
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(PATH_MARKER)) {
      if (i + 1 < lines.length) i += 1;
      if (i + 1 < lines.length && lines[i + 1] === "") i += 1;
      continue;
    }
    out.push(lines[i]);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  const next = out.length === 0 ? "" : `${out.join(newline)}${newline}`;
  fs.writeFileSync(file, next);
  return true;
}

export function windowsPathAppendScript(binDir: string): string {
  const escaped = binDir.replace(/'/g, "''");
  return `
$dir = '${escaped}'
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $current) { $current = '' }
$parts = @()
foreach ($item in $current.Split(';')) {
  if (-not $item) { continue }
  if ($item.TrimEnd('\\').ToLower() -eq $dir.TrimEnd('\\').ToLower()) { continue }
  $parts += $item
}
$joined = $dir
if ($parts.Count -gt 0) { $joined = $dir + ';' + ($parts -join ';') }
[Environment]::SetEnvironmentVariable('Path', $joined, 'User')
`.trim();
}

export function windowsPathRemoveScript(binDir: string): string {
  const escaped = binDir.replace(/'/g, "''");
  return `
$dir = '${escaped}'
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $current) { return }
$parts = @()
foreach ($item in $current.Split(';')) {
  if (-not $item) { continue }
  if ($item.TrimEnd('\\').ToLower() -eq $dir.TrimEnd('\\').ToLower()) { continue }
  $parts += $item
}
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
`.trim();
}

export function ensureUserPath(
  binDir: string,
  opts: { home?: string; apply?: boolean } = {},
): PathSetupResult {
  const home = opts.home ?? os.homedir();
  const apply = opts.apply !== false;
  const alreadyOnPath = pathEntryPresent(binDir);
  const files: string[] = [];
  let changed = false;

  if (process.platform === "win32") {
    if (apply) {
      const result = spawnSync("powershell", ["-NoProfile", "-Command", windowsPathAppendScript(binDir)], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || result.error?.message || result.status).trim();
        return {
          binDir,
          alreadyOnPath,
          changed: false,
          files,
          message: `Could not update user PATH: ${detail}`,
        };
      }
      changed = true;
    }
    return {
      binDir,
      alreadyOnPath,
      changed,
      files,
      message: alreadyOnPath
        ? `PATH already contains ${binDir}`
        : `Added ${binDir} to the user PATH. Open a new terminal.`,
    };
  }

  const envFile = path.join(home, ".agent", "env.sh");
  if (apply) {
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, unixEnvScript(binDir));
    files.push(envFile);
    const snippet = unixRcSnippet(envFile);
    for (const name of [".profile", ".bashrc", ".zshrc", ".zprofile"]) {
      const rc = path.join(home, name);
      if (name !== ".profile" && !fs.existsSync(rc)) continue;
      if (appendOnce(rc, snippet)) {
        changed = true;
        files.push(rc);
      }
    }
  }

  return {
    binDir,
    alreadyOnPath,
    changed: changed || !alreadyOnPath,
    files,
    message: alreadyOnPath && !changed
      ? `PATH already contains ${binDir}`
      : `PATH helper installed. Open a new terminal or run: . "${envFile}"`,
  };
}

export function removeUserPath(binDir: string, opts: { home?: string; apply?: boolean } = {}): void {
  const home = opts.home ?? os.homedir();
  const apply = opts.apply !== false;
  if (!apply) return;
  if (process.platform === "win32") {
    spawnSync("powershell", ["-NoProfile", "-Command", windowsPathRemoveScript(binDir)], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  fs.rmSync(path.join(home, ".agent", "env.sh"), { force: true });
  for (const name of [".profile", ".bashrc", ".zshrc", ".zprofile"]) {
    stripMarkerBlock(path.join(home, name));
  }
}
