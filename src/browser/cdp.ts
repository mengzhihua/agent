export class CdpError extends Error {
  constructor(
    message: string,
    readonly method?: string,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

const DEFAULT_SEND_TIMEOUT_MS = 15_000;

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();

  constructor(private readonly ws: WebSocket) {
    this.ws.addEventListener("message", (event) => {
      const raw = decodeCdpMessage(event.data);
      if (raw === undefined) return;
      let msg: { id?: number; method?: string; params?: unknown; error?: { message?: string }; result?: unknown };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.error) waiter.reject(new CdpError(msg.error.message ?? "CDP error", undefined));
        else waiter.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const hooks = this.listeners.get(msg.method);
        if (hooks) for (const hook of hooks) hook(msg.params);
      }
    });
    this.ws.addEventListener("close", () => this.failPending(new CdpError("CDP websocket closed")));
  }

  send<T = unknown>(method: string, params?: unknown, sessionId?: string, timeoutMs = DEFAULT_SEND_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP ${method} timed out after ${timeoutMs}ms`, method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new CdpError(String(err), method));
      }
    });
  }

  waitOnce(method: string, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(method, handler);
        reject(new CdpError(`timed out waiting for ${method}`, method));
      }, timeoutMs);
      const handler = (params: unknown) => {
        clearTimeout(timer);
        this.off(method, handler);
        resolve(params);
      };
      this.on(method, handler);
    });
  }

  on(method: string, handler: (params: unknown) => void): void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(handler);
    this.listeners.set(method, set);
  }

  off(method: string, handler: (params: unknown) => void): void {
    this.listeners.get(method)?.delete(handler);
  }

  close(): void {
    this.failPending(new CdpError("CDP websocket closed"));
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  private failPending(err: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }
}

export async function openCdp(url: string): Promise<CdpClient> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CdpError(`CDP connect timed out: ${url}`)), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new CdpError(`CDP connect failed: ${url}`));
    });
  });
  return new CdpClient(ws);
}

function decodeCdpMessage(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return undefined;
}
