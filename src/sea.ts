export function runningAsSea(): boolean {
  try {
    return Boolean(seaApi()?.isSea?.());
  } catch {
    return false;
  }
}

export function getSeaAsset(key: string): string | undefined {
  try {
    const sea = seaApi();
    if (!sea?.isSea?.() || typeof sea.getAsset !== "function") return undefined;
    const value = sea.getAsset(key, "utf8");
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function seaApi(): { isSea?: () => boolean; getAsset?: (key: string, encoding?: string) => unknown } | undefined {
  const proc = process as typeof process & {
    getBuiltinModule?: (id: string) => { isSea?: () => boolean; getAsset?: (key: string, encoding?: string) => unknown };
  };
  return proc.getBuiltinModule?.("node:sea");
}
