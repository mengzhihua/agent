import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function bwrapArgs(workspace: string, cwd: string, command: string, extraBinds: string[] = []): string[] {
  const args = [
    "--unshare-net",
    "--unshare-pid",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/var/tmp",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  const home = os.homedir();
  if (home) args.push("--tmpfs", home);
  args.push("--bind", workspace, workspace);
  const seen = new Set([path.resolve(workspace)]);
  for (const extra of extraBinds) {
    const resolved = path.resolve(extra);
    if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);
    args.push("--bind", resolved, resolved);
  }
  args.push("--chdir", cwd, "--", "/bin/sh", "-c", command);
  return args;
}

export function hasBwrap(lookup = "bwrap"): boolean {
  if (process.platform !== "linux") return false;
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, lookup), fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}
