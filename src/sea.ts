export function runningAsSea(): boolean {
  try {
    const proc = process as typeof process & {
      getBuiltinModule?: (id: string) => { isSea?: () => boolean };
    };
    return Boolean(proc.getBuiltinModule?.("node:sea")?.isSea?.());
  } catch {
    return false;
  }
}
