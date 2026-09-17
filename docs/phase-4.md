# 期 4：真浏览器（Chrome CDP）

期 2 的 `HtmlDriver` 只能 fetch + 抽标签，点按钮不会跑页面脚本。这一期按同一 `BrowserDriver` 接口接上本机 Chrome：JavaScript、无障碍快照、PNG 截图。没有 Chrome 时自动退回 HTML 驱动。仍然没有 Playwright 依赖。

## 范围

已做：

1. `ChromeDriver`：系统 Chrome/Chromium + CDP（`AGENT_CHROME` 或 PATH 上的 `google-chrome`）
2. `AGENT_BROWSER=auto|chrome|html`，CLI `--browser`
3. 无障碍树映射成 `e1` / `e2`…，`click` / `type` 走 DOM
4. `browser screenshot` 在 Chrome 下存 PNG，HTML 驱动仍存 HTML
5. 默认 `auto`：找到 Chrome 就用，否则 HtmlDriver

不做（以后）：Playwright 包、Docker workspace、云端 VM。编辑器协议见 [期 5](phase-5.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- --browser chrome -y -p "Open https://example.com, snapshot, and screenshot"
npm run agent -- --browser html -p "..."
```
