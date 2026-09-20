# 期 30：Apple Silicon 可运行的 Release 包

以前 `release.yml` 只在 Ubuntu 上 `pack --all`。`agent-darwin-arm64` 文件会上传，但 Mach-O 没有 codesign；Apple Silicon 打开就是 `killed: 9`，等于没有 ARM Mac 版本。

## 范围

已做：

1. macOS 包改在 **macos-14（arm64）** runner 上打 `darwin-arm64` 和 `darwin-x64`：注入前 `codesign --remove-signature`，注入后 ad-hoc `codesign --sign -`
2. Linux 上的 `--all` 只打 linux / Windows，不再产出跑不了的 Darwin 文件
3. `release.yml`：`pack-linux` + `pack-mac` 并行，再 `publish` 合并上传；发布时检查 `agent-darwin-arm64.tar.gz` 存在
4. 版本 `0.31.0`
5. Chrome 关掉后临时 profile 清理改成尽力而为：macOS 上 `Default/` 偶尔 `ENOTEMPTY`，不再拖垮 CI（否则 ARM 包发不出去）

不做：Apple 公证 / Developer ID 证书（未公证仍可能要 `xattr -cr agent`）、OAuth、累计 cost、图片 prompt、Docker workspace / 云端 VM、Playwright、npm 公有源。

## 怎么跑

```bash
npm test
npx tsc --noEmit
# 在 Apple Silicon 上：
node scripts/pack-native.mjs --targets darwin-arm64
codesign -dv dist-release/agent-darwin-arm64
./dist-release/agent-darwin-arm64 -V
```
