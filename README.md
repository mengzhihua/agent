# agent

通用 agent 软件：一个极简的模型–工具循环，外面套 harness。

当前进度：**期 0 — 能跑完任务的 loop**。行业调研见 [docs/industry-agent-research.md](docs/industry-agent-research.md)，本期说明见 [docs/phase-0.md](docs/phase-0.md)。

## 运行

```bash
npm install
npm test
npm run agent -- -y -p "What files are in this workspace?"
```

密钥（任选）：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`XAI_API_KEY`、`ANTHROPIC_API_KEY`。

```text
npm run agent -- -p "prompt"     # 单次
npm run agent -- -y -p "prompt"  # 写/shell/联网自动放行
npm run agent -- --list
npm run agent -- --resume <id> -p "continue"
npm run agent                    # 交互
```

无 TTY 且未加 `-y` 时，写操作和 shell 会被拒绝。

## 内置工具

`read` `grep` `glob` `apply_patch` `shell` `web_search`

会话存在 `$AGENT_HOME/sessions`（默认 `~/.agent/sessions`），JSONL，可 resume。
