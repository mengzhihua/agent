# 期 5：编辑器能驱动的 ACP

同一套 `AgentHost`，stdio 上的 JSON-RPC 补上编辑器真正要用的两件事：切模式、工具权限往返。帧格式自动识别 NDJSON 或 LSP `Content-Length`。仍不是 Zed 注册表 / fs / terminal 的完整实现。

## 范围

已做：

1. `initialize`：`protocolVersion: 1`，`loadSession`、MCP HTTP 能力、空 `authMethods`
2. `authenticate` 空实现
3. `session/new` / `session/load` 返回 `modes`（`execute` / `plan`）
4. `session/set_mode` → `host.setRunMode`，并通知 `current_mode_update`
5. ask 模式下 agent 发 `session/request_permission`，等客户端选 `allow-once` / `reject-once`
6. `session/update` 带上 `plan` 条目
7. `agent acp` 默认走 ask（`AGENT_APPROVAL=auto` 仍可全放行）

不做（以后）：Docker workspace、云端 VM、ACP `terminal/*`、Playwright 包。客户端文件系统见 [期 6](phase-6.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
