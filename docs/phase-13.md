# 期 13：ACP Session Config Options

编辑器要用选择器改会话配置，而不是只靠旧的 `modes`。`session/new` / `resume` 返回 `configOptions`（mode / model / approval）；`session/load` 因结果是 `null`，改发 `config_option_update`。`session/set_config_option` 改值并返回完整配置。旧的 `session/set_mode` 和 slash `/plan` `/execute` `/yes` `/ask` 仍可用，并保持两边同步。

## 范围

已做：

1. `configOptions`：`mode`（execute/plan）、`model`（当前模型 + gpt-4.1 / grok-4 / claude-sonnet-4-5）、`approval`（ask/auto）
2. `session/set_config_option`；非法 id/value 报错
3. 改 mode 时同时发 `current_mode_update`（给只认旧 API 的客户端）
4. `session/set_mode`、slash 命令也会发 `config_option_update`
5. 布尔 config 未做：审批用 select，不依赖客户端 `session.configOptions.boolean`

不做（以后）：SSE 传输、Docker workspace、云端 VM、Playwright 包、usage_update。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
