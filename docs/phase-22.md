# 期 22：会话子命令与 eval JSON

期 21 让单次 prompt 能打出稳定 JSON。脚本还要能查看、导出、删除本地 transcript，以及把 eval 结果当成机器可读的回归报告。对标 Claude Code / Codex 的会话管理，而不是另做一套存储。

## 范围

已做：

1. `agent session list|show|delete|export`；`--list` 仍是 `session list` 的别名
2. `show` 文本打印 transcript，`--output-format json` 输出结构化 inspect 对象（id / cwd / model / title / events）
3. `export` 始终输出 JSON inspect 对象
4. `delete` 幂等：文件不在也成功；JSON 为 `{ id, deleted: true }`
5. `agent eval <file-or-dir> --output-format json` 输出 `{ type: "eval", passed, failed, results }`；失败时退出码 1
6. `--session-dir` 对 session 子命令生效

不做：OAuth、SSE 传输、布尔 ACP config、累计 cost、图片 prompt、Docker workspace、云端 VM、Playwright、npm 公有源、单文件原生二进制。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js session list --output-format json
node dist/cli.js session show <id>
node dist/cli.js session export <id>
node dist/cli.js session delete <id>
node dist/cli.js eval test/evals --output-format json
```
