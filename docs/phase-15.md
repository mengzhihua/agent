# 期 15：ACP 工具 diff 与 locations

编辑器要能跟着工具走：打开正在读/改的文件，并在 `apply_patch` 完成后显示 diff。`tool_call` 带上 `name`、`rawInput`、`locations`；完成后的 `tool_call_update` 在 content 里加 `type: "diff"`（新文件 `oldText` 为 `null`）。JSONL 不存 diff，replay 只有路径没有补丁。

## 范围

已做：

1. `read` / `apply_patch` 的 `tool_call` 带绝对路径 `locations`（`read` 有 `offset` 时带行号）
2. `apply_patch` 完成后带 full-file `diff`（`path` / `oldText` / `newText`）
3. 实时 `tool_call` 补上 `name` 和 `rawInput`；replay 从参数恢复相对路径 locations
4. `applyPatchTool` 返回 `{ summary, absPath, oldText, newText }`，registry 再映射成工具结果

不做（以后）：SSE 传输、Docker workspace、云端 VM、Playwright 包、累计 cost、布尔 config、图片 prompt。Elicitation 见 [期 16](phase-16.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- acp
```
