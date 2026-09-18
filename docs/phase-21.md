# 期 21：CLI JSON / stream-json 输出

登录之后要把 CLI 做成可脚本化：一次 prompt 能打出稳定 JSON，而不是混在 stderr 里的进度箭头。对标 Claude Code / Codex 的 `--output-format`。

## 范围

已做：

1. `--output-format text|json|stream-json`（环境变量 `AGENT_OUTPUT_FORMAT`）
2. `json`：stdout 一行最终结果（sessionId / text / tools / usage / isError / aborted）
3. `stream-json`：每个 loop 事件一行 NDJSON，最后再跟 `type: result`
4. `-q` / `--quiet` / `AGENT_QUIET=1`：隐藏 stderr 上的 session / 工具进度（错误仍打印）
5. `--list --output-format json` 输出会话数组
6. print 模式下 turn 报错或 aborted 时退出码为 1

不做：OAuth、SSE 传输、布尔 ACP config、累计 cost、图片 prompt、Docker workspace、云端 VM、Playwright、npm 公有源、单文件原生二进制。会话子命令与 eval JSON 见 [期 22](phase-22.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js --help
node dist/cli.js --list --output-format json
```
