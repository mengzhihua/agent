# agent

通用 agent 软件：一个极简的模型–工具循环，外面套 harness。

当前进度：**期 29 — 会话 fork**。

- [行业研究](docs/industry-agent-research.md) — Codex、Claude Code、Grok Build、Devin、Cursor、Gemini CLI、Manus、OpenHands 等怎么做，以及通用 harness 的收敛形态
- [期 0](docs/phase-0.md)
- [期 1](docs/phase-1.md)
- [期 2](docs/phase-2.md)
- [期 3](docs/phase-3.md)
- [期 4](docs/phase-4.md)
- [期 5](docs/phase-5.md)
- [期 6](docs/phase-6.md)
- [期 7](docs/phase-7.md)
- [期 8](docs/phase-8.md)
- [期 9](docs/phase-9.md)
- [期 10](docs/phase-10.md)
- [期 11](docs/phase-11.md)
- [期 12](docs/phase-12.md)
- [期 13](docs/phase-13.md)
- [期 14](docs/phase-14.md)
- [期 15](docs/phase-15.md)
- [期 16](docs/phase-16.md)
- [期 17](docs/phase-17.md)
- [期 18](docs/phase-18.md)
- [期 19](docs/phase-19.md)
- [期 20](docs/phase-20.md)
- [期 21](docs/phase-21.md)
- [期 22](docs/phase-22.md)
- [期 23](docs/phase-23.md)
- [期 24](docs/phase-24.md)
- [期 25](docs/phase-25.md)
- [期 26](docs/phase-26.md)
- [期 27](docs/phase-27.md)
- [期 28](docs/phase-28.md)
- [期 29](docs/phase-29.md)

## 研究结论（极简）

通用 agent 不是“更强的聊天”，而是：

**一个极简的模型–工具循环，外面套很重的 harness**（上下文、权限、沙箱、会话、MCP、Skills、多表面协议）。

一线产品共用同一套循环；差异主要在 workspace（本机 / 容器 / 云 VM）和产品表面（CLI、IDE、异步云端、通用电脑）。

落地顺序：先做出可取消、可 resume 的 tool loop，再加 Skills/MCP/权限，再考虑浏览器与云端 VM。不要从多角色 agent 框架或自研工作流图起步。

## 安装（macOS / Linux / Windows）

安装脚本默认拉 **GitHub Release 里的原生包**（Windows `.exe`，macOS / Linux `.tar.gz`），**不需要本机 Node.js、npm 或 TypeScript**。失败时才退回 `agent.tgz`（需要 Node 22）。

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.ps1 | iex
```

也可以直接从 https://github.com/mengzhihua/agent/releases 下载对应文件：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `agent-win-x64.exe` |
| macOS Apple Silicon | `agent-darwin-arm64.tar.gz` |
| macOS Intel | `agent-darwin-x64.tar.gz` |
| Linux x64 | `agent-linux-x64.tar.gz` |
| Linux arm64 | `agent-linux-arm64.tar.gz` |
| 服务器（Java 17+） | `agent-server.jar` |

```bash
# Linux / macOS 解开即可跑
tar -xzf agent-linux-x64.tar.gz
./agent -V

# 服务端
./agent serve --port 8080          # 浏览器打开 http://127.0.0.1:8080
java -jar agent-server.jar         # 同一套 /v1 API + 页面
docker build -t agent . && docker run --rm -p 8080:8080 -e OPENAI_API_KEY agent
```

装好后执行 `agent doctor`。新开一个终端即可直接运行 `agent`。之后可用 `agent update` / `agent uninstall`。

指定版本：`AGENT_REF=v0.30.0`。要从源码装 main：`AGENT_REF=main`（此时需要 Node 22）。

合入 `main` 且 CI（Linux / macOS / Windows）全绿后，GitHub Actions 会打 `v*` Release（原生包 + tarball + `agent-server.jar`）。

macOS 若 Gatekeeper 拦截未公证二进制：`xattr -cr agent`。


默认配置写在 `~/.agent/config.json`（命令行和环境变量优先）。补全：

```bash
agent completion bash >> ~/.bashrc
agent completion zsh  >> ~/.zshrc
```

开发者从仓库安装：

```bash
npm install
npm test
npm run setup
```

密钥（任选）：环境变量 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`XAI_API_KEY`、`ANTHROPIC_API_KEY`，或 `agent login` 写入 `~/.agent/credentials.json`（环境变量优先）。

## 运行

```text
agent -p "prompt"     # 单次
agent -p --output-format json "prompt"
agent -q -p --output-format stream-json "prompt"
agent -y -p "prompt"  # 写/shell/联网自动放行
agent --plan          # 只读研究 + update_plan
agent eval test/evals # 确定性回归（不调模型）
agent eval test/evals --output-format json
agent --browser chrome -y -p "Open a page and screenshot"
agent -p --file src/cli.ts "what does this do"
agent -p "fix @src/cli.ts:10-40"
agent --list
agent session list
agent session show <id>
agent session export <id>
agent session fork <id>
agent session delete <id>
agent memory show
agent serve --port 8080  # 浏览器打开 / ；SSE：Accept text/event-stream
agent --resume <id> -p "continue"
agent acp             # JSON-RPC（NDJSON 或 Content-Length；ask 时向客户端要权限；fs/terminal/MCP 走编辑器）
agent doctor          # 检查 node / sandbox / 浏览器 / PATH / 配置 / git / auth
agent config          # 打印生效配置
agent init            # 生成 AGENTS.md、.agentignore、.agent/
agent login           # 保存 API key 到 ~/.agent/credentials.json
agent logout          # 删除保存的 key
agent update          # 重跑一键安装
agent uninstall       # 移除 shim 和 PATH
agent completion bash # 输出 bash 补全
agent                 # 交互（/plan /execute /skills /memory /fork；ask_user 走终端，ACP 走 elicitation）
```

仓库内开发也可以：`npm run agent -- -y -p "..."`（走编译后的 `dist/cli.js`）。

无 TTY 且未加 `-y` 时，写操作和 shell 会被拒绝。工作区不必是 git 仓库；交付物默认写到 `artifacts/`。Linux 上安装 `bubblewrap` 后，shell 默认无网络、只能写 workspace（`AGENT_SANDBOX=none` 可关）；macOS / Windows 默认不套 bwrap。找到本机 Chrome 或 Edge 时，`browser` 走 CDP（`AGENT_BROWSER=html` 可退回静态 fetch）。

## 工具

内置（顺序固定）：`read` `grep` `glob` `apply_patch` `shell` `web_search` `web_fetch` `browser` `artifact` `ask_user` `memory` `skill` `update_plan` `task`

MCP 工具以 `mcp__<server>__<tool>` 接在后面。

## 项目扩展

| 文件 | 作用 |
| --- | --- |
| `AGENTS.md` | 项目说明，注入 system prompt（也会读父目录和 `~/.agent/AGENTS.md`） |
| `.agentignore` | grep/glob 额外忽略（gitignore 语法；`.gitignore` 同样生效） |
| `.agent/skills/*/SKILL.md` | 按需加载的技能 |
| `.agent/mcp.json` | MCP 服务器 |
| `.agent/hooks.json` | PreToolUse / PostToolUse / Stop |
| `.agent/MEMORY.md` | 项目记忆，注入 system prompt；用户记忆在 `~/.agent/MEMORY.md` |

会话存在 `$AGENT_HOME/sessions`（默认 `~/.agent/sessions`）。
默认配置 `$AGENT_HOME/config.json`。
API key `$AGENT_HOME/credentials.json`（`agent login`，权限 0600）。
交付物存在 `$AGENT_ARTIFACTS` 或 `<workspace>/artifacts`。
