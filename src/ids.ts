import { randomBytes } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix = ""): string {
  const id = randomBytes(6).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
