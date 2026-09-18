# 期 17：跨平台一键安装

把 agent 做成 Mac / Linux / Windows 都能装、都能跑的 CLI：一条命令安装，本机 Node 22 即可，不依赖 Docker。同时补上非 Linux 上的 Chrome/Edge 查找、Windows shell、PATH 上的 ripgrep。

## 范围

已做：

1. 一键安装：`scripts/install.sh`（macOS/Linux）、`scripts/install.ps1`（Windows），共用 `scripts/setup.mjs` 编译并写入用户 shim
2. `agent --version` / `agent doctor` 检查 node、sandbox、浏览器、rg、安装路径
3. Chrome/Edge 默认路径覆盖 macOS Application 与 Windows Program Files；关浏览器时 Windows 用 `taskkill /T`
4. ACP / 本地 shell 按平台选 `cmd.exe /c` 或 `/bin/sh -c`
5. grep 在 PATH 上找 `rg`/`rg.exe`，找不到就走内置 walker
6. GitHub Actions：ubuntu / macos / windows + Node 22

不做：npm 公有源发布（包名 `agent` 太泛）、打单文件原生二进制、Docker workspace、云端 VM、Playwright、SSE、图片 prompt。

## 怎么装

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.sh | bash
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.ps1 | iex
```

从本仓库：

```bash
npm install
npm run setup
agent doctor
```

卸载：同一脚本加 `--uninstall`，或 `node scripts/setup.mjs --uninstall`。

## 怎么跑

```bash
npm test
npx tsc --noEmit
node dist/cli.js doctor
```
