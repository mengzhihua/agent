# 技术方案

本文描述 **v0.35.0** 已经落地的实现。行业上为什么这样切，见 [行业研究](industry-agent-research.md)。每一期做了什么，见 [期 0](phase-0.md)–[期 34](phase-34.md)。用法见仓库根目录 [README](../README.md)。

研究文档里画过 `agent-core/`、`agent-tools/` 这种多包草图。当前仓库没有拆成那些包，运行时是一个 TypeScript 包，所有表面共用 `AgentHost`。

## 1. 目标

做一个通用 agent：模型负责下一步，harness 负责上下文、权限、沙箱、会话和表面。

约束：

- 只有一个工具循环。CLI、ACP、HTTP、网页控制台都调用它，不给 IDE 再写一套 loop。
- 工作区不必是 git 仓库。交付物进 `artifacts/`。
- SaaS 走 MCP，工作流走 Skills，计划模式不另起引擎。
- Node.js 22、ESM、TypeScript。运行时不依赖第三方 npm 包。测试用 vitest，开发用 tsx。

## 2. 总体结构

```text
CLI / ACP / HTTP / 网页控制台 / Spring Boot（拉起同一个二进制）
                         │
                    AgentHost
        ┌────────────────┼────────────────┐
   SessionStore      ToolRegistry     Provider
   JSONL 事件        内置 + MCP        OpenAI 兼容 / Anthropic / scripted
                         │
                    runTurn
              组装上下文 → 调模型 → 权限 → hook → 执行工具
```

`AgentHost.create` 时加载 Skills、hooks、MCP，建好工具表，再把 host 自己交给 `task` 子 agent。一次用户任务是 `host.prompt(sessionId, text, signal)`，内部就是 `runTurn`。

配置在进 host 之前由 `loadConfig` 合成。优先级：命令行 > 环境变量 > `~/.agent/config.json` > 内置默认。

## 3. 一次 turn

`src/loop/agent-loop.ts` 的 `runTurn`：

1. 把 `@path`、`--file`、编辑器附带的文件注进用户文本，显式点名的 skill 也在这一步展开。原文追加为 `user` 事件。
2. 循环直到模型不再要工具，或达到 `maxToolIterations`（默认 40）。每轮开始先看要不要 compact。
3. `assembleMessages` 把 JSONL 收成模型消息。`buildSystemPrompt` 另做 system，不写进 transcript。
4. Provider 流式返回 `text-delta`、`tool-call`、`usage`。用量当场写入 JSONL。
5. 没有 tool call：写入 `assistant`，跑 Stop hook，发出 `turn-end`。
6. 有 tool call：先全部记成 `tool_call` 事件。连续的只读工具一批 `Promise.all`，写、shell、网络、`ask_user`、`update_plan`、`task` 各自单独执行。
7. 每个调用的顺序是：权限 → `PreToolUse` → 执行 → 记录新 artifact → `PostToolUse` → 把结果截断后写成 `tool_result`。
8. `AbortSignal`（Ctrl+C、HTTP 断开、ACP `session/cancel`）在轮次边界抛出，循环发出 `aborted`。

工具结果写入 transcript 时按 `toolOutputLimit` 截断，默认 40_000 字符（`AGENT_TOOL_OUTPUT_LIMIT`）。shell 自己还有 32_768 的输出上限和 60 秒超时。

## 4. 会话

一个会话是 `$AGENT_HOME/sessions/<id>.jsonl`（默认 `~/.agent/sessions`）。普通写入只追加。写入前用 `redactSecrets` 去掉密钥。`rewind` 和 `fork` 会整文件替换，先写 `.tmp` 再改名。`compact` 不删旧行，只追加事件。

事件类型：`session_meta`、`user`、`assistant`、`tool_call`、`tool_result`、`usage`、`compact`、`plan`、`artifact`。

组装规则（`assembleMessages`）：

- 用最后一条 `compact` 当界。摘要变成一条 `<compact_summary>` 用户消息，界线之前的事件不再送给模型。
- `assistant` 后面紧跟的 `tool_call` 合成一条带 `toolCalls` 的助手消息，对应的 `tool_result` 变成 `role: "tool"`。
- `plan`、`artifact`、`usage`、`session_meta` 不进模型上下文。用量留在文件里，给 `session cost` 和 ACP `usage_update` 用。

会话操作都在 `SessionStore` / `AgentHost` 上，三个表面调用同一组方法：

| 操作 | 行为 |
| --- | --- |
| 创建 | 写 `session_meta`（cwd、model、provider） |
| continue（`-c`） | 取当前工作区最新一条 |
| resume | 打开已有 id，可顺带换 workspace |
| fork | 复制事件到新 id，`session_meta.forkedFrom` 指向源；可选截到某个 event id |
| rewind | 默认删掉最后一个 `user` 及其后事件；也可截到指定 event id。不能删掉 `session_meta` |
| compact | 调当前模型写摘要，只追加 `compact` 事件，不删旧行。自动 compact 在估算 token ≥ `compactTokens`（默认 100_000）时发生。若文件末尾是 `user`，总结时先拿掉它，摘要写入后再把这条 `user` 追加回去；否则总结当前组装结果。手动 compact 总结当前组装结果。列表按最后一条事件的时间倒序 |
| delete | 关掉该会话的浏览器和 MCP，再删文件 |

fork / rewind 只动 transcript，不回滚工作区里的文件。

## 5. 模型适配

内部只有一种请求：`CompletionRequest { model, system, messages, tools }`，流式事件是 `text-delta` | `tool-call` | `usage` | `done`。

| provider | 实现 |
| --- | --- |
| `openai` | Chat Completions。有 `OPENAI_API_KEY` 时用 `OPENAI_BASE_URL` 或 `https://api.openai.com/v1`。只有 `XAI_API_KEY` 时改打 `https://api.x.ai/v1`，默认模型 `grok-4` |
| `anthropic` | Messages API。只有 Anthropic key 时自动选它，默认模型 `claude-sonnet-4-5` |
| `scripted` | 测试替身，不联网 |

默认模型在有 OpenAI key 时是 `gpt-4.1`。HTTP 用 `fetchWithRetry`。

换模型只通过配置或 ACP `session/set_config_option`，不在一轮工具调用中途换。compact 用的是当时的同一个 provider。

## 6. 工具

内置工具顺序固定，MCP 工具按名字排在后面，避免工具表抖动。

| 工具 | 风险 | 作用 |
| --- | --- | --- |
| `read` `grep` `glob` | read | 读和工作区搜索。遵守 `.gitignore` 和 `.agentignore` |
| `skill` `update_plan` `ask_user` | read | 加载技能、写计划、向用户提问 |
| `apply_patch` | write | 按 path 改文件。没有 `old_string` 就是新建 |
| `artifact` | write（`list`/`get` 为 read） | 把交付物登记进 artifacts 目录 |
| `memory` | write（`get` 为 read） | 读写用户级或项目级 `MEMORY.md` |
| `web_fetch` | network；`save: true` 时为 write | 抓公开页面，可选存成文件 |
| `web_search` | network | 搜索 |
| `browser` | `open`/`snapshot`/`screenshot`/`close` 为 network，点击输入为 exec | Chrome CDP，或退回静态 HTML |
| `shell` | exec | 在工作区跑命令 |
| `task` | exec | 子 agent。探索型会丢掉写和 shell |
| `mcp__<server>__<tool>` | exec | 外部 MCP 工具 |

路径都经过 `resolveInWorkspace`。ACP 客户端声明了文件系统能力时，读写走客户端；否则走本机磁盘。额外目录来自 ACP `additionalDirectories`，和 workspace 一起放行。

`task` 子 agent：

- 深度只有一层，子会话里 `allowTask: false`。
- 自己的 JSONL，父会话只拿最终摘要。
- `subagent_type === "explore"` 时工具表只留 `read` `grep` `glob` `skill` `update_plan` `web_search` `web_fetch` `ask_user`。
- 轮次上限是 `min(父级, 20)`。
- 父级 `approvalMode === "auto"` 时子级自动放行，否则沿用父级 approver 和同一份 `PermissionMemory`。
- 计划模式把 `task` 当成会改东西的工具，直接拒绝，不会在 plan 里偷偷开子 agent。

## 7. 权限、沙箱、计划模式

风险先按工具名，再按参数修正（见 `riskFor`）。未知工具和 MCP 一律按 exec。

`decidePermission` 的顺序：

1. 计划模式拒绝一切会改状态的调用（write 和 exec；`update_plan`、`skill`、`ask_user` 除外）。
2. `PermissionMemory` 命中则放行。shell 按命令前缀：记住 `npm test` 也放行 `npm test --watch`。
3. `defaultDecision`：`auto` 全放行；read 总放行；`edits` 放行 write；Linux 上沙箱后端是 bwrap 时，`apply_patch`、`shell`、`artifact` 放行。
4. 其余交给 Approver。回答 `y` 只放这一次，`session` 记在内存，`always` 写入 `permissions.json`。无 TTY 且没有 `-y` / `--accept-edits` 时，Approver 直接拒绝。

三种审批：

| 模式 | 入口 | 行为 |
| --- | --- | --- |
| `ask` | 默认、`/ask`、`AGENT_APPROVAL=ask` | 写、shell、网络都问 |
| `edits` | `--accept-edits`、`/edits`、配置 `edits` | 改文件放行，shell 和网络仍问 |
| `auto` | `-y`、`/yes` | 全部放行 |

`AGENT_APPROVAL` 也接受 `acceptEdits` 和 `accept-edits`。ACP 权限选项是 allow-once、allow-session、allow-always、reject-once。

沙箱只包 shell，不包网络工具。Linux 且装了 bubblewrap、`sandbox` 为 `auto` 时，shell 经 bwrap：`--unshare-net`、根目录只读、workspace（以及 artifacts、额外目录）可写。macOS / Windows 没有 bwrap，后端保持 `none`。`AGENT_SANDBOX=none` 关掉检测。

无论后端是不是 bwrap，shell 的环境都会去掉变量名里带 `key`、`token`、`secret`、`password`、`credential`、`passwd` 的项。`PATH`、`HOME`、`LANG`、`LC_*` 以及 Windows 上的 `SystemRoot`、`COMSPEC` 等保留。`web_search`、`web_fetch`、`browser` 仍在 agent 进程里联网。

计划模式是 `runMode: "plan"`，不是另一个循环。工具 schema 仍完整留在请求里（含写和 shell），这样前缀不变、方便缓存；拦截止发生在权限层。system prompt 要求先研究再 `update_plan`，等用户 `/execute` 后再改。

hooks（`.agent/hooks.json`）在权限之后。`PreToolUse` 可以拒绝，`PostToolUse` 可以往结果后追加文本，`Stop` 在回合结束时跑。matcher 按工具名。

## 8. 上下文里有什么

`buildSystemPrompt` 按这个顺序拼，同一次进程里能稳定的部分放前面：

1. 固定操作说明：工作区根、artifacts、平台、超时、模式、沙箱、浏览器，以及 plan 模式附加段。
2. 若目录是 git 仓库，附一行 git 摘要。不是仓库就跳过。
3. `AGENTS.md`：先 `~/.agent/AGENTS.md`，再从家目录方向往下的父目录（最多 8 层），然后工作区自己的 `AGENTS.md` 和 `AGENTS.override.md`。合计截断到 32KB。
4. 记忆：`~/.agent/MEMORY.md` 和 `<workspace>/.agent/MEMORY.md`。
5. Skill 目录（名字和描述，最长约 8000 字符）。正文要等模型调用 `skill`，或用户在消息里写 `$name` / `/name`，才放进 `<loaded_skills>`。

技能从三处加载，同名以后者为准：`~/.agent/skills/<name>/SKILL.md`，然后 `<workspace>/.agents/skills/`，最后 `<workspace>/.agent/skills/`。`SKILL.md` 可以有 YAML 头：

```markdown
---
name: review
description: How to review a change
---
正文只在被点名或调用 skill 工具时进入上下文。
```

没有头时，名字用目录名。目录按名字排序后再放进 system prompt。

浏览器：`auto` 时本机有 Chrome 或 Edge 就走 CDP（无头、可跑页面脚本、可截图），否则 `HtmlDriver` 只做静态 fetch。`AGENT_BROWSER=html` 强制静态。

## 9. 表面

四个表面只换输入输出，不换循环。

### CLI

`src/cli.ts`。单次 `-p`，交互 readline，以及 `session` / `memory` / `permissions` / `serve` / `acp` / `doctor` / `eval` 等子命令。`--output-format` 为 `text` | `json` | `stream-json`。交互斜杠与 ACP 同一组：`/plan` `/execute` `/yes` `/edits` `/ask` `/skills` `/session` `/fork` `/rewind` `/compact` `/memory` `/permissions` `/cost`。

### ACP

`agent acp`，stdio 上的 JSON-RPC 2.0，NDJSON 或 `Content-Length`。协议版本 1。`initialize` 声明：

- `loadSession`、`embeddedContext`（不要图片和音频）
- MCP：`http: true`，`sse: false`
- 会话：额外目录、resume、close、list、delete、fork、rewind、compact

已实现的方法：`initialize`、`authenticate`（空成功）、`session/new`、`session/load`、`session/resume`、`session/close`、`session/list`、`session/delete`、`session/fork`、`session/rewind`、`session/compact`、`session/prompt`、`session/cancel`、`session/set_mode`、`session/set_config_option`。

客户端若提供 fs / terminal，对应工具改走编辑器。`ask_user` 在客户端支持 form elicitation 时走 elicitation，否则退回终端。权限请求带 diff 和 locations。每轮有 `usage_update`（含 billed 估算）。

### HTTP 与网页

`agent serve` 用 Node `http`，默认端口 8080。`AGENT_SERVE_TOKEN` 设置后，除健康检查、`/v1` 和页面外要 `Authorization: Bearer` 或 `X-Agent-Token`。Java 过滤器读的是同一个环境变量。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/`、`/ui` | 网页控制台（`src/web/console.html`） |
| GET | `/v1/health`、`/actuator/health` | 健康检查 |
| GET | `/v1` | 端点列表 |
| GET | `/v1/doctor` | `doctor` 文本 |
| POST | `/v1/prompt` | 跑一轮。`Accept: text/event-stream` 或 body `stream: true` 时走 SSE |
| GET/POST | `/v1/sessions` | 列表 / 创建 |
| GET/DELETE | `/v1/sessions/:id` | 查看 / 删除 |
| GET | `/v1/sessions/:id/usage` | 累计 token |
| POST | `/v1/sessions/:id/fork` | fork，body 可带 `untilEventId` |
| POST | `/v1/sessions/:id/rewind` | rewind |
| POST | `/v1/sessions/:id/compact` | 手动 compact |

### Java 服务端

`server-java` 是 Spring Boot 壳。它解析同一个 agent 二进制（或开发时的 `node dist/cli.js`），把 `/v1/*` 转成 CLI 参数。SSE 逐行转发 `stream-json`。页面是 jar 里的 `static/index.html`，调用的仍是这套 `/v1`。Java 侧没有第二套工具循环。

## 10. 本机数据

根目录是 `AGENT_HOME`，默认 `~/.agent`。

| 路径 | 内容 |
| --- | --- |
| `config.json` | `model`、`provider`、`approvalMode`、`runMode`、`sandbox`、`browser`、`compactTokens`、`toolOutputLimit` |
| `credentials.json` | `agent login` 写入，权限 0600。环境变量优先 |
| `permissions.json` | `always` 记住的 `{ tool, command? }` |
| `sessions/*.jsonl` | 会话 |
| `MEMORY.md` | 用户级记忆 |
| `mcp.json` | 用户级 MCP，工作区 `.agent/mcp.json` 覆盖同名项 |

MCP 服务器可以是 stdio（`command` / `args` / `env`）或 HTTP（`url` / `headers`）。某个服务器连不上只打到 stderr，不让整个 host 起不来。ACP `session/new` 还可以再挂一批会话级 MCP。

项目文件：

| 文件 | 作用 |
| --- | --- |
| `AGENTS.md` | 注入 system prompt |
| `.agentignore` | 搜索忽略，语法同 gitignore |
| `.agent/skills/*/SKILL.md` | 技能 |
| `.agent/mcp.json` | 项目 MCP |
| `.agent/hooks.json` | hooks |
| `.agent/MEMORY.md` | 项目记忆 |

交付物目录是 `AGENT_ARTIFACTS` 或 `<workspace>/artifacts`。

## 11. 发布形态

源码：`npm run build` 跑 `tsc`，并把 `console.html` 拷进 `dist/`。`agent.tgz` 里只有 `dist/`、`scripts/`、`package.json`、`README.md`，安装端需要 Node 22。

原生包用 Node SEA 打成单文件，不需要本机 Node：`agent-darwin-arm64`、`agent-darwin-x64`、`agent-linux-arm64`、`agent-linux-x64`、`agent-win-x64.exe`、`agent-win-arm64.exe`（Windows 另有 zip）。Darwin arm64 在 macos-14 上 codesign。没有 Apple 公证；Gatekeeper 拦截时用 `xattr -cr`。

`agent-server.jar` 打进上述二进制，用 Java 17+ 跑同一套 HTTP。

合入 `main` 且 CI（Linux / macOS / Windows）成功后，`release.yml` 监听这次 `ci` 的 `workflow_run`，再打包并 `gh release create v<package.json 版本>`。说明文字取 `CHANGELOG.md` 里对应的 `## <version>` 段。同一版本再次发布会覆盖该 tag 的资源，所以改文档而不改版本时，合入 main 会重刷 v0.35.0 的包。

安装脚本优先下原生包，失败才退回 `agent.tgz`。`AGENT_REF` 指定 tag 或 `main`。

## 12. 评测

`agent eval <file-or-dir>` 跑确定性夹具，用 scripted provider，不调线上模型。断言看工作区结果，不看模型自述。`npm test` 覆盖循环、权限、ACP、HTTP、打包说明等。原生包和 jar 的打包测试依赖对应工具链，日常不必跑。

## 13. 明确不做

这些是边界，不是漏做：

- 不把 CrewAI / LangGraph 当作核心。流程放在 Skills 和 hooks 里。
- 不做 OAuth，不做图片 / 音频 prompt（ACP 已声明 `image: false`、`audio: false`）。
- 不做 Docker / 云 VM 工作区，不做 Playwright。浏览器是本机 CDP 或静态 fetch。
- 不把包发到公共 npm。分发走 GitHub Release。
- 不做 Apple 公证。
- rewind 不恢复磁盘上的旧文件。
- 子 agent 不能再派子 agent。MCP 工具名单不在对话中途增删；要换就新会话或重新 `session/new`。

## 14. 文件契约

`agent init` 只补缺失文件，不覆盖已有内容。它会创建 `AGENTS.md`、`.agentignore`、`.agent/mcp.json`、`.agent/hooks.json`、`.agent/MEMORY.md`，以及空的 `.agent/skills/`。

### Skills

见第 8 节。正文不进每一轮的 system prompt。

### Hooks

`.agent/hooks.json`：

```json
{
  "PreToolUse": [{ "matcher": "shell", "command": "node .agent/hooks/guard.mjs" }],
  "PostToolUse": [],
  "Stop": [{ "command": "echo done" }]
}
```

`matcher` 省略或 `*` 表示全部工具；否则按正则匹配工具名，正则不合法时退回整串相等。命令在工作区里用 shell 启动，stdin 是一段 JSON（`hook`、`tool`、`arguments`；PostToolUse 另有 `content` 和 `isError`；Stop 只有 `hook` 和 `text`）。超时 10 秒。退出码非 0，或 stdout 是 `{ "decision": "deny", "reason": "..." }`，则 PreToolUse 拒绝这次调用。成功时可以把 `{ "append": "..." }` 贴到工具结果后面。文件坏了当成没有 hooks。

### MCP

`~/.agent/mcp.json` 与 `<workspace>/.agent/mcp.json` 合并，工作区覆盖同名服务器。

```json
{
  "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "some-mcp"], "env": { "FOO": "bar" } },
    "remote": { "url": "https://example.com/mcp", "headers": { "authorization": "Bearer …" } }
  }
}
```

stdio 用 Content-Length 帧。HTTP 是 JSON-RPC，不用 SSE。工具名 `mcp__<server>__<tool>`，按名字排序接在内置工具后面。单个服务器失败只写 stderr。

### 记住的允许

`permissions.json` 是数组：

```json
[{ "tool": "shell", "command": "npm test" }, { "tool": "web_fetch" }]
```

`command` 只对 shell 有意义。没有 `command` 表示这个工具的任意参数都放行。`session` 回答不写这个文件。

### 凭据

`credentials.json` 字段是 `openaiApiKey`、`openaiBaseUrl`、`xaiApiKey`、`anthropicApiKey`。`agent login --provider openai|anthropic|xai` 写入，文件权限 0600。环境变量 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`XAI_API_KEY`、`ANTHROPIC_API_KEY` 优先于文件。transcript 和 HTTP 响应在写出前做同一套脱敏。

### Eval

`agent eval` 不调模型。每个 JSON 用例复制 `workspace` 到临时目录，按 `steps` 直接执行工具，再看断言。

```json
{
  "name": "fix-add",
  "workspace": "../fixtures/broken-add",
  "steps": [{ "name": "apply_patch", "arguments": { "path": "src/add.js", "old_string": "return a - b", "new_string": "return a + b" } }],
  "assert": { "fileContains": { "src/add.js": "return a + b" } }
}
```

`assert.notFileContains` 同样是路径到子串。目录里所有 `.json` 按文件名排序跑。审批在 eval 里是 `auto`。

## 15. 工具契约

| 工具 | 参数要点 |
| --- | --- |
| `read` | `path`，可选 `offset` / `limit` |
| `grep` | `pattern`，可选 `path`、`glob`、`max_matches`（默认 50）。有 `rg` 用 ripgrep，否则自己走目录 |
| `glob` | `pattern`，可选 `path` |
| `apply_patch` | `path` 加一组 `old_string`/`new_string`，或 `edits` 数组。文件不存在且 `old_string` 为空则创建。已存在的文件要求 `old_string` 恰好出现一次 |
| `shell` | `command`，可选 `cwd`、`timeout_ms` |
| `web_search` | `query`，可选 `count`（默认 5）。抓 DuckDuckGo 的 HTML 结果页，不需要搜索 API key |
| `web_fetch` | `url` 必须是 http 或 https。可选 `max_chars`（默认 12000）、`save`、`title`。HTML 会抽成文本 |
| `browser` | `action`: `open` `snapshot` `click` `type` `screenshot` `close` `takeover`。`click`/`type` 用 snapshot 里的 `ref`。`takeover` 经 `ask_user` 把登录、验证码、付款交回用户，然后重新打开该 URL |
| `artifact` | `save` / `list` / `get`。种类：`file` `page` `screenshot` `download` `report` |
| `ask_user` | `question`，可选选项。没有人可问时调用失败 |
| `memory` | `get` / `append` / `replace`。`scope` 为 `user` 或 `project`（默认 project）。`get` 不带 scope 时两份都返回 |
| `skill` | `name` |
| `update_plan` | `steps`：`pending` / `in_progress` / `completed`，可选 `explanation` |
| `task` | `prompt`，`subagent_type` 为 `explore` 或其他，可选 `label` |

grep/glob 忽略：内置跳过 `.git`、`node_modules`、`dist`、`build`、`coverage`、虚拟环境、`__pycache__`、`target`、`.env`。另外读 `.gitignore` 和 `.agentignore`（gitignore 语法）。

Git 不是前提。工作区根上有 `.git` 时，system prompt 里加一行分支和是否脏；没有 `git` 可执行文件就只说明目录存在。不往上找父仓库。

## 16. 输出、用量和窗口

`--output-format json` 在一轮结束时给一条：

```json
{
  "type": "result",
  "sessionId": "…",
  "text": "…",
  "isError": false,
  "aborted": false,
  "tools": [{ "callId": "…", "name": "read", "isError": false }],
  "usage": { "inputTokens": 0, "outputTokens": 0 }
}
```

`stream-json` 把每个 `LoopEvent` 打成一行 `{ "sessionId", ...event }`，最后再加一条上面的 result。`ndjson` 和 `stream_json` 是同一格式。HTTP SSE 的 `data:` 载荷与这两行相同。

token 估算是字符数除以 4，只用于决定要不要自动 compact，不是供应商账单。真实用量来自 provider 的 `usage` 事件，按会话累加。`session cost`、`/cost`、ACP `usage_update` 用同一份合计。美元数是公开标价的估算，认这些模型子串：`claude-opus`、`claude-sonnet`、`grok-4`、`gpt-4.1`、`gpt-4o`。对不上就不报金额。

ACP 上报的上下文窗口按模型名估算：Claude 200_000，Grok 256_000，gpt-4.1 为 1_047_576，gpt-4o / gpt-4 为 128_000，其余取 `max(compactTokens, 128_000)`。

模型 HTTP 对 429、500、502、503、529 最多再试 3 次。有 `Retry-After` 就照它等，否则从 200ms 指数增加，单次最多 8 秒。

## 17. ACP 配置项

`session/new` 和 `session/set_config_option` 暴露三个 select：

| id | 取值 | 作用 |
| --- | --- | --- |
| `mode` | `plan` / `execute` | 计划模式或执行。`execute` 对应 `runMode: default` |
| `model` | 当前模型，以及 `gpt-4.1`、`grok-4`、`claude-sonnet-4-5` | 只接受这份列表里的值 |
| `approval` | `ask` / `edits` / `auto` | 审批光谱 |

权限请求的 `optionId`：`allow-once`、`allow-session`、`allow-always`、`reject-once`。`ask_user` 的选项是 `allow-choice-<n>`，另有 `allow-once`（继续）和 `reject-once`（取消）。

## 18. doctor

`agent doctor` 打印：版本、是不是 SEA、系统、默认 shell、安装目录、`AGENT_HOME`、PATH 里有没有 bin、配置文件在不在、工作区、git、沙箱后端、浏览器二进制、ripgrep 还是自带 walker、provider/model、密钥来源（env / file / missing，不打印密钥本身）、审批模式和已记住的条数。`agent config` 只打生效配置和记住的条数。

## 19. 源码地图

| 路径 | 职责 |
| --- | --- |
| `src/host.ts` | 会话生命周期、子 agent、把表面接到 `runTurn` |
| `src/loop/` | 循环、组装、compact |
| `src/session/store.ts` | JSONL |
| `src/tools/` | 内置工具与注册表 |
| `src/permissions/` | 风险、审批、记住的允许 |
| `src/provider/` | OpenAI 兼容、Anthropic、scripted |
| `src/mcp/` | MCP 客户端 |
| `src/context/` | AGENTS.md、记忆、技能、附件 |
| `src/hooks/` | PreToolUse / PostToolUse / Stop |
| `src/sandbox/` | bwrap 计划 |
| `src/browser/` | CDP 与静态 HTML |
| `src/protocol/` | ACP、客户端 fs / terminal / elicitation |
| `src/serve.ts` | HTTP |
| `src/cli.ts` | 命令行 |
| `src/eval/` | 确定性评测 |
| `server-java/` | 调用同一二进制的 Spring Boot |

## 20. 默认值

| 项 | 默认 |
| --- | --- |
| `approvalMode` | `ask` |
| `runMode` | `default` |
| `sandbox` | `auto`（无 bwrap 则为 none） |
| `browser` | `auto` |
| `compactTokens` | 100_000 |
| `maxToolIterations` | 40（子 agent 最多 20） |
| `shellTimeoutMs` | 60_000 |
| `shellOutputLimit` | 32_768 |
| `toolOutputLimit` | 40_000 |
| provider / model | 见第 5 节 |
