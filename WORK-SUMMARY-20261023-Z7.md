# Z7 工作摘要：原生 app-server 与 headless 入口

日期：2026-10-23。本文记录本阶段代码范围、边界与目前已核实的验收事实：source/built runtime、额外 shutdown drain、最终构建和搬迁空 PATH smoke 均已有通过日志。归档哈希、大小和文件计数见外部交接说明及 SHA256SUMS.txt。

## 适配范围

- 在 `remote` 插件提供本机 stdio JSON-RPC app-server。默认保留 `xueness.app-server.v1`，并保持旧 remote manager 要求的七个方法；客户端显式请求后可协商 `xueness.app-server.v2`，提供 conversation/controller/workflow projection subscriptions。`projectionVersion: 1` 独立于协议版本。
- RPC 只做受限协议映射，继续调用现有 sessions、files、composer、workflows HTTP owner。持久写入沿用 command ID receipt、24 小时窗口、CAS 和未知结果 query；问题/withdrawal/guidance、媒体事务、历史分页及回退继续使用原 owner。
- session 请求绑定启动时选定的 `workspaceIdentity`，会话 ID 与根路径均精确核对。附加 `--workspace-root` 继续服务旧 host allowlist，但不扩大现代协议 root scope。拒绝远程会话、嵌套路由覆盖、任意路由、密钥读取和原始工具执行。
- stdio NDJSON 采用 1 MiB 帧、16 普通并发和 8 个 control 名额，初始化屏障、回调背压、ACK-before-initial-subscription-frame。协议 v2 提供最多 16 个订阅、200 ms 投影轮询、generation fencing 与显式 resync/flow 控制；观察不会运行模型。
- 允许的较大响应沿用 `xueness.remote-fragment.v1` 分块和 owner/hash/TTL 限制；这只是回复传输，不驱动业务重试。
- 新增 `headless` 单任务 CLI，支持 `--prompt`、`--resume`、`--continue`、`--root`、`--attach` 和 text/json/stream-json 输出，调用现有 AgentRunner、provider 及权限边界。

## 参考和不覆盖范围

行为参考是 ZCode v3.15.1 commit `aac4755666d09fdcd70272fcf063c077a639015f`。Xueness 使用原生 v1/v2 JSON-RPC 适配，不声称 ZCode V4 wire 兼容。ZCode V4 `wireVersion=3` 是自定义 topic-frame 层，并由 JSON-RPC 承载；Xueness 没有实现其 `complete`/`fragment` wire frame。未接入账号、遥测、官方 gateway、压缩 binary 或网络 listener。浏览器标签和交互终端能力仍为 false；legacy `turn/start` 仍非幂等。

## 验收状态

| 项目 | 当前记录 |
| --- | --- |
| 相关回归 | 按测试身份去重 39 项：29 pass、10 项退役 Python oracle 历史 skip、0 fail、0 cancel；[主回归日志](验收资料/验证记录/z7-targeted-windows.log)、[controller flow 修正日志](验收资料/验证记录/z7-controller-flow-fix-windows.log) |
| 类型/插件/行数门禁 | typecheck 通过；30 插件 / 422 source files；1001 TS 文件 / 最大 400 行 |
| source runtime | 真实子进程 7 场景全过、5 次 loopback provider 请求（app-server 挂起 run + control stop 1，headless 4），0 fail、无外网或收费模型调用；[日志](验收资料/验证记录/z7-runtime-source-windows.json) |
| build/built runtime/relocation | build 706 JS modules；`test:built` 搬迁空 PATH smoke 通过；built runtime 同样 7 场景、5 次 loopback provider 请求全过、0 fail；[日志](验收资料/验证记录/z7-build-windows.log)、[built runtime](验收资料/验证记录/z7-runtime-built-windows.json) |
| extra shutdown drain | source/built 各自覆盖 EOF 与 remote 插件禁用两场景，均通过；EOF 后进程自然 code 0 收口，query 为 accepted/stopped 且 0 重放；禁用 remote 后 watchdog 自然退出 code 0 并 drain 在途 run。source/built 分别约 526/545 ms；每种模式各 2 次 loopback provider 请求，source/built 合计 4 次，单独记录、不与上面的七场景相加；成功路径未强杀进程、无残留进程；[source](验收资料/验证记录/z7-shutdown-source-windows.json)、[built](验收资料/验证记录/z7-shutdown-built-windows.json)、[验证脚本](tools/verify-z7-shutdown.mjs) |
| ZIP/patch、manifest、hash、文件计数 | 见外部 Z7 交接说明、SHA256SUMS.txt 与项目清单 |
| Linux/macOS 原生、安装器、Docker、CI | 未作已验收声明 |
| 真实/收费模型、提交、推送、publication | 未作已执行声明 |

Z6 基线 Web 审计已通过：166 个 `webapp/dist` 文件哈希全部一致、Web 源码零改动、零删除，详见 [审计日志](验收资料/验证记录/z7-baseline-web-audit.json)。无新增 package 或第三方依赖。完整协议及 CLI 使用见 [Z7 说明](docs/engine-z7.md)。运行时验收已完成；manifest、ZIP 与归档哈希见外部 Z7 交接说明。
