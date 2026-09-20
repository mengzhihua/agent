# 期 33：审批光谱 + 记住允许

行业教训：确认框太多用户会无脑点同意。一线产品不是只有 ask / YOLO 两档——Claude Code 有 acceptEdits，Codex 有 approval_policy。以前这里只有 `ask` 和 `-y`（auto）。macOS / Windows 没有 bwrap 时，改一行代码也要确认。

## 范围

已做：

1. `approvalMode: edits`：自动放行 **write**（`apply_patch`、artifact 保存、memory 写入、`web_fetch save`），shell / 网络 / MCP / 浏览器点击仍问
2. `agent --accept-edits`、交互 `/edits`、ACP slash `/edits`、config option `edits`、`AGENT_APPROVAL=edits`、`~/.agent/config.json`
3. 权限提示：`y` 一次、`session` 本会话、`always` 写入 `~/.agent/permissions.json`。shell 按命令前缀匹配（`npm test` 也放行 `npm test --watch`）
4. ACP `session/request_permission` 增加 Allow for session / Always allow
5. 版本 `0.34.0`

`-y` / `/yes` 仍是全部自动放行。plan mode 照旧拦写操作。

不做：OAuth、图片 prompt、Docker workspace / 云端 VM、Playwright、npm 公有源、Apple 公证、按 git snapshot 恢复磁盘。

## 怎么跑

```bash
npm test
npx tsc --noEmit
agent --accept-edits -p "fix the typo"
# 提示时：y | session | always
cat ~/.agent/permissions.json
```
