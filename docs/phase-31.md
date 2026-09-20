# 期 31：接着上次会话、回退上一轮、手动 compact

行业 harness 的 thread 原语是 create / resume / **continue** / fork / **rewind** / compact。前面已经有新建、`--resume`、自动 compact 和 fork。还缺：

- 不记 id 接着这个工作区最近一次会话（Claude Code 的 `-c`）
- 把上一轮用户消息从 transcript 撤掉（rewind，原会话原地截断；fork 是另开分支）
- 用户主动压缩上下文，不必等到 token 阈值

## 范围

已做：

1. `agent -c` / `--continue`：按 workspace 找最新 JSONL 再 resume；与 `--resume` 互斥
2. `SessionStore.rewind`：默认丢掉最后一个 `user` 及之后的事件；`--until <event-id>` 截到该事件（含）
3. `agent session rewind|compact`；交互 `/rewind` `/compact`
4. ACP `session/rewind`、`session/compact`（`sessionCapabilities.rewind/compact`），slash `/rewind` `/compact`
5. `POST /v1/sessions/{id}/rewind`、`POST /v1/sessions/{id}/compact`；Web 控制台「回退」「压缩」；Spring Boot 同样代理
6. 版本 `0.33.0`

Rewind 只改会话记录，不回滚工作区文件。累计 token 用量见 [期 32](phase-32.md)。

不做：OAuth、图片 prompt、Docker workspace / 云端 VM、Playwright、npm 公有源、Apple 公证、按 git snapshot 恢复磁盘。

## 怎么跑

```bash
npm test
npx tsc --noEmit
agent -c -p "continue from last turn"
agent session rewind <id>
agent session compact <id> --output-format json
curl -X POST localhost:8080/v1/sessions/<id>/rewind
curl -X POST localhost:8080/v1/sessions/<id>/compact
```
