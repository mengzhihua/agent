# agent

通用 agent 软件的研究与实现。

当前仓库先放行业研究，作为后续架构选型的基线。

## 文档

- [通用 Agent 行业研究](docs/industry-agent-research.md) — Codex、Claude Code、Grok Build、Devin、Cursor、Gemini CLI、Manus、OpenHands 等怎么做，以及通用 harness 的收敛形态。

## 研究结论（极简）

通用 agent 不是“更强的聊天”，而是：

**一个极简的模型–工具循环，外面套很重的 harness**（上下文、权限、沙箱、会话、MCP、Skills、多表面协议）。

一线产品共用同一套循环；差异主要在 workspace（本机 / 容器 / 云 VM）和产品表面（CLI、IDE、异步云端、通用电脑）。

落地顺序建议：先做出可取消、可 resume 的 tool loop，再加 Skills/MCP/权限，再考虑浏览器与云端 VM。不要从多角色 agent 框架或自研工作流图起步。
