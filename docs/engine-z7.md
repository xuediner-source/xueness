# Z7：Xueness 原生 app-server 与 headless 入口

本文记录 Z7 在 Xueness 中实际适配的协议和命令边界。它描述 Xueness 原生接口，不代表完整实现或兼容 ZCode V4 wire。Windows 回归、source/built runtime、额外 shutdown drain、构建和搬迁 smoke 均已有通过日志；manifest、ZIP 和包哈希审计待最终交付记录。

## app-server 启动和版本协商

`app-server` 由 `remote` 插件提供。先启用该插件，再从项目目录启动：

```sh
bin/xueness plugins enable remote
bin/xueness app-server --workspace-root /path/to/project
```

`--workspace-root` 可重复指定。每个路径必须是已存在的项目目录且不能是卷根。协议 `workspaceIdentity` 固定为第一个参数的 realpath；未传参数时为当前工作目录的 realpath。额外路径仅沿用旧宿主 allowlist，不会使现代协议能跨 root 访问。`--web-runs PATH` 设置服务端拥有的运行目录；`--allow-real-provider` 和 `--no-real-provider` 分别覆盖在线 provider 的宿主开关。服务只通过 stdin/stdout 使用 JSON-RPC 2.0 NDJSON，不监听 TCP/HTTP 端口，也不提供 WebSocket。

连接默认协商旧协议版本 1：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

这个握手返回 `protocolName: "xueness.app-server.v1"`、`protocolVersion: 1`，保留现有 remote manager 所需的方法：`sessions/index`、`command/execute`、`command/query`、`conversation/snapshot`、`conversation/resume`、`session/read` 和 `response/read`。客户端必须在初次 `initialize` 就请求版本 2：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}
```

该连接返回 `xueness.app-server.v2`；版本 2 在版本 1 方法上增加 conversation、controller、workflow 的 `subscribe`/`resync`/`unsubscribe`，以及 `connection/flow`。返回的 `projectionVersion: 1` 单独标识投影形状，不随传输 `protocolVersion` 改号。一个连接初始化后协议版本固定；同版本可重复 initialize，但从 v1 切换到 v2 会被拒绝，客户端需要启动新连接。旧 remote manager 目前按 v1 hello 验证，不能据此推断它会自动协商 v2。

### Modern RPC 请求示例

以下方法都以 initialize 返回的 `workspaceIdentity` 为准。`commandId` 必须在提交时新生成，格式是 `c_<13 位当前 epoch 毫秒>_<32 位小写 UUID hex>`；不要复用过期的固定示例值：

```js
import { randomUUID } from "node:crypto";
const commandId = `c_${Date.now()}_${randomUUID().replaceAll("-", "")}`;
```

将生成值与 initialize 响应中的 workspace identity 代入下面的 JSON-RPC NDJSON 帧。先通过 durable command 创建会话；后续收到 ACK、超时或连接中断后都用同一 ID 查询，不重新提交：

```json
{"jsonrpc":"2.0","id":2,"method":"command/execute","params":{"workspaceIdentity":"<initialize.workspaceIdentity>","sessionId":null,"commandId":"<fresh-commandId-from-above>","type":"create_session","payload":{"task":"Summarize this workspace"}}}
{"jsonrpc":"2.0","id":3,"method":"command/query","params":{"workspaceIdentity":"<initialize.workspaceIdentity>","sessionId":null,"commandId":"<same-commandId>"}}
```

投影订阅需要新建并以 v2 初始化的连接；取创建结果中的 session id 后，发起 subscribe。ACK 返回后再读取对应 `conversation/frame` 初始通知。flow 只暂停或恢复通知投递：

```json
{"jsonrpc":"2.0","id":4,"method":"conversation/subscribe","params":{"workspaceIdentity":"<initialize.workspaceIdentity>","sessionId":"<session-id>"}}
{"jsonrpc":"2.0","id":5,"method":"connection/flow","params":{"workspaceIdentity":"<initialize.workspaceIdentity>","paused":true}}
{"jsonrpc":"2.0","id":6,"method":"connection/flow","params":{"workspaceIdentity":"<initialize.workspaceIdentity>","paused":false}}
```

`<...>` 项由客户端从 hello/command 结果或本次生成值填入；这些行展示请求形状，不是可绕过初始化或 workspace/session 授权的字面常量。

## 方法和授权边界

协议把请求委派给已有 HTTP owner，不另建业务存储或执行权限。它提供会话索引/读取与创建、模型选择、旧 `turn/start` 和取消、带回执的 `command/*`、会话投影与分页、history/file rewind、question 查询与回答、withdrawal 恢复、guidance 控制、media 上传和恢复、composer catalog/prepare，以及 `workflow/*` 脚本运行的完整控制与事件读取。握手中的 `methods` 和 `capabilities` 描述已实现的协议目录；实际调用仍受插件门禁约束，插件禁用或依赖不可用时相应方法会拒绝请求。

现代方法要求精确的 `workspaceIdentity`。需要会话的请求还要求 32 位小写十六进制 `sessionId`，并核对已加载会话的 realpath 与该 identity 相同；remote session 被拒绝。未知顶层字段会被拒绝。payload 中重复携带的 `root`、`sessionId` 或 `session_id` 若与外层授权相同，会被去除并由 owner 按外层范围固定注入；若改变 root/session 归属则拒绝。嵌套 `remote` 路由始终拒绝。接口没有任意 HTTP 路由、provider 密钥读取或任意原始工具调用。stdio 端不具备 HTTP Host/Origin/CSRF 层，信任边界是启动服务的父进程；`remote` 插件关闭后不再接收功能请求并进入关闭流程。

优先用 `command/execute` 和 `command/query` 执行持久写入。command receipt 绑定 command ID 与请求内容，CAS 冲突按原 owner 处理，保留期为 24 小时。若查询结果为 `unknown` 或服务报告结果未知，按相同 command ID 查询状态，不重新提交旧副作用。兼容旧客户端的 `turn/start` 写入仍标记 `legacyWritesIdempotent: false`，不能当作持久幂等命令。

Question、withdrawal、guidance、history 和 media 请求同样委派给各自现存 session/composer owner；大媒体走现有分块上传/恢复事务，限制由 initialize 的 limits 描述。协议没有放宽对应插件、workspace、审批、provider 或文件权限。

动态脚本 CLI 的完整命令和语义见 [Z6 使用说明](engine-z6.md)；`workflow-script amend <run-id> <file> --session <session-id>` 中 `<file>` 是必选位置参数，`start`/`resume` 等待该 run settlement。`check`/`create` 只 parse/验证或保存草稿；start/resume 的 digest 必须对应当前草稿，是否允许真实 provider 还同时受原宿主开关约束。

## stdio 帧、并发和投影订阅

每个 NDJSON 输入帧最多 1 MiB。连接最多同时处理 16 个普通请求，另留 8 个 control 请求名额；`initialize`、`shutdown`、`exit` 是输入屏障。普通 RPC 响应可以乱序返回，但 stdout 写入按顺序等待 Node write callback，避免无界积压。请求 ID 在途重复会被拒绝。超过容量的请求返回 `admitted: false`，不会进入处理。

版本 2 最多创建 16 个订阅，后台以 200 ms 周期检查投影，不调用模型。conversation 投影沿用现有 `logEpoch`/`seq` 与 resume/snapshot fallback；controller 投影只读取当前 workspace 的 session index，可使用空 session scope；workflow 投影按 `afterSeq` 读取 workflow 事件。每帧包含 `subscriptionId` 和 `generation`，显式 resync 会递增 generation，使旧帧不能覆盖恢复结果。订阅请求先返回 JSON-RPC ACK，再经 deferred callback 发送 initial/recovery 帧。`connection/flow` 可暂停和恢复帧投递，不执行模型、不重跑命令。缺口由客户端显式 resync。

允许的大回复使用 `xueness.remote-fragment.v1`。超过 768 KiB 后以 256 KiB chunk 读取；单回复最多 32 MiB，驻留总量最多 64 MiB 或 8 个传输，保留 60 秒。描述符提供 SHA-256，传输绑定 workspace、session 和 chunk index；`controller/frame` 可以使用空 session scope。读取使用 `response/read`。这是传输分块，不是业务重试或自动重放；超出适用方法/容量的结果会被拒绝。

`shutdown`、`exit`、stdin EOF、宿主关闭或 `remote` 被禁用时，server 关闭订阅/分片，停止本进程内已知 turn、command 与动态 workflow，并等待在途工作收口。该命令不提供 detached script worker、跨宿主后台运行或 restart 后自动恢复。既有 JSON DAG 的 detached 语义保持原样。

## headless 单任务 CLI

`headless` 是一个单独的 agent CLI 入口，使用原生 AgentRunner 与既有权限及 provider 选择：

```sh
bin/xueness headless --prompt "检查这个项目" --root . --output-format text
bin/xueness headless --prompt "继续这项工作" --resume <session-id> --output-format json
bin/xueness headless --continue --root . --output-format stream-json
```

`-p` 是 `--prompt` 的短写。新会话必须给 `--root`；`--resume ID` 可选择附加 `--prompt`，也可用 `--root` 验证会话工作区；`--continue --root DIR` 选取该 root 最近更新的非归档会话。`--resume` 与 `--continue` 互斥。`--attach PATH` 可重复使用，但必须同时提供 prompt。

默认 `--output-format text` 只输出本轮最终 assistant 正文；`json` 输出一个 `xueness.headless.v1` result 对象；`stream-json` 输出 NDJSON `init`、`event` 和最终 `result` 记录。进度与状态写入 stderr；`--stream` 可额外在 stderr 输出人类可读事件。完成返回码为 0，未完成或等待用户返回 2，运行错误返回 1。默认 mode 为 `build`，其它 agent/provider/权限选项沿用 CLI 原有参数；headless 不引入权限旁路或新的后台 worker。

## 与 ZCode 的关系和当前不覆盖范围

本阶段以 ZCode v3.15.1 commit `aac4755666d09fdcd70272fcf063c077a639015f` 的 protocol/runtime 行为作为参考，并按 Xueness 现有 HTTP owner、插件门禁和本地授权重做。ZCode V4 的 `wireVersion` 是 3；其 V4 topic frame 使用 `complete`/`fragment` 及校验信息，但承载层仍复用 JSON-RPC。Xueness 的 `xueness.app-server.v1/v2` 方法、投影订阅和 `xueness.remote-fragment.v1` 是本产品接口，未实现 ZCode V4 wire frame；两者不能互换，也不宣称逐项上游兼容。

本阶段不接入 ZCode 账号、遥测、官方 gateway、压缩二进制协议或网络 listener；不开放 browser tab/interactive terminal。它也不把旧 `turn/start` 变为幂等、不承诺外部副作用 exactly-once，不增加跨宿主 worker。

## 当前验证记录

- Windows 相关回归按身份去重：39 项，29 pass、10 项历史 Python oracle skip、0 fail、0 cancel；日志见 [`z7-targeted-windows.log`](../验收资料/验证记录/z7-targeted-windows.log) 与 [`z7-controller-flow-fix-windows.log`](../验收资料/验证记录/z7-controller-flow-fix-windows.log)。typecheck 通过；行数门禁 1001 个 TS 文件、最大 400 行；插件门禁 30 个插件 / 422 个 source files。
- source 与 built 的真实子进程 runtime 各 7 场景、各 5 次 loopback provider 请求全部通过（app-server 中挂起 run 与控制 stop 1 次，headless 4 次），均 0 fail、0 外网或付费模型调用；日志分别为 [`z7-runtime-source-windows.json`](../验收资料/验证记录/z7-runtime-source-windows.json) 和 [`z7-runtime-built-windows.json`](../验收资料/验证记录/z7-runtime-built-windows.json)。
- 构建生成 706 个 JavaScript modules；`test:built` 搬迁空 PATH smoke 通过（static UI、native session/history、plugin catalog、health、unowned-route 404）。另行运行的 EOF 与 remote 禁用时挂起 run drain 场景，source/built 均通过，作为独立验收不并入上面的七场景：EOF 后自然 code 0 收口，重启 query 为 accepted/stopped 且零重放；禁用 remote 后 watchdog 自然 code 0 退出并 drain 在途 run，source/built 分别约 526/545 ms。每种模式两场景合计 2 次 loopback provider 请求，source/built 总计 4 次；成功路径未强杀进程、无残留进程。日志为 [`z7-shutdown-source-windows.json`](../验收资料/验证记录/z7-shutdown-source-windows.json)、[`z7-shutdown-built-windows.json`](../验收资料/验证记录/z7-shutdown-built-windows.json)，脚本为 [`verify-z7-shutdown.mjs`](../tools/verify-z7-shutdown.mjs)。Z6 基线 Web 审计已通过：166 个 `webapp/dist` 文件哈希全部一致、Web 源码零改动、零删除，见 [`z7-baseline-web-audit.json`](../验收资料/验证记录/z7-baseline-web-audit.json)。无新增 package 或第三方依赖。
- Linux/macOS 原生、安装器、Docker、CI 未验证；没有真实/收费模型调用、提交、推送或 publication。
