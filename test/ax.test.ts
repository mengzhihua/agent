import { describe, expect, it } from "vitest";
import { axToNodes } from "../src/browser/ax.js";

describe("axToNodes", () => {
  it("keeps interactive nodes and assigns e-refs", () => {
    const mapped = axToNodes([
      { nodeId: "1", role: { value: "WebArea" }, name: { value: "Demo" }, ignored: false },
      {
        nodeId: "2",
        role: { value: "link" },
        name: { value: "Next" },
        properties: [{ name: "url", value: { value: "http://127.0.0.1/next" } }],
        backendDOMNodeId: 10,
      },
      { nodeId: "3", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 11 },
      { nodeId: "4", role: { value: "textbox" }, name: { value: "search" }, value: { value: "" }, backendDOMNodeId: 12 },
      { nodeId: "5", ignored: true, role: { value: "button" }, name: { value: "hidden" } },
    ]);
    expect(mapped.map((node) => node.ref)).toEqual(["e1", "e2", "e3"]);
    expect(mapped[0]).toMatchObject({ role: "link", name: "Next", href: "http://127.0.0.1/next", backendNodeId: 10 });
    expect(mapped[1]?.role).toBe("button");
    expect(mapped[2]?.role).toBe("textbox");
  });
});
