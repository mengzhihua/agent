# 期 25：GitHub Release 成品包

用户要的是装好就能用的版本，而不是每次从 main 拉源码再 `npm install` / `tsc`。这一期把编译后的 `dist` 打成 `agent.tgz`，用 GitHub Release 发布；安装脚本默认下这个包。

## 范围

已做：

1. `node scripts/pack-release.mjs`（也可用 `npm run pack:release`）打出 `dist-release/agent.tgz`、`agent-<version>.tgz`、`SHA256SUMS`、`NOTES.md`
2. 包内只有 `dist/`、`scripts/`、`package.json`、`README.md`；没有 TypeScript、没有 `node_modules`（本仓库无运行时依赖）
3. `.github/workflows/release.yml`：main / tag `v*` 上测试、打包，并创建或更新 `v<version>` Release
4. `install.sh` / `install.ps1` 默认 `AGENT_REF=latest`，先下 Release 的 `agent.tgz`，有 `dist/cli.js` 就 `--skip-build`（不需要 npm）
5. 没有 Release 时退回 main 源码安装；`AGENT_REF=main` 强制源码；`AGENT_REF=v0.26.0` 钉版本
6. `agent update` 仍走安装脚本，因此也会跟最新 Release

不做：npm 公有源、单文件原生二进制、OAuth、SSE、布尔 ACP config、累计 cost、图片 prompt、Docker workspace、云端 VM、Playwright。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node scripts/pack-release.mjs
tar -tzf dist-release/agent.tgz
node scripts/setup.mjs --from . --prefix /tmp/agent-rel --no-link --skip-build
```
