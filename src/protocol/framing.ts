export type Framing = "ndjson" | "lsp";

export function detectFraming(buffer: string): Framing | undefined {
  if (/^Content-Length:/i.test(buffer)) return "lsp";
  const trimmed = buffer.trimStart();
  if (trimmed.startsWith("{") && buffer.includes("\n")) return "ndjson";
  return undefined;
}

export function encodeMessage(msg: unknown, framing: Framing): string {
  const json = JSON.stringify(msg);
  if (framing === "lsp") {
    return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  }
  return `${json}\n`;
}

export function extractMessages(
  buffer: string,
  framing: Framing | undefined,
): { messages: unknown[]; rest: string; framing: Framing | undefined } {
  const detected = framing ?? detectFraming(buffer);
  if (!detected) return { messages: [], rest: buffer, framing };
  if (detected === "ndjson") {
    const lines = buffer.split("\n");
    const rest = lines.pop() ?? "";
    const messages: unknown[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      messages.push(JSON.parse(trimmed));
    }
    return { messages, rest, framing: "ndjson" };
  }
  const messages: unknown[] = [];
  let rest = buffer;
  while (true) {
    const header = rest.match(/^Content-Length:\s*(\d+)\r\n\r\n/i);
    if (!header) break;
    const size = Number(header[1]);
    const start = header[0].length;
    const body = rest.slice(start);
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes < size) break;
    // body may have extra after `size` utf8 bytes
    let acc = "";
    for (const ch of body) {
      acc += ch;
      if (Buffer.byteLength(acc, "utf8") === size) break;
    }
    if (Buffer.byteLength(acc, "utf8") < size) break;
    messages.push(JSON.parse(acc));
    rest = body.slice(acc.length);
  }
  return { messages, rest, framing: "lsp" };
}
