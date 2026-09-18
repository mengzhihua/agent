const SECRET_NAME = /key|token|secret|password|credential|passwd/i;

const KEEP = new Set([
  "PATH",
  "Path",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TERM",
  "SHELL",
  "TMPDIR",
  "PWD",
  "NODE_ENV",
  "TZ",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "windir",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramW6432",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

export function filterSandboxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (KEEP.has(key) || key.startsWith("LC_")) {
      out[key] = value;
      continue;
    }
    if (SECRET_NAME.test(key)) continue;
    out[key] = value;
  }
  out.TERM = out.TERM ?? "dumb";
  return out;
}
