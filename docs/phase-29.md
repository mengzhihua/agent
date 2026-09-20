# 期 29：会话 fork

行业 harness 的 thread 原语是 create / resume / fork / compact。前面已经有新建、resume 和自动 compact；还缺 **fork**：把当前 transcript 拷成一条独立分支，原会话不动。子 agent（`task`）是空上下文；fork 是带着历史分叉。

## 范围

已做：

1. `SessionStore.fork` 复制 JSONL（可选 `--until <event-id>` 截到某条事件），新 `session_meta.id`，记下 `forkedFrom`
2. `agent session fork <id>`；交互 `/fork` 切到新会话；`--resume` 继续该分支
3. ACP `session/fork`（`sessionCapabilities.fork`），拷贝 `additionalDirectories`
4. `POST /v1/sessions/{id}/fork`；Web 控制台「分叉」；Spring Boot 同样代理
5. Windows：`file:///tmp/...` 断言按平台规范化斜杠，避免挡 CI 发版

不做：OAuth、累计 cost、图片 prompt、Docker workspace / 云端 VM、Playwright、npm 公有源、Apple 公证。Fork 不复制 MCP 连接（ACP 可在 `session/fork` 里再传 `mcpServers`）。Apple Silicon 可运行的 Release 包见 [期 30](phase-30.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js session fork <id> --output-format json
curl -X POST localhost:8080/v1/sessions/<id>/fork
```
