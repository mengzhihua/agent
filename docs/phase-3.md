# 期 3：沙箱边界与评测

期 2 把 loop 接到了浏览器和交付物。这一期不加确认框，而是划界：shell 默认进 OS 沙箱；再用确定性 eval 把「修 bug」一类任务钉成回归。

云端 VM、Playwright、完整 Zed ACP 仍然不做——研究文档说，关上电脑还在跑才需要云端编排。

## 范围

已做：

1. **bubblewrap 沙箱**（Linux，`AGENT_SANDBOX=auto`）：无网络、宿主机只读、HOME 用 tmpfs 盖住、只有 workspace（以及 artifacts 目录）可写。没有 `bwrap` 时退回 `none`，仍然剥离子进程里的 `*KEY*` / `*TOKEN*` / `*SECRET*`
2. **权限**：ask 模式在沙箱生效时自动放行 `apply_patch` / `shell` / `artifact`；联网、浏览器 click、MCP 仍要问。plan mode 照旧拦写操作
3. **Eval / replay**：JSON 用例按顺序重放工具调用（不走模型）。`agent eval test/evals`
4. CLI：`--sandbox auto|none`，`AGENT_SANDBOX`

不做（以后）：Playwright 包、每任务云 VM / Docker workspace、Temporal、完整 Zed ACP 注册表。真浏览器见 [期 4](phase-4.md)。

## 沙箱长什么样

```text
bwrap --unshare-net --unshare-pid --die-with-parent
     --ro-bind / /
     --tmpfs /tmp --tmpfs $HOME
     --bind $workspace $workspace
     --chdir $cwd -- /bin/sh -c "$command"
```

web_fetch / browser / web_search 仍在 agent 进程里联网，不进 shell 沙箱。

## 怎么跑

```bash
sudo apt-get install -y bubblewrap   # Linux 上才有 OS 沙箱
npm test
npx tsc --noEmit
npm run agent -- eval test/evals
npm run agent -- --sandbox none -y -p "echo uncontained"
```
