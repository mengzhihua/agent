# 期 23：Prompt 附件（@path / --file / ACP embedded context）

会话和 JSON 输出之后，用户指出的文件仍要等模型自己去 `read`。Claude Code / Codex / Cursor 都会把 `@path` 或编辑器拖进来的文件直接塞进首轮上下文。这一期用同一套 inject，CLI 和 ACP 一起吃。

## 范围

已做：

1. Prompt 里的 `@path`、`@path:12`、`@path:12-40` 内联成 `<attached_files>`
2. `--file <path>` 可重复，同样内联
3. 忽略规则、二进制、超大文件、越出 workspace 的路径不会塞内容（显式 `--file` / `@path` 会带 error 属性）
4. 纯 `@name`（不像路径）不当附件，避免把 `@sam` 当成文件
5. ACP `promptCapabilities.embeddedContext=true`；`resource_link` 读盘，`resource` 用客户端带来的 text
6. 附件写进 transcript 的 user 消息，system prompt 前缀不变

不做：图片/音频、OAuth、SSE、布尔 ACP config、累计 cost、Docker workspace、云端 VM、Playwright、npm 公有源、单文件原生二进制。跨会话记忆见 [期 24](phase-24.md)。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js -p --file src/cli.ts "summarize this"
node dist/cli.js -p "explain @src/cli.ts:1-40"
```
