export interface EvalStep {
  name: string;
  arguments: Record<string, unknown>;
}

export interface EvalCase {
  name: string;
  workspace: string;
  steps: EvalStep[];
  assert?: {
    fileContains?: Record<string, string>;
    notFileContains?: Record<string, string>;
  };
}

export interface EvalResult {
  name: string;
  ok: boolean;
  error?: string;
  outputs: Array<{ name: string; content: string; isError?: boolean }>;
}
