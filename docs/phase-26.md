# 期 26：原生二进制与 Spring Boot 服务端

用户要的是在 Windows / macOS / Linux 上**直接能跑**的版本，以及服务器上 `java -jar` 部署。这一期用 Node SEA 打出各平台单文件，并加 HTTP 服务和 Spring Boot 包装 JAR。

## 范围

已做：

1. `scripts/pack-native.mjs`：esbuild 打成单文件 CJS，注入官方 Node 22 二进制（SEA）。产物：
   - Windows：`agent-win-x64.exe` / `agent-win-arm64.exe`（也可 zip）
   - macOS：`agent-darwin-arm64.tar.gz`、`agent-darwin-x64.tar.gz`
   - Linux：`agent-linux-x64.tar.gz`、`agent-linux-arm64.tar.gz`
2. `install.sh` / `install.ps1` 默认先下对应平台的原生包，**不需要本机 Node**；失败再退回 `agent.tgz` + Node 22
3. `agent serve --port 8080`：HTTP API（`GET /v1/health`、`GET /actuator/health`、`POST /v1/prompt`、sessions）。可选 `AGENT_SERVE_TOKEN`
4. `server-java/` Spring Boot 3：`java -jar agent-server.jar`（Java 17+）。JAR 内嵌当前打好的原生二进制，也可用 `AGENT_BIN` 指向 `agent` / `.exe`
5. `scripts/pack-release.mjs --all` 打 tarball + 全平台二进制 + JAR，Release workflow 一并上传

不做：npm 公有源、Apple 公证/Windows 签名证书、OAuth、累计 cost、图片 prompt、Docker workspace、云端 VM、Playwright。Web 控制台与 SSE 见 [期 27](phase-27.md)。macOS 未公证时可能要 `xattr -cr agent`。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node scripts/pack-native.mjs
./dist-release/agent-linux-x64 --version
./dist-release/agent-linux-x64 serve --port 8080
java -jar dist-release/agent-server.jar
```

curl 例子：

```bash
curl -s localhost:8080/v1/health
curl -s localhost:8080/v1/prompt -H 'content-type: application/json' -d '{"prompt":"hello"}'
```
