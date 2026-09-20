# 期 24：跨会话 MEMORY.md

附件解决了「这一轮要看哪些文件」。还缺一块跨会话的稳定记忆：用户偏好、仓库惯例。对标 Claude Code 的 durable memory，而不是另做向量库。

## 范围

已做：

1. 用户记忆 `~/.agent/MEMORY.md`（0600）和项目记忆 `<workspace>/.agent/MEMORY.md`
2. 有内容时注入 system prompt 的 `## Memory`（每份最多 8k）
3. `memory` 工具：`get` / `append` / `replace`，`scope=user|project`；`get` 只读，写入在 plan mode 拦截
4. `agent memory [show]`（`--scope`、`--output-format json`）；交互 `/memory`；ACP `/memory`
5. `agent init` 生成 `.agent/MEMORY.md`

不做：自动从对话抽取记忆、向量检索、OAuth、SSE、布尔 ACP config、累计 cost、图片 prompt、Docker workspace、云端 VM、Playwright、npm 公有源、单文件原生二进制。GitHub Release 成品包见 [期 25](phase-25.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js memory show
node dist/cli.js -y -p "Remember that tests are npm test"
```
