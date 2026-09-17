import { describe, expect, it } from "vitest";
import { CdpClient, CdpError } from "../src/browser/cdp.js";

class FakeSocket extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe("CdpClient", () => {
  it("times out a send that never gets a reply", async () => {
    const ws = new FakeSocket() as unknown as WebSocket & FakeSocket;
    const client = new CdpClient(ws);
    await expect(client.send("Runtime.evaluate", { expression: "1" }, undefined, 20)).rejects.toBeInstanceOf(CdpError);
    client.close();
  });

  it("resolves JSON results and ignores non-JSON frames", async () => {
    const ws = new FakeSocket() as unknown as WebSocket & FakeSocket;
    const client = new CdpClient(ws);
    const pending = client.send<{ ok: boolean }>("Page.enable");
    const id = JSON.parse(ws.sent[0]!).id as number;
    ws.emitMessage("not-json");
    ws.emitMessage(JSON.stringify({ id, result: { ok: true } }));
    await expect(pending).resolves.toEqual({ ok: true });
    client.close();
  });
});
