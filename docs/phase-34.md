# 期 34：收尾——查看/撤销记住的权限，Release 说明带变更

`v0.34.0` 已经能记住 `always`，但用户看不到、也撤不掉，只能手改 JSON。Release 正文也只有安装表，看不出这一版改了什么。

## 范围

已做：

1. `agent permissions` / `agent permissions clear`；交互 `/permissions`
2. `CHANGELOG.md` 写入 GitHub Release 的 `NOTES.md`（`## <version>` 那一节）
3. README 安装表补上 Windows arm64（Release 里本来就有这个包）
4. 版本 `0.35.0`。合入 `main` 且 CI 全绿后，`release.yml` 发 `v0.35.0`

不做：OAuth、图片 prompt、Docker workspace / 云端 VM、Playwright、npm 公有源、Apple 公证、按 git snapshot 恢复磁盘。

## 怎么跑

```bash
npm test
npx tsc --noEmit
agent permissions
agent permissions clear --output-format json
```
