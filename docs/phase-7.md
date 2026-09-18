# 期 7：ACP 客户端终端

编辑器声明 `clientCapabilities.terminal` 之后，`shell` 不再在 agent 进程里 spawn，而是走 `terminal/create` → `wait_for_exit` / `output` → `release`。超时先 `kill` 再取输出。工具更新里嵌入 `terminalId`，客户端可以直播输出。没有该能力时仍用本机 spawn + bubblewrap。

## 范围

已做：

1. `initialize` 记下 `clientCapabilities.terminal`（缺省或 false 则禁止任何 `terminal/*`）
2. `shell` 用客户端 `/bin/sh -c <command>`，`cwd` 为工作区绝对路径
3. 超时或取消：`terminal/kill`，再 `terminal/output`，最后 `terminal/release`
4. `session/update` `tool_call_update` 带 `{ type: "terminal", terminalId }`
5. CLI / 无 terminal 能力：原 spawn + 沙箱不变

不做（以后）：session 级 MCP 列表、`additionalDirectories`、Docker workspace、云端 VM、Playwright 包。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
