import { formatSnapshot, sensitiveWarning, type BrowserDriver, type BrowserNode, type PageView } from "./types.js";

export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decode(stripTags(match[1] ?? "")).trim() : "";
}

export function extractNodes(html: string): BrowserNode[] {
  const nodes: BrowserNode[] = [];
  let n = 1;
  const nextRef = () => `e${n++}`;
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const href = attr(match[1] ?? "", "href");
    const name = decode(stripTags(match[2] ?? "")).trim() || href || "link";
    nodes.push({ ref: nextRef(), role: "link", name, href });
  }
  const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((match = buttonRe.exec(html)) !== null) {
    nodes.push({
      ref: nextRef(),
      role: "button",
      name: decode(stripTags(match[2] ?? "")).trim() || attr(match[1] ?? "", "name") || "button",
    });
  }
  const inputRe = /<input\b([^>]*)\/?>/gi;
  while ((match = inputRe.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const type = (attr(attrs, "type") || "text").toLowerCase();
    if (type === "hidden") continue;
    nodes.push({
      ref: nextRef(),
      role: type === "submit" || type === "button" ? "button" : "textbox",
      name: attr(attrs, "name") || attr(attrs, "placeholder") || attr(attrs, "aria-label") || type,
      value: attr(attrs, "value"),
    });
  }
  return nodes;
}

function attr(raw: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(raw);
  if (!match) return undefined;
  return match[2] ?? match[3] ?? match[4];
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decode(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

export class HtmlDriver implements BrowserDriver {
  private currentUrl = "about:blank";
  private currentHtml = "";
  private nodes: BrowserNode[] = [];
  private readonly values = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async open(url: string, signal: AbortSignal): Promise<PageView> {
    const res = await this.fetchImpl(url, { signal, redirect: "follow", headers: { "user-agent": "agent-harness/0.3" } });
    if (!res.ok) throw new Error(`browser HTTP ${res.status} for ${url}`);
    this.currentUrl = res.url || url;
    this.currentHtml = await res.text();
    this.nodes = extractNodes(this.currentHtml);
    this.values.clear();
    return this.snapshot();
  }

  async click(ref: string, signal: AbortSignal): Promise<PageView> {
    const node = this.require(ref);
    if (node.role === "link" && node.href) {
      return this.open(new URL(node.href, this.currentUrl).toString(), signal);
    }
    return this.snapshot();
  }

  async type(ref: string, text: string): Promise<PageView> {
    this.require(ref);
    this.values.set(ref, text);
    return this.snapshot();
  }

  private require(ref: string): BrowserNode {
    const node = this.nodes.find((item) => item.ref === ref);
    if (!node) throw new Error(`unknown browser ref: ${ref}`);
    return node;
  }

  snapshot(): PageView {
    const nodes = this.nodes.map((node) => ({
      ...node,
      value: this.values.get(node.ref) ?? node.value,
    }));
    return {
      url: this.currentUrl,
      title: extractTitle(this.currentHtml) || this.currentUrl,
      warning: sensitiveWarning(this.currentUrl),
      nodes,
    };
  }

  html(): string {
    return this.currentHtml;
  }

  url(): string {
    return this.currentUrl;
  }

  async close(): Promise<void> {
    this.currentUrl = "about:blank";
    this.currentHtml = "";
    this.nodes = [];
    this.values.clear();
  }
}

export { formatSnapshot };
