# 期 0：能跑完任务的 loop

对应研究文档里的第一步。这一期只做一件事：一个可取消、可 resume 的模型–工具循环，能在真实工作区里读、搜、改、跑命令。

## 范围

已做：

1. Thread / Session（JSONL transcript，`--resume` / `--list`）
2. Agent loop（流式事件、SIGINT 取消、工具轮次上限）
3. 工具：`read` / `grep` / `glob` / `apply_patch` / `shell` / `web_search`
4. 权限：只读自动；写、shell、联网默认确认（`-y` / `AGENT_APPROVAL=auto` 放行）
5. 超窗 compact（总结旧历史，保留最新用户消息）
6. Provider 适配：OpenAI 兼容 Chat Completions（含 xAI）、Anthropic Messages、测试用 scripted

不做（期 1）：Skills、MCP、plan mode、子 agent、ACP、hooks。

## 怎么跑

```bash
npm install
npm test
npm run agent -- -y -p "Fix the failing test in this workspace"
```

需要 `OPENAI_API_KEY`（或 `XAI_API_KEY` / `ANTHROPIC_API_KEY`）。无 key 时仍可用 `npm test`，测试走 scripted provider，会在夹具仓库里把 `add()` 从减法改成加法并跑测试。

## 模块

```
src/loop/          循环、组装上下文、compact
src/session/       JSONL
src/tools/         六个内置工具
src/permissions/   deny-first 的 ask/auto
src/provider/      openai / anthropic / scripted
src/cli.ts         唯一用户表面（可换，引擎只有这一套）
```

工作区路径全部经过 `resolveInWorkspace`。shell 没有 OS 级沙箱，只限制 cwd、超时和输出大小——这是期 0 的明确取舍。
