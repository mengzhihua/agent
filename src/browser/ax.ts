import type { BrowserNode } from "./types.js";

export const INTERACTIVE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "switch",
  "slider",
]);

export interface AxValue {
  value?: unknown;
}

export interface AxProperty {
  name: string;
  value?: AxValue;
}

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  backendDOMNodeId?: number;
  childIds?: string[] | number[];
  properties?: AxProperty[];
}

export interface MappedNode extends BrowserNode {
  backendNodeId?: number;
}

export function axToNodes(nodes: AxNode[]): MappedNode[] {
  const out: MappedNode[] = [];
  let n = 1;
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = String(node.role?.value ?? "");
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const name =
      String(node.name?.value ?? "").trim() ||
      String(node.description?.value ?? "").trim() ||
      role;
    const href = axUrl(node);
    const value = node.value?.value === undefined ? undefined : String(node.value.value);
    out.push({
      ref: `e${n++}`,
      role,
      name,
      href,
      value,
      backendNodeId: node.backendDOMNodeId,
    });
  }
  return out;
}

function axUrl(node: AxNode): string | undefined {
  const prop = node.properties?.find((item) => item.name === "url");
  const raw = prop?.value?.value;
  return typeof raw === "string" && raw ? raw : undefined;
}
