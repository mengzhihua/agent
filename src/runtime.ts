import { ArtifactStore } from "./artifacts/store.js";
import { createBrowserDriver } from "./browser/chrome.js";
import { BrowserSession } from "./browser/session.js";
import { diskFileIo, type FileIo } from "./files/io.js";
import type { McpManager } from "./mcp/manager.js";
import type { AcpTerminal } from "./protocol/terminal.js";
import type { AgentConfig } from "./types.js";
import type { ToolRegistry } from "./tools/registry.js";

export interface AskUserRequest {
  question: string;
  choices?: string[];
  callId?: string;
}

export type AskUserFn = (request: AskUserRequest) => Promise<string>;

export interface SessionRuntime {
  sessionId: string;
  workspace: string;
  artifacts: ArtifactStore;
  browser: BrowserSession;
  files: FileIo;
  extraRoots: string[];
  askUser?: AskUserFn;
  terminal?: AcpTerminal;
  onTerminal?: (callId: string, terminalId: string) => void;
  tools?: ToolRegistry;
  mcp?: McpManager;
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
    extraRoots?: string[];
  } = {},
): SessionRuntime {
  const workspace = extras.workspace ?? config.workspace;
  const extraRoots = extras.extraRoots ?? [];
  return {
    sessionId,
    workspace,
    extraRoots,
    artifacts: extras.artifacts ?? new ArtifactStore(config.artifactsDir, workspace),
    browser: extras.browser ?? new BrowserSession(createBrowserDriver(config.browserBackend)),
    files: extras.files ?? diskFileIo(workspace, extraRoots),
    askUser: extras.askUser,
  };
}
