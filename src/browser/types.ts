export interface BrowserNode {
  ref: string;
  role: string;
  name: string;
  href?: string;
  value?: string;
}

export interface PageView {
  url: string;
  title: string;
  warning?: string;
  nodes: BrowserNode[];
}

export interface BrowserDriver {
  open(url: string, signal: AbortSignal): Promise<PageView>;
  click(ref: string, signal: AbortSignal): Promise<PageView>;
  type(ref: string, text: string): Promise<PageView>;
  snapshot(): PageView;
  html(): string;
  url(): string;
  close(): Promise<void>;
}

export const SENSITIVE_URL =
  /login|signin|sign-in|password|captcha|challenge|checkout|verify|accounts\.google|paypal|bank/i;

export function sensitiveWarning(url: string): string | undefined {
  if (!SENSITIVE_URL.test(url)) return undefined;
  return "This page looks sensitive (login/captcha/payment). Prefer browser action=takeover and let the user finish it.";
}

export function formatSnapshot(view: PageView): string {
  const lines = [`url: ${view.url}`, `title: ${view.title}`];
  if (view.warning) lines.push(`warning: ${view.warning}`);
  if (view.nodes.length === 0) lines.push("(no interactive nodes)");
  for (const node of view.nodes) {
    const extra = [node.href ? `href=${node.href}` : "", node.value ? `value=${node.value}` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`${node.ref}  ${node.role}  ${JSON.stringify(node.name)}${extra ? `  ${extra}` : ""}`);
  }
  return lines.join("\n");
}
