import type { AgentConfig } from "../types.js";
import { BrowserSession } from "../browser/session.js";
import { asOptionalString, asString, type ToolHandler } from "./types.js";

function session(ctx: { runtime?: { browser: BrowserSession } }): BrowserSession {
  if (!ctx.runtime) throw new Error("browser runtime is not available");
  return ctx.runtime.browser;
}

export function browserTool(config: AgentConfig): ToolHandler {
  return {
    definition: {
      name: "browser",
      description: `Control a workspace browser (${config.browserBackend === "chrome" ? "Chrome CDP" : "HTML fetch"}). Actions: open, snapshot, click, type, screenshot, close, takeover. Use takeover on login/captcha/payment pages. Screenshots land in ${config.artifactsDir}.`,
      risk: "exec",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["open", "snapshot", "click", "type", "screenshot", "close", "takeover"],
          },
          url: { type: "string", description: "Required for open and takeover." },
          ref: { type: "string", description: "Node ref from snapshot, e.g. e1." },
          text: { type: "string", description: "Text to type into a textbox ref." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    execute: async (args, ctx) => {
      const action = asString(args, "action");
      const browser = session(ctx);
      if (action === "open") {
        return browser.open(asString(args, "url"), ctx.signal);
      }
      if (action === "snapshot") return browser.snapshot();
      if (action === "click") return browser.click(asString(args, "ref"), ctx.signal);
      if (action === "type") return browser.type(asString(args, "ref"), asString(args, "text"));
      if (action === "screenshot") {
        if (!ctx.runtime) throw new Error("artifacts runtime is not available");
        const view = browser.view();
        const shot = await browser.screenshot();
        const artifact = ctx.runtime.artifacts.save({
          title: view.title || view.url || "screenshot",
          kind: "screenshot",
          filename: shot.filename,
          content: shot.buffer,
          sessionId: ctx.runtime.sessionId,
        });
        return `saved ${artifact.path}\n${browser.snapshot()}`;
      }
      if (action === "close") {
        await browser.close();
        return "browser closed";
      }
      if (action === "takeover") {
        const url = asOptionalString(args, "url") || browser.url();
        if (!url || url === "about:blank") throw new Error("nothing to take over; open a page first");
        if (!ctx.runtime?.askUser) {
          throw new Error(
            `User takeover needed for ${url}, but this session has no human. Open the URL yourself, then retry.`,
          );
        }
        const answer = await ctx.runtime.askUser({
          question: `Take over the browser for ${url}. Finish login/captcha/payment, then tell me when I can continue.`,
        });
        try {
          await browser.open(url, ctx.signal);
        } catch {
          // page may not be fetchable after a human login; keep previous snapshot
        }
        return `User returned: ${answer}\n${browser.snapshot()}`;
      }
      throw new Error(`unknown browser action: ${action}`);
    },
  };
}
