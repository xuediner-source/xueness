# Xueness 0.1.8 · Z6 阶段工作总结

Z6 在既有 JSON DAG 与 Python 式 DSL 旁新增原生 TypeScript AST 子集，并接入 workflow 插件的动态运行、持久化、HTTP、工具、CLI 与 TUI。阶段边界是有意适配范围，不表示完整 TypeScript 或完整 ZCode 上游兼容。详细行为、接口和保留范围见 [Z6 使用说明](docs/engine-z6.md)。

**实现范围**

- 共享纯 compiler/schema/interpreter 放在 `ts/packages/agent/src/script/`，TypeScript 5.9.3 为 agent 包的运行依赖；workflow 插件没有外部依赖，构建 allowlist 不变。
- compiler 只解析语法并检查受限静态子集，不做完整 `ts.Program` 检查，不 `eval`/`vm` 执行任意 JS。脚本上限 32,000 字符，解释器默认 100,000 次操作并定期 yield 支持取消。
- 支持变量、分支/循环、纯 JSON 值与模板、白名单方法/`Promise.all`、typed actor ask、受限文件读取/glob、阶段、日志、report 与 hole；schema 子集含继承/别名/可选对象/数组/union/Record，并补齐通用 validator 的 `anyOf` 与 `additionalProperties`。
- workflows 持有 JSON 运行日志、缓存/调度、运行恢复、actor 问题和 HTTP/工具/CLI 行为；同 actor FIFO，跨 actor 1–8 并发可即时调整。start 要求确认 digest，写入权限受 parent ceiling 限制，默认只读；真实模型还需 `allowReal` 和原宿主开关。owner 精确绑定 parent session/root，拒绝 remote session。
- typed actor 复用 AgentRunner JSON final 与最多两次 repair；run 内多次 ask 使用 actor transcript。插件当前工具与权限继续沿用既有模型、文件、shell、planning、office、network 权限，没有 MCP/hooks 旁路。
- 只读 amend 用新 run ID，要求 workspace fingerprint 与 node input hash 相同才缓存导入 ask/read 结果；需要 live ask 时用新 session，不搬运旧 transcript。普通 resume 保留原 actor session，未完成 actor journal 只在显式 resume 时继续；不保证外部副作用 exactly-once。
- TUI 已将 script run 接入现有 workflow 卡片/侧栏，watcher 识别 dynamic-workflows，composer data 登记八个脚本工具。Web 源码与 166 个 dist 文件保持原样。

**验证记录**

Windows / Node 24.19。最终相关回归按身份去重为 84 项，83 pass、1 项因已退役 Python 后端缺失而历史 skip、0 未解决失败。此前动态 workflow 相关 79 项均通过；最终 TUI 接线新增 2 文件 5 项，其中 4 pass、1 历史 Python skip。修复后的重复定向运行不另计为新增用例。

类型检查、行数门禁（988 个 TS 文件、最多 400 行）、插件门禁（30 个插件、416 个源文件）、构建（698 个 JS 模块）及搬迁空 PATH 启动检查通过。source 与 built 版的 ApplicationApi/FrontDoor 验收各覆盖 4 场景、7 次 loopback 请求，均 0 失败；覆盖草稿零执行、digest/owner、typed repair/loop/fanout/world read、hole/resume 零重放、唯一 report、amend 缓存零 dispatch、cancel/host.close 取消和插件禁用。

日志位于 `验收资料/验证记录/z6-*`。Linux/macOS 原生、安装器、Docker、CI 未验证；未使用真实/付费模型，未提交、推送或发布。未支持的上游能力包括 import、Node globals、任意函数/类、完整 TS 生态、`world.run`、引用库全部图/流式 artifact/dashboard 能力和 VM harness。这里的“适配范围完成”不表示逐项兼容。

本阶段从 Z5 ZIP `Xueness-0.1.8-Z5-20261023.zip` 继续，基线 SHA-256 为 `0d221c0c3c404e54cb3af84aaef30bcb480007329c30c4d210af49b2e0a895c9`。更新的完整包及相对该基线的零删除补丁见 [PATCH-Z6.md](PATCH-Z6.md)。Z6 适配范围已完成；按用户要求下一阶段直接进入 Z7，Z7/Z8 两阶段早期估算合计约 5–7 个内部工作块，整个引擎尚未完成。
