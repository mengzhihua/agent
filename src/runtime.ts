import { ArtifactStore } from "./artifacts/store.js";
import { BrowserSession } from "./browser/session.js";
import type { AgentConfig } from "./types.js";

export interface AskUserRequest {
  question: string;
  choices?: string[];
}

export type AskUserFn = (request: AskUserRequest) => Promise<string>;

export interface SessionRuntime {
  sessionId: string;
  artifacts: ArtifactStore;
  browser: BrowserSession;
  askUser?: AskUserFn;
}

export function createSessionRuntime(
  sessionId: string,
  config: AgentConfig,
  extras: { artifacts?: ArtifactStore; browser?: BrowserSession; askUser?: AskUserFn } = {},
): SessionRuntime {
  return {
    sessionId,
    artifacts: extras.artifacts ?? new ArtifactStore(config.artifactsDir, config.workspace),
    browser: extras.browser ?? new BrowserSession(),
    askUser: extras.askUser,
  };
}
