# 期 32：累计 token 用量 + 工具输出封顶

行业 harness 会把每次模型调用的 usage 记进 thread，并给工具 stdout 封顶（Grok 大约 40KB）。以前 usage 只在当轮 JSON/ACP 里闪一下，不进 JSONL；read 大文件也能把上下文撑爆。

## 范围

已做：

1. 模型返回的 `usage` 写入会话 JSONL；`inspect` / `session cost` / `/cost` 汇总 input/output tokens，已知模型给粗算 USD
2. ACP `usage_update.billed`；slash `/cost`；`GET /v1/sessions/{id}/usage`；Web「用量」；Spring Boot 同样代理
3. `finishTool` 用 `toolOutputLimit`（默认 40_000，`AGENT_TOOL_OUTPUT_LIMIT`）截断再进 transcript
4. 版本 `0.32.0`

USD 是公开牌价粗算，不是账单。

不做：OAuth、图片 prompt、Docker workspace / 云端 VM、Playwright、npm 公有源、Apple 公证。会话 continue / rewind / 手动 compact 见 [期 31](phase-31.md)。审批光谱见 [期 33](phase-33.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
agent session cost <id>
agent -p --output-format json "hi"   # result.usage
curl localhost:8080/v1/sessions/<id>/usage
```
