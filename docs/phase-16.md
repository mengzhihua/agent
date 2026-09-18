# 期 16：ACP elicitation

编辑器要能问用户结构化问题，而不是把 `ask_user` 伪装成权限弹窗。客户端在 `initialize` 里声明 `clientCapabilities.elicitation.form` 后，agent 发 `elicitation/create`（form + 受限 JSON Schema）。没有这项能力时，仍退回 `session/request_permission`。

## 范围

已做：

1. 解析 `clientCapabilities.elicitation.form` / `url`（空对象才算支持该 mode）
2. `ask_user`（以及 browser takeover）走 `elicitation/create`：自由文本或 `choices` 枚举
3. 接受 `accept` / `decline` / `cancel`；拒绝或取消记成工具错误
4. 带上 `sessionId` 和 `toolCallId`
5. 未声明 form 时保持原来的权限选项兜底

不做：URL mode（OAuth / 密钥）、把 MCP 服务器的 elicitation 转发给编辑器、SSE、Docker workspace、云端 VM、Playwright、累计 cost、布尔 config、图片 prompt。跨平台安装见 [期 17](phase-17.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
