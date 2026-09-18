# 期 18：安装进 PATH、自更新与用户配置

一键安装之后还要把 `agent` 真正接到 PATH 上，并让用户能更新、卸载、写一份本机默认配置。优先级：命令行 > 环境变量 > `~/.agent/config.json` > 内置默认。

## 范围

已做：

1. 安装时写入 PATH：Unix 写 `~/.agent/env.sh` 并追加到 `.profile` / 已有的 `.zshrc` `.bashrc`；Windows 用用户级 `Path`（不用会截断的 `setx`）
2. `agent update` 重跑一键安装脚本；`agent uninstall` 先改 PATH 再删 checkout（避免 `dist/path_setup.js` 已经没了）。Unix 会删掉 `~/.agent/env.sh` 并去掉 rc 里的 `# agent PATH` 片段
3. `~/.agent/config.json`：`model` / `provider` / `approvalMode` / `runMode` / `sandbox` / `browser` / `compactTokens`
4. `agent config` 打印生效配置；`agent doctor` 显示 PATH 与配置文件
5. `agent completion bash|zsh|powershell`

不做：npm 公有源、单文件原生二进制、Docker workspace、云端 VM、Playwright、SSE、图片 prompt、布尔 ACP config。

## 配置示例

`~/.agent/config.json`：

```json
{
  "model": "gpt-4.1",
  "approvalMode": "ask",
  "sandbox": "auto",
  "browser": "auto"
}
```

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js doctor
node dist/cli.js completion bash
```
