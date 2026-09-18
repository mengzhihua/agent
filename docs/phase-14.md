# 期 14：ACP 上下文用量

编辑器要能显示当前上下文用了多少。`session/new` / `load` / `resume` 以及每轮 prompt 之后发 `usage_update`（`used` / `size`）。`used` 按 transcript 估算；`size` 按模型窗口（claude 200k、grok 256k、gpt-4.1 1M，其它至少 128k）。不报 cost，因为没有计价。

## 范围

已做：

1. `usage_update`：`used` 来自 `assembleMessages` 的 token 估算，`size` 来自模型窗口
2. `session/new`、`load`、`resume` 后立刻发一次（新会话 `used` 为 0）
3. 每轮 `session/prompt`（含只执行 slash 命令）结束后再发
4. 改 `model` 时窗口可能变，再发一次
5. 提供商中途的 usage 事件不转成 ACP（避免没有 `size` 的半截通知）

不做（以后）：SSE 传输、Docker workspace、云端 VM、Playwright 包、累计 cost、布尔 config。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
