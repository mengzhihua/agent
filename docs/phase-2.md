# 期 2：通用电脑，而不只是写代码

期 0/1 已经能在工作区里读改跑。这一期把同一个 loop 接到「一般计算机」上：拉网页、点页面、把交付物落盘、卡住时问人。仍然只有一个引擎；工具列表固定，plan mode 用参数判断能不能动，不删工具。

## 范围

已做：

1. `SessionRuntime`：每个会话一份 artifacts + browser，可选 `askUser`
2. `web_fetch`：拉 URL、抽文本；`save=true` 写入 `artifacts/`
3. `browser`：`open` / `snapshot` / `click` / `type` / `screenshot` / `close` / `takeover`。默认 `HtmlDriver`（fetch + 可访问性快照）；测试可注入 driver。Playwright 以后按同样接口接
4. `artifact`：`list` / `save` / `get`。交付物在 `<workspace>/artifacts`（或 `AGENT_ARTIFACTS`），不要求 git
5. `ask_user`：缺凭证、选项、或敏感页交给人。CLI 交互用 readline；无 TTY 时明确失败
6. 权限按 action：plan mode 允许 `web_search` / `web_fetch`（不 save）/ `browser open|snapshot`；拒绝 save、click、type、写文件、shell
7. 登录/验证码/支付页会标 warning，并建议 `browser action=takeover`

不做（以后）：Playwright 实装、云端 VM、完整 Zed ACP、OS 沙箱见 [期 3](phase-3.md)。

## 工具顺序

```text
read grep glob apply_patch shell web_search
web_fetch browser artifact ask_user
skill update_plan task
mcp__...
```

explore 子 agent 只读：`read` `grep` `glob` `skill` `update_plan` `web_search` `web_fetch` `ask_user`。

## 怎么跑

```bash
npm test
npx tsc --noEmit
npm run agent -- -y -p "Open https://example.com and save a summary artifact"
```
