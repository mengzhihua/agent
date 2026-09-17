# 期 8：ACP 会话 MCP

编辑器在 `session/new` / `session/load` 里可以带上 `mcpServers`。Agent 按 ACP 形状接 stdio 和 HTTP 服务器，工具以 `mcp__<name>__<tool>` 接到同一套 loop。工作区 `.agent/mcp.json` 仍然生效；同名时会话带来的服务器覆盖。SSE 未声明能力，直接跳过。

## 范围

已做：

1. 解析 ACP `mcpServers`：stdio（`command`/`args`/`env[]`）和 HTTP（`url`/`headers[]`）
2. `session/new`、`session/load` 连接这些服务器，工具挂在该会话上
3. HTTP MCP 带上客户端给的 headers
4. 单个服务器失败不阻断会话创建
5. CLI / `.agent/mcp.json` 行为不变

不做（以后）：SSE 传输、`additionalDirectories`、Docker workspace、云端 VM、Playwright 包。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
