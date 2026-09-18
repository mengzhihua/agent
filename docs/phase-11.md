# 期 11：ACP 会话列表与删除

编辑器要能发现和清理历史会话。`session/list` 按 cwd 过滤、游标分页；标题取自第一条用户消息。`session/delete` 从列表里拿掉（文件删掉）；已删除或不存在的 id 静默成功。首轮 prompt 之后发 `session_info_update`。

## 范围

已做：

1. `initialize` 声明 `sessionCapabilities.list` 和 `delete`
2. `session/list`：`sessionId` / `cwd` / `title` / `updatedAt`；活动会话带上 `additionalDirectories`；可选 `cwd` 过滤
3. 游标分页（每页 50）；非法 cursor 报错
4. `session/delete`：若会话还在活动表里则先 abort/close，再删 JSONL；重复删除成功
5. prompt 结束后 `session/update` 带 `session_info_update`（title、updatedAt）
6. CLI `--list` 同样显示 title

不做（以后）：SSE 传输、Docker workspace、云端 VM、Playwright 包。Slash commands 见 [期 12](phase-12.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- --list
npm run agent -- acp
```
