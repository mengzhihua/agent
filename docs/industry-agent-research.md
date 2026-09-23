# 通用 Agent 行业研究

本文梳理 Codex、Claude Code、Grok Build、Devin、Cursor、Gemini CLI、Manus、OpenHands 等产品，以及 LangGraph / Deep Agents 等框架，回答一件事：**行业里的通用 agent 到底是怎么做的，自己做一个该抄什么、不该抄什么。**

研究截止 2026 年 9 月，依据官方工程博客、开源仓库、技术报告和公开源码分析。本仓库按这些结论落地的实现见 [技术方案](architecture.md)（v0.35.0）。文中的多包草图没有照搬，运行时是单一 TypeScript 包。

---

## 1. 先说结论

行业已经收敛，不是“每个产品一种架构”。

**通用 agent = 模型 + harness（套件），不是模型本身。**

模型负责“下一步做什么”。Harness 负责：组装上下文、调模型、执行工具、鉴权沙箱、压缩上下文、持久化会话、把同一套循环接到 CLI / IDE / Web / API。OpenAI 把这套东西叫 harness；Anthropic 论文级分析里估计 Claude Code 只有约 1.6% 的代码是“AI 决策逻辑”，其余 98.4% 是运行时基础设施。

第二层共识：

1. **循环极简，外围极重。** 核心永远是 `while`：调模型 → 拿 tool_use → 权限检查 → 执行 → 把结果塞回上下文 → 再调。LangGraph 那种显式状态图适合“流程确定”的业务编排，不适合做 Claude / Codex 这种通用 agent。
2. **一套循环，多种表面。** CLI、TUI、IDE、Web、Slack、headless 全部接到同一个 agent loop。Codex 用 App Server + JSON-RPC；Grok / Cursor / Gemini 用 Agent Client Protocol（ACP）。
3. **工具宁少勿碎。** 生产级 coding agent 的内置工具通常是：读文件、搜代码、改文件、跑 shell、联网、计划/待办、spawn 子 agent。其余能力走 MCP 和 Skills。
4. **上下文是最稀缺的资源。** Skills 用渐进披露；子 agent 用隔离上下文，只把摘要交回父 agent；超窗就 compact；prompt 前缀尽量不变以吃 cache。
5. **安全是分层的，不是一个开关。** deny-first 权限 + OS/容器沙箱 + hooks + 可逆操作少问、不可逆多问。用户对每一步弹窗会疲劳（Claude 侧数据：约 93% 的权限提示会被点同意）。
6. **云端 agent 的差异不在循环，在“电脑”。** Devin / Cursor Cloud / Manus 给每个任务一台隔离 VM（Firecracker / Devbox / E2B），再用 Temporal 一类 durable workflow 管生命周期、follow-up、子 agent。

如果要做一款通用 agent 软件，正确起点是 **Claude Code / Codex / Grok Build 这一类本地 harness**，而不是 Devin 那种完整云端工程师，也不是 CrewAI 那种角色扮演多 agent。云端 VM、浏览器、多模型路由可以后加。

---

## 2. 产品地图：看起来像一类，其实是三层

| 层 | 代表 | 用户以为它是 | 它实际卖的 |
| --- | --- | --- | --- |
| 本地/近端 coding harness | Claude Code、Codex CLI、Grok Build、Gemini CLI、Cursor Agent | “会写代码的聊天机器人” | 接在你机器/仓库上的 agent loop + 工具 + 权限 |
| 云端异步工程师 | Devin、Cursor Cloud Agents、Codex Cloud | “把任务丢出去等 PR” | 隔离 VM + durable orchestration + 验证产物（测试、截图、视频） |
| 通用电脑 agent | Manus、OpenClaw | “什么都能干的助手” | 完整云电脑（shell + 文件系统 + 浏览器 + 代码执行），任务不限于仓库 |
| 可自托管脚手架 | OpenHands、SWE-agent | 开源 Devin | workspace 抽象 + 事件源状态 + 沙箱 |
| 编排框架 | LangGraph、Deep Agents、AutoGen、CrewAI | “做 agent 的 SDK” | 图/对话/角色原语；Deep Agents 才开始向 Claude 式 harness 靠拢 |

做“通用 agent 软件”时，先决定落在哪一层。三层可以共用同一个 loop，但 **runtime、产品形态、安全和计费完全不同**。

---

## 3. 行业通用架构

几乎所有能用的产品都可以画成同一张图：

```text
  CLI / TUI / IDE / Web / Slack / API
                 │
        ACP 或 JSON-RPC / SSE
                 │
        ┌────────┴────────┐
        │  Thread Manager │  会话：create / resume / fork / compact
        └────────┬────────┘
                 │
        ┌────────┴────────────────────────────────┐
        │              Agent Loop                  │
        │  assemble context → sample model         │
        │       ↑                    │             │
        │       │              tool_use?           │
        │       │                    │             │
        │  append result      Permission + Hooks   │
        │       │                    │             │
        │       └──────── Tool Router ─────────────┤
        └─────────────────────────────────────────┘
                 │
     ┌───────────┼────────────┬──────────────┐
     │           │            │              │
  Built-in    MCP tools    Skills       Sub-agents
  (fs/shell/  (外部系统)   (SKILL.md)   (隔离上下文)
   search)
                 │
        Workspace / Sandbox / Cloud VM
```

### 3.1 Agent loop（所有产品的心脏）

OpenAI 在 [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) 里写得很直白：

1. 用户输入进入当前 thread。
2. Harness 组装 prompt：`instructions` + `tools` + `input`（权限说明、AGENTS.md、skills 元数据、环境上下文、用户消息）。
3. 调模型（流式）。模型要么给最终 assistant message，要么发 tool call。
4. Harness 执行 tool，把 `function_call_output` 追加到 input，再调模型。
5. 直到模型不再调工具，控制权交回用户。一次 user message 对应一个 **turn**，turn 内部可以有几十上百次 tool 循环。

Claude Code 的 `queryLoop()`、Grok Build 的 `SessionActor`、Gemini CLI 的 Scheduler、OpenHands 的 action-observation 事件流，都是这件事。

生产级 loop 还必须处理这些“不像 AI 的问题”：

- 流式事件（思考摘要、文本 delta、tool 进度）转给 UI
- 取消 / 打断 / follow-up 插入
- 并行 tool（只读可并行，写/shell 串行）
- 输出截断与蒸馏（工具 stdout 动辄几十 KB）
- 失败重试、max_output_tokens 后续写
- 中途改权限/cwd 时不破坏 prompt cache

### 3.2 一套 harness，多种表面

| 产品 | 共享核心 | 客户端协议 |
| --- | --- | --- |
| Codex | Rust core + ThreadManager | App Server：双向 JSON-RPC；Web 再包一层 HTTP/SSE |
| Claude Code | `queryLoop` | CLI / IDE / Agent SDK / headless 共用 |
| Grok Build | `xai-grok-shell` SessionActor | TUI + headless + **ACP** |
| Cursor | 同一套 agent fundamentals | 编辑器本地；Cloud 走 Temporal；CLI 也讲 ACP |
| Gemini CLI | `packages/core` | CLI + VS Code agent mode + ACP |

行业协议已经分家，不要混：

| 协议 | 解决什么 | 不解决什么 |
| --- | --- | --- |
| **MCP**（Model Context Protocol） | Agent ↔ 工具/数据源 | 客户端怎么画 UI |
| **ACP**（Agent Client Protocol，Zed 发起） | 编辑器/客户端 ↔ agent 进程（stdio JSON-RPC） | 工具怎么实现 |
| **A2A**（Agent2Agent，Linux Foundation） | 独立 agent ↔ 独立 agent | 子 agent 内部调度（那是 harness 自己的事） |

IBM 的 ACP（Agent Communication Protocol）已并入 A2A，和 Zed 的 Agent Client Protocol **不是同一个东西**。

工程含义：如果你要做通用软件，**MCP 必做，ACP 强烈建议，A2A 可以以后再做**。MCP 让生态工具即插即用；ACP 让你的 agent 能进 Zed / 其他编辑器，而不为每个 IDE 写插件。

### 3.3 工具：少而稳，再靠扩展

生产系统几乎都收敛到同一组原语：

| 能力 | 典型工具 | 备注 |
| --- | --- | --- |
| 看代码 | Read / Grep / Glob / 语义搜索 | Cursor 把语义搜索放在环境外，因为依赖索引服务 |
| 改代码 | 精确 str_replace，而不是整文件胡写 | SWE-agent 的 ACI 论文核心：给模型适合的编辑界面 |
| 执行 | Shell，带超时、cwd、输出上限 | 几乎所有复杂能力最后都退化成 shell |
| 计划 | update_plan / todos | 给用户看进度，也给模型自己盯目标 |
| 联网 | WebSearch / WebFetch，或 Responses API 原生 web_search | |
| 委派 | Agent / Task 工具 | 子会话隔离上下文 |
| 外部系统 | MCP | GitHub、Notion、Slack、浏览器…… |

Manus / OpenHands 多一条路：**CodeAct**——少定义 function tools，让模型写 Python 去编排。这对“通用电脑任务”更灵活，对“仓库里精确改一行”更难控。Coding harness 主流仍是结构化 tool call。

Grok 还有 **Code Mode**：会话里嵌一个持久 V8，模型写 JS 调 nested tools，适合把多步工具编排从上下文里搬进代码。这是 2026 年的新方向，不是第一版必做。

### 3.4 扩展的四档成本

Claude Code 把扩展按 **上下文成本** 分层，这是目前最好的产品化思路：

| 机制 | 上下文成本 | 何时用 |
| --- | --- | --- |
| **Hooks** | 0（确定性脚本，模型看不见或只看到结果） | 格式化、审计、拦危险命令 |
| **Skills**（`SKILL.md`） | 低：先只注入 name+description，用到再读全文 | 可复用工作流、领域知识 |
| **Plugins** | 中 | 打包 commands/skills/hooks/MCP |
| **MCP** | 高：工具 schema 常驻 prompt | 连外部系统 |

[Agent Skills](https://agentskills.io/home) 已成跨产品开放格式。Claude、Codex、ChatGPT 都认：一个目录 + `SKILL.md`（YAML frontmatter 的 `name`/`description`）+ 可选 `scripts/` `references/` `assets/`。渐进披露分三步：

1. 启动时只加载元数据（约 100 tokens/skill）
2. 命中后再读 `SKILL.md` 正文
3. 脚本和参考文件按需再读；脚本甚至可以只把 stdout 送进上下文

Codex 还把初始 skills 列表卡在大约上下文的 2%（未知窗口时 8000 字符），技能太多就先缩短 description。

**自己做通用 agent：Skills 比“把所有知识塞进 system prompt”重要得多。** 这是目前唯一被多家一线产品共同标准化的扩展方式。

项目级指令也在标准化：`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`，从 repo 根到 cwd 层层叠加，越近越优先。

### 3.5 上下文管理

长任务会把窗口吃光。行业做法叠了好几层：

1. **Prompt cache 友好**：静态内容（instructions、tools）放前缀，变更用“追加一条新消息”而不是改前面的 item。Codex 为此甚至不用 `previous_response_id`，好做 ZDR（零数据保留）和无状态请求。MCP 工具列表顺序不稳定会直接打爆 cache。
2. **自动 compact**：超阈值就把历史总结掉。Codex 走 Responses API 的 `/responses/compact`，还能带加密的 latent 摘要。Claude 是多层：autoCompact（总结）+ snipCompact（裁剪）+ contextCollapse（重构）。
3. **工具输出封顶**：Grok 默认大约 40KB；Gemini 有 distillation。
4. **子 agent 保护父上下文**：子会话独立 window，只返回 summary。Claude 估算 spawn 子 agent 大约 7× token，但能避免父会话被探索过程污染。
5. **按需加载**：Skills、MCP resources、CLAUDE.md 分层，不要一次灌进去。

Devin Fusion 更进一步：主 agent（贵模型）尽量少动手、多委派；便宜 sidekick 自己拉上下文；**在 compact 时切换模型**，因为 compact 反正会 cache miss，换模型几乎免费。

### 3.6 安全：用户要的是边界，不是 100 次确认

| 层 | 做什么 | 谁在用 |
| --- | --- | --- |
| 权限策略 | deny-first 规则，只读默许、写/网络要批 | Claude（最多 7 档 mode）、Codex approval_policy、Gemini PolicyEngine |
| 沙箱 | 文件系统 + 网络独立限制 | Codex sandbox、Claude shell sandbox、Grok OS sandbox |
| 隔离电脑 | 整个 VM / 容器与宿主机分离 | Devin Devbox、Cursor Firecracker、Manus E2B、OpenHands Docker |
| Hooks | PreToolUse 可改写或阻止 | Claude 27 种 hook 事件；Cursor `.cursor/hooks.json` |
| 自动放行分类器 | 在 auto 模式里判断这次调用危不危险 | Claude `yoloClassifier` 两段式 |
| 可逆性加权 | 只读少问，破坏性多问 | 全行业 |

Claude 的教训特别重要：弹窗太多用户会无脑点同意。正确姿势是 **在划定的沙箱里让 agent 自由干，越界再问人**。

### 3.7 状态：事件日志，不是可变对象

能 resume / fork / rewind 的产品，状态几乎都是 **append-only**：

- Claude：JSONL transcript
- Codex：thread persist + SQLite
- OpenHands V1：event-sourced ConversationState，组件本身 immutable
- Cursor Cloud：S3 + Redis stream，前端只读流，不直接打 Temporal query

这带来：崩溃可续、审计、fork 一条时间线、UI 重放。OpenHands V0 的教训是：配置和状态到处可变，两个入口同一组参数都会跑出不同结果。

### 3.8 云端：loop 不够，还要“一台电脑 + 工作流引擎”

Cursor 公开了 Cloud Agents 的运维真相（Temporal Replay 2026）：

- 每个 agent 一台隔离 VM；loop 发生在 VM ↔ 模型之间，不占用用户电脑。
- 自研编排只有约 90% 成功率；换成 Temporal 后 activity 成功率 >99%，每天约 5000 万 activity / 700 万 workflow。
- VM 空闲就拆，follow-up 用 signal-with-start 再拉起来，checkout 分支、灌历史，用户感觉 agent 一直活着。
- 子 agent = Temporal child workflow，共用 VM、全新上下文。
- 展示层和执行层拆开：历史走 S3，实时走 Redis；activity 重试用 marker 让前端回放。
- 内部已有约 1/3 合入 PR 来自 Cloud Agents。

Devin 拆成 Brain（Cognition 云上的智能，无状态）+ Devbox（执行环境）。人可以进内嵌 IDE / 终端 / 浏览器接管。Fusion 架构是双 agent：frontier lead + 便宜 sidekick。

Manus 给每个任务一台完整云电脑（网络、文件系统、浏览器、解释器），sleep/wake 保文件。很多任务最终还是“写代码解决问题”，所以通用 agent 和 coding agent 在 runtime 层正在会合。

---

## 4. 产品拆解

### 4.1 Codex（OpenAI）

**定位：** 软件工程 harness。CLI、IDE、macOS app、Web 共用核心。

**怎么做：**

- Rust 实现；Submission/Event 队列，可取消、可插队。
- 模型走 Responses API（ChatGPT 登录、API key、Azure、本地 oss 都能接同一协议）。
- 内置 `shell`、`update_plan`，加上 API 侧 `web_search` 和用户 MCP。
- App Server 是长期进程：stdio JSON-RPC ↔ ThreadManager ↔ 多个 core session。Web 版在容器里跑同一份 App Server，浏览器只吃 HTTP/SSE。
- 上下文：前缀不变吃 cache；超限自动 compact。
- 权限/沙箱只包住 Codex 自己的 shell；MCP 工具各自负责安全。

**可抄：** 单一 harness + 多表面；无状态请求 + cache 纪律；thread 作为一等对象（create/resume/fork/archive）。

**不必第一版抄：** Responses API 的加密 compaction、Guardian 子 agent、完整 App Server 协议可以后做。ACP 或自有 JSON-RPC 先有一个即可。

### 4.2 Claude Code（Anthropic）

**定位：** 目前设计空间被分析得最清楚的生产 harness。

**怎么做：**

- 所有入口进同一个 `queryLoop` async generator。
- 最多约 54 个内置工具 + MCP；`StreamingToolExecutor` 把并发安全的 tool 并行跑。
- 权限：deny-first，plan → default → acceptEdits → auto → dontAsk → bypassPermissions。
- 扩展：hooks / skills / plugins / MCP，三个注入点——assemble（模型看见什么）、model（能调什么）、execute（允不允许跑）。
- 子 agent：`default | fork | worktree | remote`，父会话只收摘要。
- 任务图可落盘（TaskCreate/Update/Get/List），跨重启还在。
- 配置和记忆尽量是文件：`CLAUDE.md`、`.claude/agents/*.md`、JSONL。人能读、能进 git。

**可抄：** 扩展分层、权限光谱、子 agent 隔离、文件即配置。这是做“通用”而不是“只能写代码”时最值得抄的产品哲学：Unix 工具而不是封闭套件。

**注意：** 它把推理全交给模型，**没有** LangGraph 式规划图。前提是模型已经很强。弱模型上同一套 harness 会显得“会跑但不会想”。

### 4.3 Grok Build（xAI / SpaceXAI）

**定位：** 开源的终端优先 coding agent（Rust）。2026-07 开源。

**怎么做：**

- 包拆分清楚：TUI、shell runtime、tools、workspace（文件系统/VCS/checkpoint）。
- `SessionActor` 管一轮：拼 prompt、流式采样、权限/hooks/plan gate、dispatch、持久化。
- 工具走 JSON-RPC，**先 subscribe 再 send**，避免 bash stdout 抢在 UI 准备好之前到达。
- 支持 skills、plugins、hooks、MCP、subagents、worktree、checkpoint/rewind。
- 可接任意兼容模型，可本地推理。
- 原生 ACP，能嵌进 Zed 等编辑器。

**可抄：** 开源参考实现的工程结构；ACP；workspace 与 agent 分离；plan mode。若技术栈选 Rust，这是比 Codex 更完整公开的 TUI+runtime。

### 4.4 Cursor

**定位：** IDE 里的同步 agent + 云端异步 agent。Composer 2 还在**同一套生产 harness 里做 RL**，减少 train-serve 不一致。

**本地 harness：** 模型特定的 instructions + 工具（读改搜、终端、MCP、skills、hooks、browser/computer use、subagents）。不同模型对同一 prompt 行为不同，所以 Cursor 按模型调教 harness。

**Cloud Agents：**

- Firecracker 级隔离 VM + 完整开发环境（clone、依赖、secrets、startup）。
- Temporal 管 VM 生命周期、agent loop、follow-up、子 agent、自动 review。
- 环境可用 snapshot / Dockerfile / `.cursor/environment.json` 预热，避免每次从零 install。
- 正确性证据不只是 diff：截图、录屏、测试日志。前端变更尤其吃这一套。

**可抄：** “harness 跟模型一起训/一起调”；云端先解决可靠性和环境，而不是先堆模型；展示层与工作流执行解耦。

**不必第一版抄：** Temporal + 自建微 VM 平台是规模问题。没有日均百万 workflow 时，先 Docker / 单机 session 足够。

### 4.5 Devin（Cognition）

**定位：** 把 backlog 票变成可接管的云端工程师，不是 IDE 插件。

**怎么做：**

- Brain 永远在 Cognition 云；Devbox 是隔离执行环境（shell、IDE、浏览器）。
- 先写计划再动手；执行中用测试/编译/命令输出做观察，不行就重规划。
- 人可以随时进 workspace 接管。
- 用 evaluator agent（同样有浏览/shell/编辑）打分，而不只信模型自评。
- Fusion：贵模型 lead 做计划、歧义、终审；便宜 sidekick 跑具体活；compact 时切换模型。

**可抄：** 验证与生成分离；人可接管的共享 workspace；主从模型分工。

**不要一上来抄：** 完整 Devbox 产品、企业 VPC、按 ACU 计费。那是公司形态，不是 harness MVP。

### 4.6 Gemini CLI（Google）

**定位：** 开源 TypeScript coding agent，也驱动 Gemini Code Assist 的 agent mode。

**怎么做：** `packages/cli`（UI）和 `packages/core`（loop、工具、会话）分离。Scheduler 做工具校验 → policy → 确认 → 执行。MCP、hooks、plan mode、子 agent、context compression、loop detection 都有。确认总线允许用户改 tool 参数再跑。

**可抄：** 前后端包分离；policy 与 executor 拆开。若团队主语言是 TS，这是可读性最好的参考之一。

### 4.7 Manus（通用电脑 agent，现 Meta）

**定位：** 不绑仓库的通才。规划、浏览、写代码、交付完整应用。基准是 GAIA 不是 SWE-bench。

**怎么做：**

- 每任务一台完整沙箱云电脑（曾用 E2B / Firecracker）。
- Planner 拆任务；执行侧偏 CodeAct：写 Python 调浏览器/shell/文件系统。
- 状态靠 event stream + `todo.md` + 中间文件，而不是巨大的 hidden chain-of-thought。
- 可并行拉多个全能子 agent，由协调者汇总。
- Sandbox 可 sleep，文件还在。

**对“通用 agent 软件”的启示：** 如果目标不是 IDE，而是“给人一台会干活的电脑”，Manus 才是对标，而不是 Claude Code。那时浏览器 + 持久 VM + 文件产物（报告、网站、表格）是一等公民，git/PR 不是。

### 4.8 OpenHands 与 SWE-agent

**OpenHands V1** 把 18 个月开源教训收成 SDK：

- 默认本地跑，沙箱 opt-in（V0 强制 Docker 导致 CLI/MCP 双重实现）。
- 组件 immutable，唯一可变的是 ConversationState。
- 四包：sdk / tools / workspace / agent_server。
- 自带 VS Code / VNC / Chromium，人和 agent 看同一台电脑。
- 模型无关，可路由 100+ provider。

**SWE-agent** 贡献的是 ACI：工具要按模型习惯设计（open/scroll/edit），不是把 Unix 原样扔给 LLM。Mini-SWE-agent 用约 100 行 Python 就能接近大脚手架分数——说明 **模型 + 小而精的工具** 往往压过框架复杂度。

### 4.9 框架层：LangGraph / Deep Agents / AutoGen / CrewAI

2026 年 LangChain 自己把栈说清了：

| 层 | 是什么 | 什么时候用 |
| --- | --- | --- |
| LangGraph | 图 runtime：节点、边、typed state、checkpoint | 步骤必须确定、要审计、要人工卡点 |
| `create_agent` | 最小 tool loop + middleware | 想自己装上下文/权限 |
| Deep Agents | 意见很满的 harness（文件系统、子 agent、skills、摘要、审批） | 想做 Claude 类通用 agent，但用 LangChain 生态 |

CrewAI 适合“角色工单”原型，不适合任意循环的 coding/通用 agent。AutoGen 的原语是 agent 对话，适合互相挑剔的协作，不适合当操作系统。

**关键判断：** 一线产品（Claude、Codex、Grok、Gemini）都选了 **最小脚手架 + 最大运行时**。只有流程合规性强的企业工作流才值得一上来上图。Deep Agents 是框架世界向产品世界的靠拢，不是反过来。

---

## 5. 设计空间：做通用 agent 必须回答的题

每家产品都在答同一组题，答案不同是因为部署场景不同。

| 问题 | 一线共识 | 常见分叉 |
| --- | --- | --- |
| 推理放哪？ | 模型想，harness 执行和执法 | LangGraph 把控制流写死 |
| 几个执行引擎？ | 一个 loop，多表面只换渲染 | 按 IDE/CLI 分叉（后患无穷） |
| 默认安全姿态？ | deny-first + 沙箱里自动 | 全部手动批 / 全部 YOLO |
| 绑定约束是什么？ | 上下文窗口，不是 CPU | 有人以为是“规划算法” |
| 本地还是云？ | 先本地，云是加一台电脑 | Devin 反过来，从云电脑起步 |
| 工具形态？ | 少量结构化 tools + MCP + Skills | CodeAct 万能解释器 |
| 扩展怎么分层？ | hooks / skills / plugins / MCP | 一个插件 API 打天下 |
| 子 agent？ | 隔离上下文，摘要返回 | 共享全部历史（窗口必爆） |
| 状态？ | append-only 事件 | 可变 session 对象 |
| 多模型？ | 按模型调 prompt/工具；compact 时换模型 | 运行中途乱换（cache 全废） |

Claude 偏 **逐步信任 + 本机策略**；OpenClaw 类网关偏 **周界准入**；Devin/Manus 偏 **电脑级隔离**。通用产品往往最后三层都要，但落地顺序必须分清。

---

## 6. 若从零做一款通用 agent，建议怎么做

目标如果是“通用 agent 软件”（能写代码、能查资料、能操作本地/云环境、能接第三方系统），不要第一天模仿 Devin 的公司结构。按下面四期长。

### 期 0 — 一个能跑完任务的 loop

最小闭环：

1. Thread / Session（创建、追加、resume）
2. Agent loop（流式、可取消）
3. 工具：`read` / `grep` / `glob` / `apply_patch` / `shell` / `web_search`
4. 权限：只读自动、写和 shell 确认
5. 简单 compact（超窗总结）
6. JSONL 或 SQLite 存 transcript

模型可先接一家，但 **API 适配层留好**（OpenAI Responses / Anthropic Messages / Gemini 都能映到同一内部 `ToolCall`）。

验收：在真实仓库里改一个 bug，跑测试，给出总结。没有这一步，后面全是空中楼阁。

### 期 1 — 让它像产品而不是脚本

- `AGENTS.md` + Agent Skills（开放 `SKILL.md` 格式）
- MCP client（stdio / HTTP）
- Plan mode（先计划后执行）
- 子 agent（explore / 一次性任务，隔离上下文）
- Hooks（至少 PreToolUse / PostToolUse / Stop）
- 一种好用的表面：TUI 或 Web；协议预留 ACP
- Prompt cache 纪律：tools 排序稳定，配置变更只追加、不改前缀

这一期结束，你已经和 Claude Code / Grok Build 同一量级的 **产品形状**，只是深度差一截。

### 期 2 — 通用化：从“写代码”到“办事”

通用和 coding 的分界是 **workspace 是否必须是 git repo**：

- 浏览器（或 computer use）成为一等工具
- 持久工作目录：用户文件、下载、生成的报表/站点
- 连接器：邮件、日历、Notion、Slack……一律 MCP，不要为每个 SaaS 写死工具
- 人机共操：敏感站让用户接管浏览器
- 产物：文件附件，而不只是 git diff

这是 Manus 的方向。实现上仍是同一个 loop，换的是工具和 workspace 语义。

### 期 3 — 云端异步

只有当用户需要“关上电脑也在跑”时再做：

- 每任务隔离 VM（先 Docker，再 Firecracker）
- 环境快照（依赖预装）
- Durable workflow（Temporal 或等价物）管 follow-up / 重试 / 子 agent
- 验证：测试、截图、录屏
- 多表面通知：Web / IM / PR

Cursor 的教训：没可靠编排之前，内部都没人爱用云 agent；可靠了之后用量才爆发。

### 明确不要做的

1. **不要先做 20 个专家 agent 角色扮演。** 一线产品是一个通才 + 按需 spawn 专家子会话。CrewAI 式“研究员/作家/评论家”适合 demo。
2. **不要把业务流程图写进核心。** 流程用 Skills 和 hooks 表达，让模型在 loop 里选。
3. **不要把所有 MCP 工具 schema 无上限塞进 prompt。** 要装配、过滤、去重。
4. **不要运行中途随意换模型或换工具列表。** cache 和心智都会碎；换就在 compact 边界换。
5. **不要用“再加一个确认框”当安全。** 用沙箱划界。
6. **不要自研第二套 loop 给 IDE。** 表面可以多，引擎必须一。

### 建议的模块边界（实现时）

```text
agent-core/          loop, session, compaction, permissions
agent-tools/         fs, shell, search, web, task/subagent
agent-mcp/           MCP client
agent-skills/        SKILL.md loader, progressive disclosure
agent-workspace/     local fs | docker | vm  （同一接口）
agent-server/        JSON-RPC 或 ACP，给所有 UI 用
apps/tui | apps/web | apps/ide
```

OpenHands V1 和 Grok Build 都是这个切法。核心保持无 UI、无 Docker 硬依赖，workspace 可插拔。

### 评测从第一天就要有

行业靠环境反馈，不靠模型夸自己：

- 编码：SWE-bench 一类，但更要自己的真实仓库任务
- 通用：GAIA / 内部“办事”集（找资料、出表格、点网页）
- 回归：固定轨迹 replay（OpenHands 的 deterministic replay、Cursor 的 Temporal history replay 是同一思想）
- 安全：越权、prompt injection、数据外泄

没有评测，harness 调 prompt 全凭感觉，这是这类项目最常见的死因。

---

## 7. 一句话对照

| 你想做成 | 对标 | 第一年重心 |
| --- | --- | --- |
| 终端/IDE 里的通用编程助手 | Claude Code、Codex、Grok Build | 单一 loop + 工具 + Skills + MCP + 权限 |
| 关掉电脑也在干活的工程师 | Cursor Cloud、Devin、Codex Web | 上面那些 + VM + durable orchestration |
| 不限代码的全能助理 | Manus | 上面那些 + 浏览器 + 持久云电脑 + 文件产物 |
| 给别人做 agent 的平台 | OpenHands SDK、Deep Agents | 把 harness 做成库，workspace/server 可组合 |

无论哪条路，**不要从框架的多 agent 对话开始，要从一个可靠的 tool loop 和一台可隔离的电脑开始。** 模型和产品会变，这套分层不会。

---

## 8. 主要来源

- OpenAI，[Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)；开源 [openai/codex](https://github.com/openai/codex)
- OpenAI，[Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- Liu et al.，[Dive into Claude Code](https://arxiv.org/html/2604.14228)；[VILA-Lab/Dive-into-Claude-Code](https://github.com/VILA-Lab/Dive-into-Claude-Code)
- xAI，[Grok Build is Now Open Source](https://x.ai/news/grok-build-open-source)；[xai-org/grok-build](https://github.com/xAI-org/grok-build)
- Cursor，[Cloud Agents 文档](https://cursor.com/docs/cloud-agent.md)；[Agent best practices](https://cursor.com/blog/agent-best-practices)；[Composer 2 技术报告](https://arxiv.org/pdf/2603.24477)；Temporal Replay 2026 / ZenML 案例
- Cognition，[Evaluating coding agents](https://cognition.com/blog/evaluating-coding-agents)；[Devin Fusion](https://cognition.com/blog/devin-fusion)；Devin 文档
- Google，[gemini-cli architecture](https://github.com/google-gemini/gemini-cli/blob/main/docs/architecture.md)
- Wang et al.，[OpenHands Software Agent SDK](https://arxiv.org/html/2511.03690v1)
- Manus，[Understanding Manus sandbox](https://manus.im/blog/manus-sandbox)；E2B，[How Manus Uses E2B](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers)
- [Agent Skills 规范](https://agentskills.io/home)；[A2A Protocol](https://a2a-protocol.org/latest/)；Zed ACP
- LangChain，[Deep Agents vs LangChain vs LangGraph](https://www.langchain.com/blog/deep-agents-vs-langchain-vs-langgraph)
