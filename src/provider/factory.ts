import type { AgentConfig, Provider } from "../types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { ScriptedProvider } from "./scripted.js";

export function createProvider(config: AgentConfig, scripted?: ScriptedProvider): Provider {
  if (config.provider === "scripted") {
    if (!scripted) throw new Error("scripted provider instance is required");
    return scripted;
  }
  if (config.provider === "anthropic") return createAnthropicProvider();
  return createOpenAIProvider();
}

export { ScriptedProvider } from "./scripted.js";
