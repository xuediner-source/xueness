# Z6 原生 TypeScript 动态工作流

本阶段在现有声明式 JSON DAG 和 Python 式 DSL 旁新增原生 TypeScript AST 子集，沿用 `workflows` 插件提供持久化、运行控制、API、工具与 CLI。范围是 Xueness 的有意适配，不代表完整支持 ZCode dynamic-workflow 或完整 TypeScript。

## 脚本子集

脚本源最多 32,000 个字符。共享纯编译器、schema 校验和解释器位于 `ts/packages/agent/src/script/`；workflow 插件本身不增加外部依赖。生产依赖 TypeScript 5.9.3 位于 `@xueness/agent`，用来解析 AST 并生成诊断。编译阶段只解析语法并检查支持的静态子集，不使用 `ts.Program` 做完整类型检查，也不通过 `eval`、`vm` 或任意 JavaScript 执行源代码。

支持变量、条件、`for`/`for...of`/`while`、`break`/`continue`，纯 JSON 数组和对象、属性读取、模板字符串、白名单值方法、`Promise.all`，以及 `agent(name, persona).ask<T>`。可用的工作流能力包括 `files.read`、`files.glob`、阶段状态、日志、报告和人工 hole。schema 子集支持 interface 继承、别名、object/可选属性、array、union 和 `Record`；通用 validator 增加 `anyOf` 与 `additionalProperties` 支持。

不支持 import、Node 全局变量、任意函数或类、完整 TypeScript 生态、`world.run`、对引用库所有图形/流式 artifact/dashboard 能力的兼容，也不包括 VM harness。不要把本实现描述为逐项照搬上游。

## 运行与权限

workflow 插件的 `dynamic-store`、`engine`、`service`、HTTP 和工具模块持有 JSON 日志与动态运行行为。调度按 site-kind ordinal 与 input hash 缓存节点；同 actor FIFO，actor 之间并发数可在 1–8 即时调整。节点结果和 report 唯一保存，hole 与 actor 问题显式等待，recover/resume 需要操作者明确调用。默认最大 100,000 次解释器操作，并定期 yield，使取消能够及时生效。

编译与草稿创建不执行脚本。start 要求确认当前 digest，digest 绑定 root、sourceHash、writable 和 maxConcurrency；写入权限受 parent plan ceiling 限制，默认只读。真实模型调用还需要显式 `allowReal` 和原宿主的 real-provider 开关。owner 必须是精确的 parent session/root 授权；远程 session 会被拒绝。

Typed actor 使用现有 AgentRunner，接收 JSON final 并最多进行两次 repair；它不使用 `submit_result` 工具。一个 run 内多次 ask 保留 actor transcript。实际保存的 provider、文件、shell、planning、office 和 network 工具继续受原有权限约束，没有添加 MCP/hooks 的 actor 授权旁路。

普通 resume 延续原 actor session。只读 amend 创建新 run ID；只有 workspace fingerprint 完全一致且节点 input hash 相同时才导入 ask/read 结果。若需要 live ask，则在新 run 的新 session 执行，不复制旧 transcript。显式 resume 可以继续已开始但未完成的 actor journal；对外部副作用不承诺 exactly-once。HTTP 服务关闭时取消并 drain 它持有的动态运行；没有新增 detached worker 或跨宿主后台恢复保证。旧 DAG 的 detached 行为维持原样。

每条显式文本 log 最多 2,000 字符；events 保存最近 1,000 项并使用单调 seq。report 和节点结果分别持久化。这是工作流本地日志，不是原始模型 I/O 遥测。

## HTTP、工具与 CLI

在现有 `ApplicationApi` 下提供以下会话路由：

- `GET /api/sessions/:sid/workflow-scripts` 列出脚本运行；`POST` 创建草稿；`POST /compile` 只编译、不执行。
- `GET /api/sessions/:sid/workflow-scripts/:runId` 读取 run；`GET .../:runId/events?afterSeq=<n>` 按序号读取事件。
- `POST .../:runId/start` 和 `/resume` 接受 `{ "digest": "…", "confirmed": true, "allowReal": true }`。实时模型的额外宿主开关仍需开启。
- 另有 `/cancel`、`/concurrency`（`{ "maxConcurrency": n }`）、`/resolve`（`{ "nodeId": "…", "answer": ... }`）、`/amend`（`{ "source": "…" }`）和 `/recover`。

八个 workflow 工具为 `workflow_script_create`、`workflow_script_run`、`workflow_script_status`、`workflow_script_list`、`workflow_script_cancel`、`workflow_script_concurrency`、`workflow_script_resolve`、`workflow_script_amend`。它们使用现有 actor 上下文与工具授权。

CLI 为 `workflow-script` 子命令：

```text
workflow-script check <file> --session <id>
workflow-script create <file> --session <id> [--name <name>] [--concurrency <n>] [--writable]
workflow-script list --session <id>
workflow-script show <id> --session <id>
workflow-script start <id> --session <id> --digest <digest> [--approve] [--allow-real]
workflow-script resume <id> --session <id> --digest <digest> [--approve] [--allow-real]
workflow-script cancel <id> --session <id>
workflow-script recover <id> --session <id>
workflow-script concurrency <id> --session <id> <limit>
workflow-script resolve <id> --session <id> <node> <JSON-answer>
workflow-script amend <id> --session <id> <file>
```

CLI start/resume 等待本次 run 结算后再返回。动态 script 功能和工具归 workflows；workflow 插件依赖 allowlist 没有变化，原 JSON DAG 与 DSL 继续可用。

## 界面与验证

TUI 已将 script run 合入现有 workflow 卡片和侧栏；state watcher 识别 `dynamic-workflows` 状态，composer data 提供八个脚本工具。Web 源码和随包 166 个 `webapp/dist` 文件不变，没有重建前端。

Windows / Node 24.19。最终相关回归按身份去重为 84 项：83 pass、1 项退役 Python 对照历史 skip、0 未解决失败。既有 script/runtime 组合 79 项全部通过；TUI 新增两文件 5 项，4 pass、1 历史 Python skip。重复补跑不重复累计。类型、行数门禁（988 个 TS 文件，最大 400 行）、插件门禁（30 个插件 / 416 个源文件）、698 个 JS 模块构建及搬迁后的空 PATH 运行检查通过。

实际 ApplicationApi/FrontDoor source 与 built 验收各覆盖 4 个场景和 7 次 loopback 请求，均 0 失败：compile/draft 不执行、digest 与 owner 校验、typed repair/loop/fanout/world read/hole-resume 且不重放、唯一 report、amend 缓存命中时零 dispatch，以及 POST cancel 和 `host.close` 对在途请求取消且无重放、插件禁用门禁。

Linux/macOS 原生、安装器、Docker 和 CI 未验证。没有真实/付费模型调用、真实 commit、push 或 publication。完整 Z6 范围与验证摘要见 [工作总结](../WORK-SUMMARY-20261023-Z6.md)；补丁基线和应用方式见 [PATCH-Z6.md](../PATCH-Z6.md)。
