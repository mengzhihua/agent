# 期 6：ACP 客户端文件系统

编辑器驱动 agent 时，未保存的缓冲区只存在客户端里。这一期让 `read` / `apply_patch` 在客户端声明了能力之后走 `fs/read_text_file` 和 `fs/write_text_file`，而不是只看磁盘。`session/new` 的 `cwd` 成为本会话工作区。仍然是同一个 `AgentHost`。

## 范围

已做：

1. `initialize` 记下 `clientCapabilities.fs.readTextFile` / `writeTextFile`（缺省或 false 则禁止对应调用）
2. `session/new` / `session/load` 接受绝对 `cwd`，作为相对路径的根
3. 有读能力时 `read` 向客户端要全文（含未保存内容），再按行号切片
4. 有写能力时 `apply_patch` 在内存里改完，整文件写回客户端
5. 没有对应能力时退回磁盘 `FileIo`（CLI 行为不变）
6. `grep` / `glob` / `shell` 仍走工作区磁盘

不做（以后）：ACP `terminal/*` 见 [期 7](phase-7.md)。session MCP 列表、`additionalDirectories`、Docker workspace、云端 VM、Playwright 包。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
