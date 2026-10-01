# ZCode 上游审查与 Xueness CLI 下一批

核对日期：2026-09-29。用户目标：自用 Agent CLI，参考 ZCode 的设计与功能；先完成可用功能，再拆为类似 DeepSeek Harness 的插件。Web 工作台继续作为辅助入口，既有插件接缝保留。

## 上游版本与范围

- GitHub API 查询 `zai-org/ZCode/commits?per_page=5`，当前 main 最新为 [`29628c9acdb81b703bbd4080c207a0e7ce5e276e`](https://github.com/zai-org/ZCode/commit/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，提交时间 **2026-09-24 06:49:06 UTC**，标题 `feat: update v3.14.3`。README 更新栏写 9 月 23 日；那是文档日期，不是提交日期。查询时未见 9 月 25–29 日的新 main 提交。
- 本地 vendor 的记录基线为 `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`。GitHub [compare](https://github.com/zai-org/ZCode/compare/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f...29628c9acdb81b703bbd4080c207a0e7ce5e276e) 返回 `diverged`、ahead 1 / behind 1，共同祖先 `872ad960de7ec172591f7e1952f7849229f94521`。不能视作可直接快进。
- compare 返回 283 个文件条目；这是从共同祖先到上游 head 的三点比较，**不是本地修改过的 vendor 与 head 的逐文件差异统计**。
- 本次读取了提交记录、差异、源码树、CLI 参数/斜杠命令和工作流控制源码；未运行上游代码、安装依赖或覆盖 vendor。

## v3.14.3 更新及实现启示

以下上游路径均固定在该提交，按事实与后续工作分列：

| 上游变化 | 源码证据（仓库相对路径） | Xueness 状态与行动 |
|---|---|---|
| 运行中调整并发，无需停止工作流 | `apps/zcode-cli/packages/bootstrap/src/app/workflow-run-control.ts`；`dynamic-workflow-run-retune.ts` | 当前没有 DAG/动态工作流引擎。未来需让调度器与执行容量同步调整；不能只改一个显示数字。 |
| 修订/重启复用与运行控制 | `apps/zcode-cli/packages/core/src/tool/handlers/amend-workflow-retune.ts`；`apps/zcode-cli/packages/dynamic-workflow/src/engine/imported-cache.ts` | 需先实现任务依赖、取消、已完成节点复用规则与冲突约束，再谈复用。当前子代理不等于完整工作流。 |
| 大工作流状态更新性能 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-fanout-throttle.ts` | 源码按会话以 250ms 窗口合并进度发布。Xueness 将来增加高频并发进度时再加入合并，保留结束/错误事件。 |
| 降低常驻工具描述与脚本修改的上下文开销 | `apps/zcode-cli/packages/core/src/tool/handlers/create-workflow-description.ts`；`apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/` | 上游把较长写作规则移到按需加载的技能。Xueness 可借鉴按需上下文与脚本文件引用；当前不宣称已实现上游工作流工具。 |
| CLI 增加 `--enable-workflow` | `apps/zcode-cli/packages/cli/src/arguments.ts` | 本批不添加没有执行能力的旗标。 |

上游提交说明还记录工作流界面崩溃、按钮溢出与工具上下文过大修复。本次没有运行上游界面，不把提交说明当作本地复现结论。

## CLI 基础交互对照（并非全部是此次新增）

上游 [README](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/README.md) 描述统一入口：无参数进入 TUI、`--web` 启动 Web。CLI [arguments.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/arguments.ts) 提供 cwd/resume/continue；[slash-commands.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts) 处理帮助、恢复、模型等交互命令。

本批独立实现 Xueness 自己的行式 REPL，不复制上游代码，也不声称具备完整 TUI：

- `bin/xueness` 可从任意 cwd 运行，无需安装；无参数进入 chat。
- `chat [ID]` 支持直接开始会话；第一条有效任务才创建 journal，不重复记录用户首轮。配置错误或立即退出不留下空会话。
- `chat --continue --root DIR` 按 journal 修改时间选该工作区最近未归档会话；跳过损坏 JSON 与软链，不续接其他目录任务。显式 ID 与 root/continue 互斥。
- 恢复聊天默认保留 plan/build；`/mode` 可切换，plan 和 deny list 仍优先于 blanket 授权。
- `/help`、`/status`、`/mode`、`/retry`、`/exit`、`/quit` 本地处理；自定义命令首次输入也能展开并留审计。
- 用户回答工具问题后自动运行，不再要求补发无关消息；等待问题时退出不会误记为答案。
- chat 默认逐次审批；`--non-interactive` 可禁用询问。审批输出统一 stderr，交互式 run 的 stream-json 保持逐行可解析；审批 EOF 拒绝操作。

实现：`xueness/cli.py`、`xueness/core.py` 的可注入审批提示；回归：`tests/test_cli_chat_entry.py`、`tests/test_cli_stream_chat.py`。

## 后续功能顺序与验收

1. **CLI 日常可靠性**：运行中 Ctrl+C 协作式停止/恢复已在第十六批实现；多行与工作区文本附件在第十七批实现；继续补会话选择与管理、模型配置切换，多模态附件另行接入。每项用真实终端覆盖，不以 Web 有按钮替代 CLI 验收。
2. **工具与长任务**：按需技能读取、MCP 连接诊断与远程传输、子任务进度/结果查看、后台命令与取消。已有 stdio、只读子代理和进程内路径锁不视作全部完成。
3. **工作流**：先任务依赖与持久化，再暂停/取消/恢复、完成节点复用、运行中并发调整和上下文优化；必须验证冲突和失败路径。
4. **辅助工作台缺口**：跟随实际运行能力补显示与操作，不提前造未接通的控件；ZCode 派生部分保留许可和对照入口。
5. **功能验收后插件拆分**：按稳定能力边界拆模块与生命周期，类似 DeepSeek Harness 的组织形式；不默认要求其 ABI 或运行时依赖。

这份列表是下一阶段顺序，不是已经完成的清单。真实供应商、完整 TUI、上游工作流和远程 MCP 均不在本批交付中。

## 本批验证记录

- 全量 Python：824 项通过（包含本批最初 11 项入口回归）；之后另加 2 项 launcher/配置错误用例，CLI 定向 35 项全部通过。
- README 更新后 packaging 10 项通过，`git diff --check` 通过。
- 真 PTY 在独立 `/tmp` 工作区完成首轮任务、手工批准、文件回读；切换 plan 后退出，再 `--continue` 恢复同一会话且模式保持。
- 测试最初被沙箱监听端口限制阻断，允许本机回环测试后通过。没有把环境失败计为产品失败，也未跳过 HTTP 回归。
- 不涉及真实供应商调用、前端改动或 Web 部署。
