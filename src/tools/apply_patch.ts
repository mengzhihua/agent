import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "../types.js";
import { resolveInWorkspace, toWorkspacePath } from "../workspace.js";

type Edit = { old_string: string; new_string: string };

function collectEdits(args: Record<string, unknown>): Edit[] {
  if (Array.isArray(args.edits)) {
    return args.edits.map((edit) => {
      if (!edit || typeof edit !== "object") throw new Error("invalid edit");
      const row = edit as Record<string, unknown>;
      if (typeof row.new_string !== "string") throw new Error("edit.new_string required");
      return {
        old_string: typeof row.old_string === "string" ? row.old_string : "",
        new_string: row.new_string,
      };
    });
  }
  if (typeof args.new_string !== "string") {
    throw new Error("new_string or edits is required");
  }
  return [
    {
      old_string: typeof args.old_string === "string" ? args.old_string : "",
      new_string: args.new_string,
    },
  ];
}

export async function applyPatchTool(
  workspace: string,
  relPath: string,
  args: Record<string, unknown>,
): Promise<string> {
  const abs = resolveInWorkspace(workspace, relPath);
  const edits = collectEdits(args);
  let existed = true;
  let content: string;
  try {
    content = await fsp.readFile(abs, "utf8");
  } catch {
    existed = false;
    content = "";
  }

  if (!existed) {
    if (edits.some((edit) => edit.old_string.length > 0)) {
      throw new Error(`file does not exist: ${relPath}`);
    }
    const created = edits.map((edit) => edit.new_string).join("");
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, created, "utf8");
    return `created ${toWorkspacePath(workspace, abs)} (${created.split("\n").length} lines)`;
  }

  let next = content;
  for (const edit of edits) {
    if (edit.old_string.length === 0) {
      throw new Error(`file already exists: ${relPath}. Provide old_string to edit it.`);
    }
    const matches = next.split(edit.old_string).length - 1;
    if (matches === 0) {
      throw new Error(`old_string not found in ${relPath}`);
    }
    if (matches > 1) {
      throw new Error(`old_string matched ${matches} times in ${relPath}; it must be unique`);
    }
    next = next.replace(edit.old_string, edit.new_string);
  }
  await fsp.writeFile(abs, next, "utf8");
  return `updated ${toWorkspacePath(workspace, abs)}`;
}

export function applyPatchDefinition(config: AgentConfig) {
  return {
    name: "apply_patch",
    description: `Create or edit a UTF-8 file in ${config.workspace}. For edits, old_string must match exactly once. Omit old_string to create a new file.`,
    risk: "write" as const,
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path relative to the workspace." },
        old_string: {
          type: "string",
          description: "Exact text to replace. Omit or leave empty when creating a new file.",
        },
        new_string: { type: "string", description: "Replacement text, or full file contents when creating." },
        edits: {
          type: "array",
          description: "Optional list of unique replacements in one file.",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
            },
            required: ["new_string"],
          },
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}
