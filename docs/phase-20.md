# 期 20：登录凭据、密钥脱敏与请求重试

装好并能在仓库里跑之后，还要把 API key 从环境变量里解放出来：`agent login` 写本机凭据，会话里不落密钥，模型 HTTP 429/5xx 自动重试。

## 范围

已做：

1. `~/.agent/credentials.json`（权限 0600）：`openaiApiKey` / `openaiBaseUrl` / `xaiApiKey` / `anthropicApiKey`
2. `agent login --provider openai|anthropic|xai --key KEY`；无 `--key` 时在 TTY 里询问。`agent logout` 删除
3. 解析顺序：环境变量 > credentials 文件。`loadConfig` 的 provider/model 探测也认文件里的 key
4. 会话 JSONL、HTTP 错误和 CLI 报错会把 key 替换成 `[redacted]`
5. OpenAI / Anthropic 请求对 429、500、502、503、529 最多再试 3 次；401/403 提示去 login
6. `agent doctor` 显示 `auth openai env|file|missing`（不打印 key）

不做：OAuth / 浏览器登录、密钥进系统钥匙串、npm 公有源、单文件原生二进制、Docker workspace、云端 VM、Playwright、SSE、图片 prompt、布尔 ACP config、累计 cost。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js login --provider openai --key sk-test
node dist/cli.js doctor
node dist/cli.js logout --provider openai
```
