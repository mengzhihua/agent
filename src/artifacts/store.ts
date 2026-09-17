import fs from "node:fs";
import path from "node:path";
import { newId, nowIso } from "../ids.js";
import type { Artifact } from "../types.js";
import { ensureDir, toWorkspacePath } from "../workspace.js";

export class ArtifactStore {
  readonly items: Artifact[] = [];

  constructor(
    readonly root: string,
    readonly workspace: string,
  ) {
    ensureDir(root);
  }

  count(): number {
    return this.items.length;
  }

  addedSince(index: number): Artifact[] {
    return this.items.slice(index);
  }

  list(): Artifact[] {
    return [...this.items];
  }

  save(input: {
    title: string;
    kind: Artifact["kind"];
    filename: string;
    content: string | Buffer;
    sessionId?: string;
  }): Artifact {
    const folder = input.sessionId ? path.join(this.root, input.sessionId) : this.root;
    ensureDir(folder);
    const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "artifact.bin";
    const abs = path.join(folder, `${newId("f")}-${safe}`);
    fs.writeFileSync(abs, input.content);
    const artifact: Artifact = {
      id: newId("art"),
      title: input.title,
      kind: input.kind,
      path: toWorkspacePath(this.workspace, abs),
      createdAt: nowIso(),
    };
    this.items.push(artifact);
    fs.appendFileSync(path.join(this.root, "manifest.jsonl"), `${JSON.stringify(artifact)}\n`);
    return artifact;
  }

  copyFrom(absPath: string, title: string, sessionId?: string): Artifact {
    const filename = path.basename(absPath);
    return this.save({
      title,
      kind: "file",
      filename,
      content: fs.readFileSync(absPath),
      sessionId,
    });
  }
}
