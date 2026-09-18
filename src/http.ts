export interface RetryOptions {
  fetch?: typeof fetch;
  retries?: number;
  retryOn?: number[];
  baseDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const RETRY_STATUS = [429, 500, 502, 503, 529];

export function retryDelayMs(res: Response, attempt: number, baseDelayMs = 200): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 8_000);
  }
  return Math.min(baseDelayMs * 2 ** attempt, 8_000);
}

export async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const fetchFn = options.fetch ?? fetch;
  const retries = options.retries ?? 3;
  const retryOn = new Set(options.retryOn ?? RETRY_STATUS);
  const sleep = options.sleep ?? defaultSleep;
  let last: Response | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init.signal?.aborted) {
      throw init.signal.reason instanceof Error ? init.signal.reason : new Error("aborted");
    }
    last = await fetchFn(url, init);
    if (!retryOn.has(last.status) || attempt === retries) return last;
    await sleep(retryDelayMs(last, attempt, options.baseDelayMs ?? 200), init.signal ?? undefined);
  }
  return last!;
}
