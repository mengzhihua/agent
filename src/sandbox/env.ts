const SECRET_NAME = /key|token|secret|password|credential|passwd/i;

const KEEP = new Set([
  "PATH",
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
