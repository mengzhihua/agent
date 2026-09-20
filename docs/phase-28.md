# 期 28：CI 全绿才发 GitHub Release

每次合入 main 且测试无问题，都要出一个用户能下的 Release。以前 `release.yml` 在 main 上和 CI 并行跑，Windows 失败也不挡发版；这一期改成 **CI（Linux / macOS / Windows）成功之后才打包发行**。

## 范围

已做：

1. `release.yml` 监听 `ci` 的 `workflow_run`：仅 `main` 上 `push` 且 `conclusion == success` 才发版；也可 `workflow_dispatch` 手动补发
2. 发布 `v${package.json.version}`，产物含原生二进制、`agent.tgz`、`agent-server.jar`，并标成 latest（`NOTES.md` 只进 Release 说明，不当资源上传）
3. Windows CI：去掉 pack 脚本 shebang（Vitest 解析失败）、`file://` 盘符路径、默认测试超时 30s、zip 解压不依赖 `python3`
4. 版本 `0.29.0`

不做：OAuth、累计 cost、图片 prompt、Docker workspace / 云端 VM、Playwright、npm 公有源、Apple 公证。版本号仍由合入前的 `package.json` 决定（同一版本重复合入会更新该 Release 的资源）。

## 怎么跑

```bash
npm test
npx tsc --noEmit
# 合入 main 后看 Actions：先 ci，全绿再 release
```
