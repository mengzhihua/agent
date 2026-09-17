import { ArtifactStore } from "./artifacts/store.js";
import { createBrowserDriver } from "./browser/chrome.js";
import { BrowserSession } from "./browser/session.js";
import { diskFileIo, type FileIo } from "./files/io.js";
import type { AgentConfig } from "./types.js";

export interface AskUserRequest {
  question: string;
  choices?: string[];
}

export type AskUserFn = (request: AskUserRequest) => Promise<string>;

export interface SessionRuntime {
  sessionId: string;
  workspace: string;
  artifacts: ArtifactStore;
  browser: BrowserSession;
  files: FileIo;
  askUser?: AskUserFn;
}

export function createSessionRuntime(
  sessionId: string,
  config: AgentConfig,
  extras: {
    artifacts?: ArtifactStore;
    browser?: BrowserSession;
    askUser?: AskUserFn;
    files?: FileIo;
    workspace?: string;
  } = {},
): SessionRuntime {
  const workspace = extras.workspace ?? config.workspace;
  return {
    sessionId,
    workspace,
    artifacts: extras.artifacts ?? new ArtifactStore(config.artifactsDir, workspace),
    browser: extras.browser ?? new BrowserSession(createBrowserDriver(config.browserBackend)),
    files: extras.files ?? diskFileIo(workspace),
    askUser: extras.askUser,
  };
}
