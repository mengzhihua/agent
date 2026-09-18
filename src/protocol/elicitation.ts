import type { AskUserRequest } from "../runtime.js";
import type { RequestFn } from "./rpc.js";

export interface ClientElicitationCaps {
  form: boolean;
  url: boolean;
}

export interface ElicitationResult {
  action: "accept" | "decline" | "cancel" | string;
  content?: Record<string, unknown>;
}

export function parseElicitationCapabilities(params: unknown): ClientElicitationCaps {
  const empty = { form: false, url: false };
  if (!params || typeof params !== "object") return empty;
  const caps = (params as Record<string, unknown>).clientCapabilities;
  if (!caps || typeof caps !== "object") return empty;
  const elicitation = (caps as Record<string, unknown>).elicitation;
  if (!elicitation || typeof elicitation !== "object") return empty;
  const row = elicitation as Record<string, unknown>;
  return {
    form: row.form !== undefined && row.form !== null,
    url: row.url !== undefined && row.url !== null,
  };
}

export function askUserSchema(choices?: string[]): Record<string, unknown> {
  const unique = [...new Set((choices ?? []).map((choice) => choice.trim()).filter(Boolean))];
  const answer: Record<string, unknown> =
    unique.length > 0
      ? {
          type: "string",
          title: "Answer",
          enum: unique,
        }
      : {
          type: "string",
          title: "Answer",
          minLength: 1,
        };
  return {
    type: "object",
    properties: { answer },
    required: ["answer"],
  };
}

export function parseElicitationResult(raw: unknown): ElicitationResult {
  if (!raw || typeof raw !== "object") return { action: "cancel" };
  const root = raw as Record<string, unknown>;
  const nested = root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : root;
  const action = String(nested.action ?? nested.outcome ?? "cancel");
  const content = asContent(nested.content);
  return { action, content };
}

export function contentToAnswer(content?: Record<string, unknown>): string {
  if (!content) return "";
  const answer = content.answer;
  if (typeof answer === "string") return answer;
  if (typeof answer === "number" || typeof answer === "boolean") return String(answer);
  const values = Object.values(content).filter((value) => value !== undefined && value !== null);
  if (values.length === 1 && (typeof values[0] === "string" || typeof values[0] === "number" || typeof values[0] === "boolean")) {
    return String(values[0]);
  }
  if (values.length === 0) return "";
  return JSON.stringify(content);
}

export async function elicitAskUser(
  sessionId: string,
  request: RequestFn,
  input: AskUserRequest,
): Promise<string> {
  const raw = await request("elicitation/create", {
    sessionId,
    ...(input.callId ? { toolCallId: input.callId } : {}),
    mode: "form",
    message: input.question,
    requestedSchema: askUserSchema(input.choices),
  });
  const parsed = parseElicitationResult(raw);
  if (parsed.action === "decline") throw new Error("User declined the question");
  if (parsed.action !== "accept") throw new Error("User cancelled the question");
  const answer = contentToAnswer(parsed.content);
  if (!answer.trim()) throw new Error("User submitted an empty answer");
  return answer;
}

function asContent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}
