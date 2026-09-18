# 期 12：ACP Slash Commands

编辑器要能展示并调用和 CLI 一样的斜杠命令。`session/new` / `load` / `resume` 之后发 `available_commands_update`。`session/prompt` 里以 `/plan`、`/execute`、`/skills`、`/yes`、`/ask` 开头的输入先由 harness 处理，有剩余文本再进同一套 loop。

## 范围

已做：

1. 广告 `plan` / `execute` / `skills` / `yes` / `ask`
2. `/plan`、`/execute` 切模式并发 `current_mode_update`；后面跟任务则继续 prompt
3. `/skills` 直接列出技能，不调模型
4. `/yes`、`/ask` 改 `approvalMode`；auto 时不再向客户端要权限
5. 未登记的 `/foo` 当普通用户消息

不做（以后）：SSE 传输、Docker workspace、云端 VM、Playwright 包。Session config options / usage_update 以后再做。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
