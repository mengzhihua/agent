export type NotifyFn = (params: unknown) => void;
export type RequestFn = (method: string, params: unknown) => Promise<unknown>;
