import type { AgentConfig } from "../types.js";
import { htmlToText } from "../browser/html.js";
import { truncate } from "../workspace.js";
import { asOptionalString, asString, type ToolHandler } from "./types.js";

export async function webFetchTool(
  url: string,
  maxChars: number,
  signal: AbortSignal,
): Promise<{ text: string; finalUrl: string; contentType: string; html?: string }> {
  const res = await fetch(url, {
    signal,
    redirect: "follow",
    headers: { "user-agent": "agent-harness/0.3" },
  });
  if (!res.ok) throw new Error(`web_fetch HTTP ${res.status} for ${url}`);
  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const text = contentType.includes("html") ? htmlToText(raw) : raw;
  return {
    text: truncate(text, maxChars),
    finalUrl: res.url || url,
    contentType,
    html: contentType.includes("html") ? raw : undefined,
  };
}

export function webFetchDefinition(_config: AgentConfig) {
  return {
    name: "web_fetch",
    description:
      "Fetch a URL and return extracted text. Use for docs and articles. Use browser if you need to click or fill forms. Set save=true to keep a copy under artifacts/.",
    risk: "network" as const,
    parameters: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "http(s) URL to fetch." },
        max_chars: { type: "integer", description: "Maximum characters of extracted text. Default 12000." },
        save: { type: "boolean", description: "Save the page into the artifacts directory." },
        title: { type: "string", description: "Artifact title when save=true." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  };
}

export function webFetchHandler(config: AgentConfig): ToolHandler {
  return {
    definition: webFetchDefinition(config),
    execute: async (args, ctx) => {
      const url = asString(args, "url");
      if (!/^https?:\/\//i.test(url)) throw new Error("url must be http or https");
      const fetched = await webFetchTool(url, asOptionalNumberSafe(args.max_chars) ?? 12_000, ctx.signal);
      const header = `url: ${fetched.finalUrl}\ncontent-type: ${fetched.contentType}`;
      if (args.save === true) {
        if (!ctx.runtime) throw new Error("artifacts runtime is not available");
        const host = safeHost(fetched.finalUrl);
        const artifact = ctx.runtime.artifacts.save({
          title: asOptionalString(args, "title") || fetched.finalUrl,
          kind: "page",
          filename: `${host}.txt`,
          content: `${header}\n\n${fetched.text}`,
          sessionId: ctx.runtime.sessionId,
        });
        if (fetched.html) {
          ctx.runtime.artifacts.save({
            title: `${artifact.title} (html)`,
            kind: "page",
            filename: `${host}.html`,
            content: fetched.html,
            sessionId: ctx.runtime.sessionId,
          });
        }
        return `${header}\nartifact: ${artifact.path}\n\n${fetched.text}`;
      }
      return `${header}\n\n${fetched.text}`;
    },
  };
}

function asOptionalNumberSafe(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_") || "page";
  } catch {
    return "page";
  }
}
