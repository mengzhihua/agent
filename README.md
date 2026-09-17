# agent

通用 agent 软件：一个极简的模型–工具循环，外面套 harness。

当前进度：**期 2 — 浏览器 / artifacts / HITL**。

- [行业研究](docs/industry-agent-research.md) — Codex、Claude Code、Grok Build、Devin、Cursor、Gemini CLI、Manus、OpenHands 等怎么做，以及通用 harness 的收敛形态
- [期 0](docs/phase-0.md)
- [期 1](docs/phase-1.md)
- [期 2](docs/phase-2.md)

## 研究结论（极简）

通用 agent 不是“更强的聊天”，而是：

**一个极简的模型–工具循环，外面套很重的 harness**（上下文、权限、沙箱、会话、MCP、Skills、多表面协议）。

一线产品共用同一套循环；差异主要在 workspace（本机 / 容器 / 云 VM）和产品表面（CLI、IDE、异步云端、通用电脑）。

落地顺序：先做出可取消、可 resume 的 tool loop，再加 Skills/MCP/权限，再考虑浏览器与云端 VM。不要从多角色 agent 框架或自研工作流图起步。

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
npm run agent -- --plan          # 只读研究 + update_plan
npm run agent -- --list
npm run agent -- --resume <id> -p "continue"
npm run agent -- acp             # NDJSON JSON-RPC（给编辑器/其他客户端）
npm run agent                    # 交互（/plan /execute /skills；ask_user 走终端）
```

无 TTY 且未加 `-y` 时，写操作和 shell 会被拒绝。工作区不必是 git 仓库；交付物默认写到 `artifacts/`。

## 工具

内置（顺序固定）：`read` `grep` `glob` `apply_patch` `shell` `web_search` `web_fetch` `browser` `artifact` `ask_user` `skill` `update_plan` `task`

MCP 工具以 `mcp__<server>__<tool>` 接在后面。

## 项目扩展

| 文件 | 作用 |
| --- | --- |
| `AGENTS.md` | 项目说明，注入 system prompt |
| `.agent/skills/*/SKILL.md` | 按需加载的技能 |
| `.agent/mcp.json` | MCP 服务器 |
| `.agent/hooks.json` | PreToolUse / PostToolUse / Stop |

会话存在 `$AGENT_HOME/sessions`（默认 `~/.agent/sessions`）。
交付物存在 `$AGENT_ARTIFACTS` 或 `<workspace>/artifacts`。
