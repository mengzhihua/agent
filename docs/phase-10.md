# 期 10：ACP 会话回放、resume、close

编辑器要能把旧对话装回去。`session/load` 必须把 transcript 以 `session/update` 回放给客户端；`session/resume` 只恢复上下文、不回放；`session/close` 取消进行中的工作并释放该会话的 runtime / MCP。同一套 JSONL 会话，CLI `--resume` 行为不变。

## 范围

已做：

1. `initialize` 声明 `loadSession`、`sessionCapabilities.resume`、`sessionCapabilities.close`（以及期 9 的 `additionalDirectories`）
2. `session/load` 恢复 cwd / 额外根 / MCP，按序回放 `user` / `assistant` / `tool_call` / `tool_result` / `plan` / `artifact`，结果为 `null`
3. `session/resume` 走同一套恢复，不发历史 `session/update`，返回 `modes`
4. `session/close` 等价于对该会话 `session/cancel`，再关掉 browser 与会话 MCP，从活动会话表里拿掉
5. 关掉之后 transcript 仍在，可以再 `session/load` 或 `session/resume`

不做（以后）：SSE 传输、Docker workspace、云端 VM、Playwright 包。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
