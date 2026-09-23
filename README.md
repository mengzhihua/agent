# agent

通用 agent：一个极简的模型–工具循环，外面套 harness（上下文、权限、沙箱、会话、MCP、Skills）。同一套循环给 CLI、ACP、HTTP 和网页控制台用。

**当前版本 [v0.35.0](https://github.com/mengzhihua/agent/releases/tag/v0.35.0)** · [变更记录](CHANGELOG.md) · [最新 Release](https://github.com/mengzhihua/agent/releases/latest)

工作区不必是 git 仓库。交付物默认写到 `artifacts/`。

## 安装

安装脚本默认拉 GitHub Release 里的原生包（Windows `.exe`，macOS / Linux `.tar.gz`），不需要本机 Node.js、npm 或 TypeScript。失败时才退回 `agent.tgz`（需要 Node 22）。

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.ps1 | iex
```

也可以直接从 [Releases](https://github.com/mengzhihua/agent/releases) 下载：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `agent-win-x64.exe`（另有 `.zip`） |
| Windows arm64 | `agent-win-arm64.exe`（另有 `.zip`） |
| macOS Apple Silicon | `agent-darwin-arm64.tar.gz`（macOS 14 ARM 上 codesign） |
| macOS Intel | `agent-darwin-x64.tar.gz` |
| Linux x64 | `agent-linux-x64.tar.gz` |
| Linux arm64 | `agent-linux-arm64.tar.gz` |
| 任意平台（需 Node 22） | `agent.tgz` |
| 服务器（Java 17+） | `agent-server.jar` |

```bash
tar -xzf agent-linux-x64.tar.gz
./agent -V

tar -xzf agent-darwin-arm64.tar.gz
./agent -V

./agent serve --port 8080          # 浏览器打开 http://127.0.0.1:8080
java -jar agent-server.jar         # 同一套 /v1 API + 页面
```

装好后执行 `agent doctor`。新开一个终端即可直接运行 `agent`。之后用 `agent update` / `agent uninstall`。

指定版本：`AGENT_REF=v0.35.0`。要从源码装 main：`AGENT_REF=main`（此时需要 Node 22）。

合入 `main` 且 CI（Linux / macOS / Windows）全绿后，GitHub Actions 会打 `v*` Release（原生包 + tarball + `agent-server.jar`）。说明文字取自 [CHANGELOG.md](CHANGELOG.md) 里对应版本。

macOS 若 Gatekeeper 拦截未公证二进制：`xattr -cr agent`。

## 配置和密钥

优先级：命令行 > 环境变量 > `~/.agent/config.json` > 内置默认。

```json
{
  "model": "gpt-4.1",
  "approvalMode": "edits",
  "sandbox": "auto",
  "browser": "auto"
}
```

`approvalMode` 可以是 `ask`（每项都问）、`edits`（改文件自动放行，shell 和网络仍问）、`auto`（写、shell、联网都放行）。对应环境变量 `AGENT_APPROVAL=ask|edits|auto`（也接受 `acceptEdits` / `accept-edits`）。

密钥（任选）：环境变量 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`XAI_API_KEY`、`ANTHROPIC_API_KEY`，或 `agent login` 写入 `~/.agent/credentials.json`（环境变量优先）。

补全：

```bash
agent completion bash >> ~/.bashrc
agent completion zsh  >> ~/.zshrc
agent completion powershell
```

## 运行

单次：

```text
agent -p "prompt"
agent -p --output-format json "prompt"
agent -q -p --output-format stream-json "prompt"
agent --plan
agent eval test/evals
agent eval test/evals --output-format json
agent --browser chrome -y -p "Open a page and screenshot"
agent -p --file src/cli.ts "what does this do"
agent -p "fix @src/cli.ts:10-40"
```

审批：

```text
agent -y -p "prompt"              # 写 / shell / 联网自动放行
agent --accept-edits -p "prompt"  # 改文件自动放行，shell / 网络仍问
```

会话：

```text
agent -c                          # 接着这个工作区最近一次会话
agent --list
agent --resume <id> -p "continue"
agent session list|show|export|fork|rewind|compact|cost|delete <id>
agent memory show
agent permissions
agent permissions clear
```

其他：

```text
agent serve --port 8080           # 浏览器打开 / ；SSE：Accept text/event-stream
agent acp                         # JSON-RPC（NDJSON 或 Content-Length）
agent doctor
agent config
agent init
agent login
agent logout
agent update
agent uninstall
agent completion bash
```

交互模式直接运行 `agent`。命令：`/quit` `/yes` `/edits` `/ask` `/plan` `/execute` `/skills` `/session` `/fork` `/rewind` `/compact` `/memory` `/permissions` `/cost`。`ask_user` 在终端里问；ACP 走 elicitation。

仓库内开发：`npm run agent -- -y -p "..."`（走编译后的 `dist/cli.js`）。

## 行为

无 TTY 且未加 `-y` / `--accept-edits` 时，写操作和 shell 会被拒绝。有 TTY 时提示可回 `y`（一次）、`session`（本会话，shell 按命令前缀匹配）、`always`（写入 `~/.agent/permissions.json`）。`agent permissions` 列出这些规则，`agent permissions clear` 清空。

计划模式只保留只读工具和 `update_plan`，不会放开写和 shell。

Linux 上安装 `bubblewrap` 后，shell 默认无网络、只能写 workspace（`AGENT_SANDBOX=none` 可关）。macOS / Windows 默认不套 bwrap。

找到本机 Chrome 或 Edge 时，`browser` 走 CDP（`AGENT_BROWSER=html` 可退回静态 fetch）。

工具结果写入 transcript 时默认封顶 40KB（`AGENT_TOOL_OUTPUT_LIMIT` / `toolOutputLimit`）。会话用量：`agent session cost`、`/cost`、ACP `usage_update.billed`。

## 工具

内置（顺序固定）：`read` `grep` `glob` `apply_patch` `shell` `web_search` `web_fetch` `browser` `artifact` `ask_user` `memory` `skill` `update_plan` `task`

MCP 工具以 `mcp__<server>__<tool>` 接在后面。

## 项目文件

| 文件 | 作用 |
| --- | --- |
| `AGENTS.md` | 项目说明，注入 system prompt（也会读父目录和 `~/.agent/AGENTS.md`） |
| `.agentignore` | grep/glob 额外忽略（gitignore 语法；`.gitignore` 同样生效） |
| `.agent/skills/*/SKILL.md` | 按需加载的技能 |
| `.agent/mcp.json` | MCP 服务器 |
| `.agent/hooks.json` | PreToolUse / PostToolUse / Stop |
| `.agent/MEMORY.md` | 项目记忆，注入 system prompt；用户记忆在 `~/.agent/MEMORY.md` |

路径（可用 `AGENT_HOME` 改根目录，默认 `~/.agent`）：

| 路径 | 内容 |
| --- | --- |
| `$AGENT_HOME/sessions` | 会话 JSONL |
| `$AGENT_HOME/config.json` | 默认配置 |
| `$AGENT_HOME/permissions.json` | `always` 记住的允许 |
| `$AGENT_HOME/credentials.json` | `agent login` 写入的 key（权限 0600） |
| `$AGENT_ARTIFACTS` 或 `<workspace>/artifacts` | 交付物 |

## 从源码开发

```bash
npm install
npm test
npm run setup
npm run agent -- -y -p "..."
```

Docker 镜像复制的是已经编译好的 `dist/`，先构建再打包：

```bash
npm run build && docker build -t agent .
docker run --rm -p 8080:8080 -e OPENAI_API_KEY agent
```

## 开发记录

一线产品共用同一套循环；差异主要在 workspace（本机 / 容器 / 云 VM）和产品表面（CLI、IDE、异步云端、通用电脑）。落地顺序是先做出可取消、可 resume 的 tool loop，再加 Skills / MCP / 权限，再考虑浏览器与云端 VM。详见 [行业研究](docs/industry-agent-research.md)。

- [期 0](docs/phase-0.md) · [期 1](docs/phase-1.md) · [期 2](docs/phase-2.md) · [期 3](docs/phase-3.md) · [期 4](docs/phase-4.md)
- [期 5](docs/phase-5.md) · [期 6](docs/phase-6.md) · [期 7](docs/phase-7.md) · [期 8](docs/phase-8.md) · [期 9](docs/phase-9.md)
- [期 10](docs/phase-10.md) · [期 11](docs/phase-11.md) · [期 12](docs/phase-12.md) · [期 13](docs/phase-13.md) · [期 14](docs/phase-14.md)
- [期 15](docs/phase-15.md) · [期 16](docs/phase-16.md) · [期 17](docs/phase-17.md) · [期 18](docs/phase-18.md) · [期 19](docs/phase-19.md)
- [期 20](docs/phase-20.md) · [期 21](docs/phase-21.md) · [期 22](docs/phase-22.md) · [期 23](docs/phase-23.md) · [期 24](docs/phase-24.md)
- [期 25](docs/phase-25.md) · [期 26](docs/phase-26.md) · [期 27](docs/phase-27.md) · [期 28](docs/phase-28.md) · [期 29](docs/phase-29.md)
- [期 30](docs/phase-30.md) · [期 31](docs/phase-31.md) · [期 32](docs/phase-32.md) · [期 33](docs/phase-33.md) · [期 34](docs/phase-34.md)
