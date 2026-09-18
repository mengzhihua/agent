import fs from "node:fs";
import type { AgentConfig } from "../types.js";
import { resolveInWorkspace } from "../workspace.js";
import { asOptionalString, asString, type ToolHandler } from "./types.js";

export function artifactTool(config: AgentConfig): ToolHandler {
  return {
    definition: {
      name: "artifact",
      description: `Save or list deliverables in ${config.artifactsDir}. Use this for reports, exports, downloads, and anything the user should keep. Git is optional.`,
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "save", "get"] },
          path: { type: "string", description: "Workspace file to copy into artifacts (save)." },
          filename: { type: "string", description: "Name to use when saving content." },
          content: { type: "string", description: "Inline text to save as an artifact." },
          title: { type: "string" },
          kind: { type: "string", enum: ["file", "page", "screenshot", "download", "report"] },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    execute: async (args, ctx) => {
      if (!ctx.runtime) throw new Error("artifacts runtime is not available");
      const action = asString(args, "action");
      if (action === "list") {
        const items = ctx.runtime.artifacts.list();
        if (items.length === 0) return "(no artifacts)";
        return items.map((item) => `${item.kind}  ${item.path}  ${item.title}`).join("\n");
      }
      if (action === "get") {
        const rel = asString(args, "path");
        const hit = ctx.runtime.artifacts.list().find((item) => item.path === rel || item.path.endsWith(rel));
        if (!hit) throw new Error(`artifact not found: ${rel}`);
        return JSON.stringify(hit, null, 2);
      }
      if (action === "save") {
        const title = asOptionalString(args, "title") || "artifact";
        const kind = (asOptionalString(args, "kind") as "file" | "report" | "download" | undefined) ?? "file";
        const from = asOptionalString(args, "path");
        if (from) {
          const abs = resolveInWorkspace(
            ctx.runtime.workspace ?? config.workspace,
            from,
            ctx.runtime.extraRoots ?? [],
          );
          if (!fs.existsSync(abs)) throw new Error(`file not found: ${from}`);
          const saved = ctx.runtime.artifacts.copyFrom(abs, title, ctx.runtime.sessionId);
          return `saved ${saved.path}`;
        }
        const content = asString(args, "content");
        const filename = asOptionalString(args, "filename") || "note.txt";
        const saved = ctx.runtime.artifacts.save({
          title,
          kind: kind === "download" ? "download" : kind === "report" ? "report" : "file",
          filename,
          content,
          sessionId: ctx.runtime.sessionId,
        });
        return `saved ${saved.path}`;
      }
      throw new Error(`unknown artifact action: ${action}`);
    },
  };
}
