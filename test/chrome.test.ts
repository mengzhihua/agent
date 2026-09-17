import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ChromeDriver, findChrome } from "../src/browser/chrome.js";
import { loadConfig } from "../src/config.js";

const PAGE = `<!doctype html>
<html>
<head><title>Demo Page</title></head>
<body>
  <h1>Hello</h1>
  <a href="/next">Next</a>
  <button onclick="document.title='Clicked'">Go</button>
  <input type="text" name="q" placeholder="search">
</body>
</html>`;

async function serve(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.keepAliveTimeout = 1;
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/page`,
        close: () =>
          new Promise((done, fail) => {
            server.closeAllConnections();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

describe("chrome backend detection", () => {
  it("selects chrome when the binary exists", () => {
    if (!findChrome()) return;
    const config = loadConfig({ workspace: process.cwd(), browser: "auto" });
    expect(config.browserBackend).toBe("chrome");
    expect(loadConfig({ workspace: process.cwd(), browser: "html" }).browserBackend).toBe("html");
  });
});

describe.skipIf(!findChrome())("Chrome CDP driver", () => {
  let driver: ChromeDriver | undefined;

  afterEach(async () => {
    await driver?.close();
    driver = undefined;
  });

  it(
    "runs page JavaScript, types, and captures a PNG",
    async () => {
      const server = await serve(PAGE);
      driver = new ChromeDriver(findChrome()!);
      try {
        const opened = await driver.open(server.url, new AbortController().signal);
        expect(opened.title).toBe("Demo Page");
        const button = opened.nodes.find((node) => node.role === "button");
        const box = opened.nodes.find((node) => node.role === "textbox" || node.role === "searchbox");
        expect(button?.ref).toMatch(/^e\d+$/);
        expect(box?.ref).toMatch(/^e\d+$/);

        const typed = await driver.type(box!.ref, "agents");
        expect(typed.nodes.some((node) => node.value === "agents")).toBe(true);

        const clicked = await driver.click(button!.ref, new AbortController().signal);
        expect(clicked.title).toBe("Clicked");

        const shot = await driver.screenshot();
        expect(shot.filename).toBe("snapshot.png");
        expect(shot.buffer[0]).toBe(0x89);
        expect(shot.buffer.toString("ascii", 1, 4)).toBe("PNG");
      } finally {
        await driver.close();
        driver = undefined;
        await server.close();
      }
    },
    30_000,
  );
});
