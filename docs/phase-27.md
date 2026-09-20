# 期 27：Web 控制台与流式 HTTP

期 26 把 agent 装到了三端和 `java -jar`。还缺产品表面：浏览器里看 turn、工具进度，而不是等一整段 JSON。对标 Codex Web 的 HTTP/SSE，接到同一套 AgentHost。

## 范围

已做：

1. `GET /` / `GET /ui` 内置 Web 控制台（无前端构建、无额外运行时依赖；SEA 把 `console.html` 打进二进制）
2. `POST /v1/prompt` 在 `stream: true` 或 `Accept: text/event-stream` 时推 SSE（与 CLI `--output-format stream-json` 同一套事件）
3. `GET /v1` 接口目录；`GET /v1/doctor` 返回 doctor 文本
4. 只对 POST/DELETE 串行，健康检查和页面在跑 turn 时仍可访问
5. Spring Boot JAR 同样提供页面和 SSE；`Dockerfile` 跑 `agent serve`；`scripts/agent.service` 给 systemd

不做：OAuth、累计 cost、图片 prompt、Docker workspace / 云端 VM、Playwright、npm 公有源、Apple 公证。合入 main 后自动发 GitHub Release 见 [期 28](phase-28.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js serve --port 8080
# 浏览器打开 http://127.0.0.1:8080
curl -N localhost:8080/v1/prompt -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"prompt":"hello","stream":true}'
docker build -t agent .
```
