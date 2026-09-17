# 期 1：像产品而不是脚本

在期 0 的单一 loop 上加扩展面。引擎仍然只有一个；CLI 和 ACP stdio 都走 `AgentHost`。

## 范围

已做：

1. `AGENTS.md` / `AGENTS.override.md` 与用户级 `~/.agent/AGENTS.md`
2. Agent Skills（`SKILL.md` 渐进披露；`skill` 工具；用户写 `$name` / `/name` 时预加载）
3. MCP client（stdio Content-Length，可选 HTTP JSON-RPC；工具名 `mcp__server__tool`，按名字排序接在内置工具后面）
4. Plan mode（`--plan` / `/plan`；工具列表不变，写/shell/MCP/task 直接拒绝；`update_plan`）
5. 子 agent（`task`，explore 只读；隔离 session，只把摘要交回父会话；禁止嵌套）
6. Hooks：`PreToolUse` / `PostToolUse` / `Stop`（`.agent/hooks.json`）
7. 预留客户端协议：`agent acp`，NDJSON JSON-RPC（`initialize` / `session/new` / `session/prompt` / `session/cancel`）
8. Prompt cache 纪律：内置工具顺序固定；MCP 额外工具按名字排序；plan mode 不删工具

不做（期 2）：浏览器 / computer use、持久云电脑、完整 Zed ACP 注册表兼容、OS 沙箱。

## 项目文件

```text
AGENTS.md
.agent/skills/<name>/SKILL.md
.agent/mcp.json
.agent/hooks.json
```

Skills 也从 `.agents/skills/` 和 `~/.agent/skills/` 加载。

## 怎么跑

```bash
npm test
npm run agent -- --plan -y -p "先给出修复计划"
npm run agent -- acp
```
