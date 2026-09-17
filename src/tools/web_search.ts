import type { AgentConfig } from "../types.js";
import { truncate } from "../workspace.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

async function searchDuckDuckGo(query: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: { "user-agent": "agent-harness/0.1" },
  });
  if (!res.ok) {
    throw new Error(`search HTTP ${res.status}`);
  }
  const html = await res.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && hits.length < count) {
    const href = decodeXml(match[1] ?? "");
    const title = decodeXml(stripTags(match[2] ?? "")).trim();
    if (title && href) hits.push({ title, url: unwrapDdg(href) });
  }
  return hits;
}

function unwrapDdg(href: string): string {
  try {
    const parsed = new URL(href, "https://html.duckduckgo.com/");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ?? href;
  } catch {
    return href;
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'");
}

export async function webSearchTool(
  query: string,
  count = 5,
  signal: AbortSignal,
  fetchImpl: typeof searchDuckDuckGo = searchDuckDuckGo,
): Promise<string> {
  const hits = await fetchImpl(query, count, signal);
  if (hits.length === 0) return "(no results)";
  return truncate(
    hits
      .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ""}`)
      .join("\n"),
    16 * 1024,
  );
}

export function webSearchDefinition(_config: AgentConfig) {
  return {
    name: "web_search",
    description: "Search the public web. Use for docs, APIs, and facts not in the workspace.",
    risk: "network" as const,
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query." },
        count: { type: "integer", description: "Number of results. Default 5." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}
