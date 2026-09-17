# agent

通用 agent 软件：一个极简的模型–工具循环，外面套 harness。

当前进度：**期 1 — Skills / MCP / plan / 子 agent / hooks / ACP stdio**。

- [行业研究](docs/industry-agent-research.md)
- [期 0](docs/phase-0.md)
- [期 1](docs/phase-1.md)

## 运行

```bash
npm install
npm test
npm run agent -- -y -p "What files are in this workspace?"
npm run agent -- --plan -p "先给出实现计划"
```

密钥（任选）：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`XAI_API_KEY`、`ANTHROPIC_API_KEY`。

```text
npm run agent -- -p "prompt"     # 单次
npm run agent -- -y -p "prompt"  # 写/shell/联网自动放行
npm run agent -- --plan          # 只读 + update_plan
npm run agent -- --list
npm run agent -- --resume <id> -p "continue"
npm run agent -- acp             # NDJSON JSON-RPC（给编辑器/其他客户端）
npm run agent                    # 交互（/plan /execute /skills）
```

无 TTY 且未加 `-y` 时，写操作和 shell 会被拒绝。

## 工具

内置（顺序固定）：`read` `grep` `glob` `apply_patch` `shell` `web_search` `skill` `update_plan` `task`

MCP 工具以 `mcp__<server>__<tool>` 接在后面。

## 项目扩展

| 文件 | 作用 |
| --- | --- |
| `AGENTS.md` | 项目说明，注入 system prompt |
| `.agent/skills/*/SKILL.md` | 按需加载的技能 |
| `.agent/mcp.json` | MCP 服务器 |
| `.agent/hooks.json` | PreToolUse / PostToolUse / Stop |

会话存在 `$AGENT_HOME/sessions`（默认 `~/.agent/sessions`）。
