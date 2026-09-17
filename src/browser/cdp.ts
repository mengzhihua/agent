export class CdpError extends Error {
  constructor(
    message: string,
    readonly method?: string,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();

  constructor(private readonly ws: WebSocket) {
    this.ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
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
        if (msg.error) waiter.reject(new CdpError(msg.error.message ?? "CDP error"));
        else waiter.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const hooks = this.listeners.get(msg.method);
        if (hooks) for (const hook of hooks) hook(msg.params);
      }
    });
    this.ws.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new CdpError("CDP websocket closed"));
      this.pending.clear();
    });
  }

  send<T = unknown>(method: string, params?: unknown, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
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
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
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
