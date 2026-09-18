# 期 9：ACP 额外工作区目录

编辑器可以在 `session/new` / `session/load` 里带 `additionalDirectories`。`cwd` 仍是相对路径的根；这些绝对路径成为同一会话的额外允许根。`read` / `apply_patch` / `grep` / `glob` / `shell` / 沙箱 bind 都认这组根。没有该字段时行为和以前一样。

## 范围

已做：

1. `initialize` 声明 `sessionCapabilities.additionalDirectories`
2. 只接受绝对路径；相对路径忽略；去重
3. 相对路径仍相对 `cwd` 解析，解析结果落在任一允许根内即可
4. 额外根里的文件在工具输出里用绝对 POSIX 路径，避免和 cwd 相对路径撞名
5. bubblewrap 把额外根 bind 进沙箱（目录存在时）

不做（以后）：SSE 传输、Docker workspace、云端 VM、Playwright 包。会话回放 / resume / close 见 [期 10](phase-10.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
