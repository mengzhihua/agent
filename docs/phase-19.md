# 期 19：忽略规则、Git 环境与项目初始化

装好 CLI 之后，要能在真实仓库里搜文件而不被 `node_modules` / `dist` 淹没，并让模型看见当前 git 状态。`agent init` 负责铺项目文件。

## 范围

已做：

1. grep / glob 遵守 `.gitignore`、`.ignore`、`.agentignore`，并默认跳过 `node_modules`、`dist`、`coverage`、虚拟环境、`.env`
2. 无 `rg` 时 walker 用同一套忽略规则；有 `rg` 时额外传入 `--ignore-file .agentignore` 和默认 `--glob`
3. 工作区有 `.git` 时，system prompt 和 `agent doctor` 带上分支与 dirty 摘要
4. 向上最多 8 层读取父目录 `AGENTS.md`（用户 `~/.agent/AGENTS.md` 仍优先，项目文件最后覆盖）
5. `agent init [dir]` 生成 `AGENTS.md`、`.agentignore`、`.agent/mcp.json`、`.agent/hooks.json`、`.agent/skills/`（已有文件不覆盖）
6. 同一轮里连续的只读工具（read / grep / glob / skill）并行执行；写、shell、`ask_user`、`update_plan`、`task` 仍串行

不做：OAuth、密钥进系统钥匙串、npm 公有源、单文件原生二进制、Docker workspace、云端 VM、Playwright、SSE、图片 prompt、布尔 ACP config、累计 cost。登录凭据见 [期 20](phase-20.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js init
node dist/cli.js doctor
```
