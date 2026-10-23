# Xueness TypeScript 迁移交接（2026-10-18）

## 1. 本次范围

接续 M4.2a，补齐存储、修订日志和跨进程锁的真实 Python 对照；实现 M4.2b agent 循环、压缩、完成记录及 provider/工具桥接线；迁移 M4.3 会话、媒体和 provider HTTP；修复 Python 数值修订链问题；补上 JS 编译与桌面分发接线。

TS 前门现在实际执行已迁移的请求。保留的 Python 进程承接尚未迁移的插件和跨插件准备服务。**本包不是“已完全删除 Python”的版本**；下一阶段逐项退役的边界见第 5 节。

## 2. 运行与验收

要求 Node 24.11+。源码差分验收使用 Python 3.11+；Windows 建议明确选择解释器：

```powershell
cd ts
npm.cmd install
$env:XUENESS_PYTHON = (py -3.11 -c "import sys; print(sys.executable)").Trim()
npm.cmd run check
npm.cmd run build
npm.cmd run test:built
npm.cmd run serve
```

- `npm run check`：400 行上限、插件结构与能力门禁、严格类型检查、全部 TS 测试（包括真实 Python 对照）。
- `npm run test:sessions`：存储、修订日志、锁和会话基础投影。
- `npm run test:fast`：明确跳过 Python 对照；不能替代完整验收。
- `npm run build`：产出 `ts/dist/`，包含编译 JS、生产依赖、插件 manifest、Python 插件目录数据和本机 Node 运行时及许可证。
- `npm run test:built`：把产物复制到新的位置，在空 PATH 下使用随包 Node 启动，验证模块路径、静态 UI、原生会话读写和 Python 互读。
- `npm run test:packaged`：检查 Windows 打包目录中的随包 Node、冻结 Python、TS 生产依赖、桌面请求保护和原生会话/附件请求。
- `npm run serve:built`：使用编译产物启动。仍需完整工程中的 Python 后端。
- Python：`py -3.11 tools/check_plugin_architecture.py`、`py -3.11 -m unittest tests.test_plugin_architecture -q`、`py -3.11 -m unittest discover -s tests -v`。
- 桌面：`npm --prefix desktop test`。新安装包构建见 `docs/xueness-desktop.md`，`dist:win` / `dist:mac` 已包含 TS 构建步骤。

## 3. 已实现的迁移

### M4.2a：存储与锁

- 双向、逐字节会话读写；修订链相互校验和续写；无变化保存、撕裂发布恢复、损坏链、分页、错误阶段及并发更新对照。
- 默认使用 `NativeFileLocks`，不再启动 Python 锁代理。Windows 使用句柄相对打开、拒绝 reparse point 和 `LockFileEx`；POSIX 使用相对打开及 flock。与现有 Python 锁协议互斥。
- Windows 会话文件、备份、修订日志与私有目录收紧 DACL。原生锁进程被终止后由操作系统释放。
- `PythonFlockBroker` 仅保留为显式兼容/测试适配器，普通运行不依赖它。
- Python 的 `1/1.0`、`True/1`、`0.0/-0.0` 修订比较已改为按规范 JSON 编码比较，避免未记操作却写入新校验值导致永久无法续写。

### M4.2b：实际 agent 链路

- AgentRunner 接上 SessionStore、真实 provider 适配器、PluginHost、权限策略和 ToolBridge。
- 工具调用、单次批准与重放、取消后的部分输出、工作时段、队列续跑、steering、完成记录、模型切换和压缩进入同一生产链路。
- 标准与 lightweight 运行、语义压缩、provider 活动记录、工作区指令、交付计划与文件检查采用插件扩展；每项受实际插件开关约束。
- 目标验证使用独立且有界的模型调用；未完成时的继续执行先于普通排队消息。自动标题、结构化问题与回答、todo 工具、交付检查和运行中模型切换均接入实际 HTTP 链路。
- Git 检查点在通过权限门之后、实际写入之前建立；拒绝的调用不产生检查点，同一轮只记录一次。
- 接入退出清理：中断活动请求，等待任务结束，销毁工具环境和插件作用域。

### M4.3：HTTP 与媒体

- providers：配置 CRUD、默认选择、连接诊断、模型发现、兼容性诊断与结果采用；真实 Python HTTP 和发往本地模拟服务的请求对照。
- sessions：创建/读取/列表/重命名/固定/归档/恢复/永久删除、导入导出、历史/修订/事件、运行/停止/答复/审批、命令回执、队列/steering、消息编辑与反馈、分叉和检查点关联、搜索索引和分享导入/撤销。
- conversation：完整/窗口快照、引用与子任务投影、旧事件与恢复协议、实时 delta/update 流。前门支持逐段发送、背压和客户端断开取消。
- media：私有索引/二进制、所有者绑定与配额、稳定命令的接纳回执、消息/队列/分叉所有权和 provider pin。
- composer attachments：上传、分块续传、精确重试、提交、预览、释放、消息附件恢复、恢复回执/取消/epoch。Python 和 TS 可交替完成同一次持久上传。
- 工作区授权、桌面令牌、Host/Origin/CSRF、请求体长度/时限仍由相同边界约束；插件启用不等于写入授权。
- 精确路由表和条件回退见 [M4-HTTP-COVERAGE.md](M4-HTTP-COVERAGE.md)：79 个会话相关路由签名、9 个 provider 路由签名。

### M5 接线

- `desktop/src/front-door.cjs` 默认启用 TS 前门；`XUENESS_DESKTOP_FRONT_DOOR=0` 可显式回退。
- 安装包使用 `resources/backend-ts/runtime/node.exe` 与编译后的 JS，不依赖用户 PATH 的 Node。
- Windows npm 工作区绝对 junction 在构建阶段转换成包内副本，保证迁移位置后能运行。
- 原版 `Windows/` 两个 0.1.8 交付物未修改；新构建输出另放，不覆盖原包。

## 4. 代码地图

| 路径 | 职责 |
| --- | --- |
| `packages/contracts` | 协议、错误信封、无损 Python JSON/数值兼容 |
| `packages/sessions` | 会话、修订链、原生锁、私有权限和安全文件读取 |
| `packages/agent` | agent 循环、压缩、完成记录、扩展契约 |
| `packages/providers` | OpenAI/Anthropic、HTTP/SSE/重试/截止时间、多模态 |
| `packages/tool-bridge`、`permissions`、`engine-tools` | 工具执行、审批、权限、内置工具基础设施 |
| `plugins/files`、`shell` | 文件、工作区指令、命令与后台任务 |
| `plugins/providers` | provider HTTP、lightweight/语义压缩/活动扩展 |
| `plugins/sessions` | 会话 HTTP、队列/steering、媒体、附件事务与恢复 |
| `plugins/planning` | 目标验证与续跑、todo/提问工具、交付计划和完成检查 |
| `plugins/git` | 检查点、受保护的恢复和轮次检查点 |
| `apps/server/src/application-api.ts` | 各插件 API 组装，不持有业务实现 |
| `apps/server/src/agent-service.ts` | 会话绑定的生产 agent/插件生命周期 |
| `apps/server/src/python-feature-bridge.ts` | 保留 Python 功能的明确内部交接 |
| `scripts/build.ts`、`smoke-built.ts`、`smoke-packaged.ts` | JS/运行时打包、异地启动和实际分发目录验证 |

## 5. Python 退役边界

本次替换了锁代理这一已知退役前置依赖，但没有删除尚未迁移的产品插件：

- composer（`GET /api/composer`、`/prepare`、`/branch`）和命令（`/api/resources/commands*`、`/命令` 展开）自第 7 步第 2 轮起由 TS 处理（见第 25 节）。只有 remote 或 subscriptions 插件生效时，目录与准备仍转发 Python，草稿也存在 Python 缓存里；这时内部桥的 prepared 消费只在 TS 缓存未命中后才用。内部桥不再提供命令展开。
- 设置与工作区（`/api/settings*`、`/api/workspaces*`）自第 7 步第 1 轮起由 TS 插件 `plugins/settings` 原生处理，不再转发 Python（见第 24 节）。桌面模式的原生文件夹选择仍走 `/api/workspaces`，Windows 上 Python 本身返回 501，本轮没有另做选择器。`settings`/`settings-set` 和 onboarding 的 CLI 向导留到第 9 轮。`/api/onboarding/desktop` 以及 usage、model_monitor、diagnostics、tools 的 call-budget、terminals、长度 3 的 updates、desktop 已实现的 status/tray/permissions/host-capability 自第 7 步第 5 轮起由 TS 回答（见第 28 节）。`/api/workflows`、`/api/automations`、`/api/automation/offpeak` 自第 7 步第 7 轮起由 TS 回答，运行由 TS worker 驱动（见第 30 节）。
- subscriptions 的外部账户配置和订阅 provider 仍由其原插件处理；普通保存的 OpenAI/Anthropic 配置走 TS。
- 已配置的 MCP、hooks、subagents、browser、remote、memory/skills、Office 文档检查等能力，在原生支持不足时，于变更会话/接纳回执之前转交 Python。MCP 自第 5 步第 1 轮起由 TS 插件 `plugins/mcp` 原生执行。OAuth、`elicitation: true` 和一份可读的插件清单自第 7 步第 4 轮起也由 TS 执行（见第 27 节）。清单读不出来或只读到一半、目录里的 resources/prompts，以及远程会话仍转交 Python。技能（`skills.context`）自第 2 轮起由 TS 插件 `plugins/skills` 原生执行，不再因技能目录或 `skill_catalog` 回退（见第 17 节）；composer 的 `/命令` 展开仍走 Python 桥。hooks（`hooks.commands`）自第 3 轮起由 TS 插件 `plugins/hooks` 原生执行，资源 hooks 和已开启的工作区 hooks 都不再回退（见第 18 节）；hooks 设置、信任授权 HTTP 和 CLI 仍是 Python。子代理（`subagents.tasks`）自第 4 轮起由 TS 插件 `plugins/subagents` 原生执行：请求带 `allow_subagents` 不再回退，前台只读子运行（见第 19 节）。第 7 步第 4 轮补了 `sessions/*/tasks` 和进程内协调器（见第 27 节），但宿主仍不声明 `subagents.coordination`，前台 `task` 仍是默认。会话里还有未收集的后台任务（`subagent_coordination` 中 `collected` 不为真）时，整轮仍交给 Python。记忆（`memory.context`）自第 5 轮起由 TS 插件 `plugins/memory` 原生注入：配了 `XUENESS_MEMORY_ROOT` 不再回退（见第 20 节）；`/api/memory` 编辑器和工作区列表仍是 Python HTTP。
- 如果另一个 Python 进程正持有会话运行租约，请求交还该运行所有者，避免两个执行器同时修改会话。
- 插件配置或能力不明确时拒绝原生执行/回退，不能靠忽略功能字段来“完成迁移”。

后续逐个插件移植并对照，再取消对应 capability 回退。只有这些 owner 全部替换后，才能删去 Python 启动器、内部桥及冻结运行时；不能仅删除目录或移除回退判断。

## 6. 已知差异和环境边界

- 整数样式对象键的遍历顺序、极少数孤立代理字符、Python 版本间的异常类和有限数值编码边界仍见 README；会话持久化使用无损解码。
- TS 与 Python 的工具权限 subject 规范化仍有历史差异，不跨执行器复用未经匹配的临时批准。
- 损坏的附件回执如果为 JSON `null`，TS 明确返回 409 并停止处理；这是有意收紧的错误处理，不沿用 Python 的含糊行为。
- 原生插件和宿主同进程；能力门禁与权限策略不是操作系统沙箱。
- Windows 验收不代表 Linux/macOS 原生运行验收。依赖 POSIX 信号/文件权限或 macOS 窗口行为的跳过项需在相应平台执行。
- 未使用付费模型验收；实际 agent HTTP 测试连接隔离的本地脚本化 provider。不得把这些测试解释为模型质量或性能测量。
- 未提交、推送、签名或对外发布。Notion 副本未自动改写；本地文档为本次交付依据。

## 7. 验收与交付记录

2026-10-18，在 Windows x64、Node 24.19.0、Python 3.11 环境完成：

| 验收 | 结果 |
| --- | --- |
| `npm run check` | 516 项测试，511 通过、5 跳过、0 失败；99 个 suite；类型、400 行上限与插件门禁通过 |
| Python 完整测试 | 3432 项，3324 通过、108 跳过、0 失败 |
| Python 插件架构与打包检查 | 架构脚本通过；36 项单元测试全部通过 |
| 桌面单元测试 | 119 项，113 通过、6 跳过、0 失败 |
| 冻结 Python 后端 | 246 项，225 通过、21 跳过；实际工具、HTTP、ConPTY、工作流、时区与退出检查通过 |
| JS 构建与异地启动 | 256 个编译模块；空 PATH 下随包 Node 启动、会话/修订链/锁及 Python 互读通过 |
| 最终 Windows 分发目录 | 使用随包 Node 与冻结 Python，5 次会话/历史/附件请求成功且代理计数增量为 0 |
| 最终 Electron 应用 | 30 个插件、254 项功能；工作台、两种配色的浅深主题、原生标题栏、浏览器驱动及退出检查通过 |

验收日志、报告及截图在 [`验收资料/TS迁移/`](../验收资料/TS迁移/)。原目录中的旧 HTML 报告是输入包历史记录，本节与新证据目录才对应本次改动。TS 测试使用 Git 附带的 OpenSSL 运行 TLS 对照；平台相关跳过项没有计入通过数。

交付目录 `deliverables/` 与解压后的工程目录同级，包含：

- `xueness-complete-ts-m4-2026-10-18.zip`：**完整工程**，包括 Python、TS、webapp、desktop、docs、验收资料和原版 `Windows/` 两个交付物。排除 `node_modules`、Python 缓存、临时日志及本次生成的 `ts/dist`、`desktop/.build`、`desktop/runtime`、`desktop/release`；解压后按第 2 节安装依赖。
- `Xueness-0.1.8-ts-migration-2026-10-18-windows-x64-setup.exe`：本次生成的 Windows 安装程序，未签名。
- `Xueness-0.1.8-ts-migration-2026-10-18-windows-x64-portable.zip`：本次生成的完整 Windows 便携版；解压整个目录后运行 `Xueness.exe`。
- `xueness-ts-runtime-windows-x64-2026-10-18.zip`：编译 JS、生产依赖及 Node 的**组件包**，不包含冻结 Python 和 Web UI，需配合完整工程或相应后端使用；直接运行桌面程序请选择上面的安装版/便携版。
- `SHA256SUMS.txt`、`delivery-manifest.json`：四个交付物的大小、SHA-256 和验证摘要。完整源码包自身的文件清单为 `complete-project-manifest.json`，原清单保存在 `验收资料/原始清单/`。

原版 Windows 交付物的哈希与输入包原清单一致：

- 便携 ZIP：`cf97e366b9b95cbc7c517fd6c06194af1de62379e182974e51a80b937dc46825`
- 安装程序：`7bbdc3267eb312c9244e70d99547900cf8ceb5bbb3c939d6f7b5a2e0f9da6200`

新的 Windows 分发默认启用 TS 前门；Python 仍按第 5 节保留明确的功能归属。Mac/Linux 安装包未在此 Windows 环境构建或宣称验收。

## 8. ZCode 对齐：完成判定（2026-10-18）

Python 与 TS 同步修改，差分测试继续逐字段对照两边结果。

- **暂停原因修正**：TS 工具桥的「等待批准」「权限拒绝」「计划模式拒绝」结果补上 `user_reason`，与 Python `permission_result` 一致；驱动器按暂停代码选文字（`haltReason` / `_halt_reason`）。此前 TS 在等待批准时会显示「证据引用修复失败，未再次执行工具。」。
- **移除证据引用修复轮**：引用无效时不再追加「只改引用、不要调用工具」的请求，也不再因为修复轮里调用了工具而停到 `needs_review`。旧会话残留的 `completion_reference_repair` 状态在下次运行时清除。
- **验证只是提示**：模型不再调用工具，这一轮就结束（`completed`）。证据缺失、引用无效、工具失败只体现在 `completion.status = unverified` 和 `error_code`，界面的完成检查徽标照常显示。只有主机交付检查失败（`delivery_status = failed`）才会给出 `needs_review`；工具硬停止（插件关闭、Python 权限拒绝等）仍按原因暂停或进入复核。
- **保留不变**：系统提示里的可选 `Evidence: E1, E2` 说明；目标模式的独立核验仍是 fail-closed（核验失败时目标转为受阻，会话本身照常完成），ZCode 在这里是 fail-open。

## 9. ZCode 对齐：代理循环（只改 TS，2026-10-18）

从本节起只改 TS（`ts/` 与 `webapp/`），Python 冻结：Python 仍按旧规则运行它接管的会话（TS 缺原生能力时经 `python-feature-bridge` 回退），第 8 节对 Python 的修正保留。与新语义冲突的差分用例改为 TS 独立断言（`packages/agent/test/zcode-loop.test.ts`，以及 `plugins/planning/test/goal-driver.test.ts`、`plugins/sessions/test/prepared-input.test.ts` 中的 fail-open / 默认预算分支），其余用例继续逐字段对照真实 Python。

对照 ZCode v3.15.1（`aac4755`）`apps/zcode-cli/packages/core/src/runtime`：

- **没有默认步数和时限**（`methods/turn-loop.ts`）：`maxSteps`、`maxWallSeconds` 默认不限。模型不再调用工具、用户停止或调用方给了显式上限，这一轮才结束。显式 `steps`（HTTP 1..20）、`max_wall_seconds`、轻量档 `stepLimit` / `wallTimeSeconds` 仍然生效，到限时照旧以 `step_limit_reached` / `wall_time_limit_reached` 暂停。不设期限时不建 `AbortSignal.timeout`，也不给适配器设整体 `requestDeadline`；流式空闲超时不变。
- **重复调用只提醒**（`helpers/model-anomaly.ts`）：同名同参数（参数按稳定 JSON 比较）连续出现第 3 次时，在下一次请求的系统提示后追加 ZCode 原文提醒，每轮最多 3 次。不再写 `not executed: repeated tool call`，也不再进入 `stalled`。新的用户消息（含插话）会重置计数。
- **输出截断自动续写**（`methods/turn-output-token-continuation.ts`）：`finish_reason = length`，或原始原因为 `max_tokens` / `max_output_tokens` / `model_context_window_exceeded`，并且没有工具调用时，先保留已生成的正文，再追加一条只在本轮请求里出现、不写入会话的续写提示（ZCode 原文），最多 3 次。第 4 次仍被截断，才按原来的“生成未完成”暂停。被截断但带工具调用的响应照常执行工具；参数不完整的调用会得到 `invalid tool arguments`。
- **工具失败交还模型**（`tool/executor/turn-control.ts`）：只有等待批准会挂起本轮。插件关闭（`plugin_disabled`）、`retryable: false` 等失败都作为普通工具结果交给模型，本轮继续。批准仍是先暂停、批准后继续；像 ZCode 那样在进程内等待批准，留到下一阶段。
- **目标核验 fail-open**（`contracts/src/tools/target.ts` 的 `failOpenGoalCompletionVerification`）：核验请求失败或输出不合规时，目标视为完成（`verification.kind = fail_open`，原因写入 `runtime.reason`），不再转为 `blocked`。用户停止仍为暂停；外层时限已到仍为 `budget_limited`。目标预算默认不限轮次和用时，显式的 `maxRounds` / `maxWallSeconds` / `maxTokens` 照旧生效，“连续两轮没有进展”的保护保留。前端目标运行不再附带 `steps: 20`。
- 以上两点取代第 8 节在 TS 侧的保留项：插件关闭不再暂停或复核，目标核验不再 fail-closed。
- 移植来源已记入 `NOTICE.md`；共用逻辑在 `packages/agent/src/loop-guards.ts`。
- 验证：`npm run check` 通过（行数门禁、插件门禁、类型检查；546 项测试，545 通过、1 跳过、0 失败，其中新增 7 项 ZCode 循环用例）。webapp 的两处断言已同步，但本环境没有安装 webapp 依赖，未运行 webapp 测试；Python 未改动，未重跑。

## 10. 完全对齐 ZCode 的路线图（2026-10-18）

第 8、9 节已完成；主线还剩 7 步，另有 2 项可选，粗估共 12–14 轮（1 轮约等于第 9 节的工作量）。每步的 ZCode 来源、现状、要做的事、完成标准，以及待决定的事项，见 [docs/zcode-alignment-roadmap.md](docs/zcode-alignment-roadmap.md)。

| # | 步骤 | 粗估 |
| --- | --- | --- |
| 1 | 权限与批准流（已完成，见第 11 节） | 1 轮 |
| 2 | 提示词、上下文与插话 | 1 轮 |
| 3 | 补齐核心工具（第 1 轮已完成，见第 13 节） | 2 轮 |
| 4 | 上下文压缩 | 1 轮 |
| 5 | 扩展能力迁到 TS（MCP、技能/命令、hooks、子代理、记忆） | 3–4 轮 |
| 6 | 文档与浏览器插件 | 2–3 轮 |
| 7 | 退役 Python，收尾前端 | 2 轮 |

此表是 2026-10-18 的原始估计。之后的进度和重估以路线图第 1 节为准：第 7 步已拆成 10 轮，第 1 轮见第 24 节。

可选：动态工作流（约 2 轮）、平台插件（CUA、Android/iOS 模拟器，不建议）。不对齐：遥测、Z.AI 账号/云服务/错峰、品牌。本节只新增文档，代码未改动。

## 11. ZCode 对齐第 1 步：权限与批准流（只改 TS，2026-10-19）

对照 ZCode v3.15.1（`aac4755`）。分两路开发后合入 main：路 B「权限策略」由 Grok 辅助编写，主代理审核修正；路 A「进程内等待批准 + 前端卡片」由主代理编写。Python 未改动。

**批准在进程内等待**（`packages/tool-bridge/src/approval-waits.ts`、`bridge.ts`、`packages/agent/src/tools.ts`、`apps/server/src/agent-service.ts`、`plugins/sessions/src/live-approvals.ts`）

- 需要批准的调用原地挂起，`POST /run` 保持进行中。会话详情的 pending 项带 `waiting: true`。`POST /approvals` 直接唤醒这次调用，同一轮继续，不新增用户消息，也不重新发起运行。
- 先到的答复生效。重复同一决定返回 200 和 `duplicate: true`；改口返回 409 `approval_already_answered`。
- 拒绝作为普通 `permission_denied` 结果（`data.reason = user_denied`）交给模型，本轮继续。拒绝时可附一句理由，模型会看到原文。只有拒绝 `exit_plan_mode` 会结束本轮（`plan_exit_denied`）；这个工具在第 3 步接入。
- 按停止后约 100ms 内取消等待（`cancelled`）。sessions 插件关闭、宿主关闭或卡片无法显示时，按旧流程以 `approval_required` 暂停，下轮重放；旧会话也照旧「批准后重跑」。
- 「允许本会话」：同一会话里工具、类型、目标都完全相同的调用不再询问。只存在内存里，停止、删除或重置会话后清空。被 alwaysAsk、ask 规则或远程 exec 拦下的调用每次都问，不进这张放行表；这类卡片不显示「允许本会话」（pending 项带 `oneShot: true`）。
- 可选的等待超时 `approvalTimeoutMs`，默认关闭（与 ZCode 相同）。超时按拒绝处理，`reason = permission_timeout`。
- webapp 批准卡片：等待项显示「等待确认」「拒绝」「允许本会话」「允许」和可选的拒绝理由输入框；批量操作为「全部允许 (n)」；运行中也能点。

**权限策略**（`packages/permissions/src/`）

- bash 只读命令免批：先用 ZCode 的 argv 规则判断（`readonly-argv*.ts`），判为只读后再过 Xueness 原有的更严检查：参数不能指向工作区外，glob 不能展开成选项，`cd` 受限，`uniq` 不能写输出文件，sed 脚本不能含 `w`/`e`/`r`。ZCode 判为写而旧分类器判为读时，按更严的结果（例如 `git -C`）。`cd`/`pushd` 和 `git` 出现在同一行时不算只读。服务端在 posix 上打开 `readOnlyCommands`；Windows 仍走 PowerShell，不做分类。
- 决策顺序：disallow、deny（yolo 下也生效）→ 计划模式下非只读调用拒绝 → alwaysAsk → 远程 exec 询问 → yolo 直通（ask 规则不再询问）→ ask 规则 → 免批类型 → allow 规则、会话规则、只读命令 → edit 模式放行写和编辑 → 一次性批准 → 询问。
- 规则匹配换成 ZCode 的 bash 规则求值：复合命令里每一段非只读命令都要命中 allow；deny 和 ask 只要有一段命中就生效（包括 `$(…)`、`bash -c`、`xargs`、`find -exec` 里的命令）；规则文本与整行完全相同时，可以放行无法拆分的命令。
- 新增设置项 `alwaysAsk`：每次都问，只读、allow、yolo 都跳不过；只有一次性批准能过。

**审核时修掉的问题**（路 B，均已补测试 `packages/permissions/test/readonly-review.test.ts`）

1. `command` / `builtin` / `noglob` 前缀会绕过 Xueness 的更严检查：`command sed '1e touch x' f`、`command uniq a out`、`command cat /etc/shadow` 都被判为只读。现在先剥掉前缀，再判断里面的命令。
2. `xargs head`、`git ls-files | xargs grep` 被判为只读，但 xargs 的参数来自输入，工作区检查看不到（`echo ~/.ssh/id_rsa | xargs head`）。现在 xargs 一律询问。
3. 从工作区外读入的重定向（`cat < /etc/passwd`、`head < ~/.ssh/id_rsa`）原来就会放行（基线就有这个漏洞），现在要询问。
4. 以 ` *` 结尾、中间还带通配符的规则（`git * push *`、`* --force *`、`timeout * rm *`）被当成字面前缀，deny 规则因此失效。现在恢复通配语义。
5. allow 规则会按程序名匹配带路径的程序：`exec(rm *)` 会放行 `./rm x`。现在 allow 只认原样的命令名；deny 仍然会把 `/bin/rm` 当作 `rm` 来拦。
6. 合入后定案：alwaysAsk、ask 规则和远程 exec 的询问都不受「允许本会话」影响（见上文）。路 A 的批准用例依赖 build 模式下写文件要询问，路 B 改了默认值之后这个前提仍然成立，门禁已验证。

**验证**：ts `npm run check` 通过（行数门禁 422 个文件，最大 400 行；插件门禁；类型检查；582 项测试，581 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 安装的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1699/1699 通过。另用基线和新分类器跑了约 59 万条命令的差分，并逐条核对了 554 条危险命令（重定向、管道、命令替换、`find -exec`/`-delete`、git 写参数、`sed -i` 等），没有写操作被判为只读。

**剩余差异**

- 「始终允许」（把规则持久化到设置）还没做：`ApprovalAnswer.remember` 需要接到 `PermissionSession.remember` 并写入设置。服务端目前也不从设置读 allow/deny/ask/alwaysAsk 规则，`alwaysAsk` 只能在代码里配置；路线图里「工具自报 alwaysAsk」也还没接。
- 服务端计划模式仍把 `exec` 整类放进 disallow，所以计划模式下的只读直通目前只在权限包里生效。`exit_plan_mode` 工具留到第 3 步。
- 比 ZCode 更严的地方：工作区外路径、xargs、工作区外的输入重定向、sed `e`、`git -C` 等都要询问；yolo 下 deny 和 disallow 仍然生效。
- 「允许本会话」按完全相同的目标匹配，比 ZCode 的会话规则窄；停止后清空。
- 没有移植：裸仓库和 gitdir 的运行时检查、稳定前缀建议（依赖 ZCode 生成的 `bash-command-registry.ts`）、hook 与批准竞速、ZCode 列表式卡片和键盘提示；用户拒绝的默认文案仍是 Xueness 的 `the user declined this <kind> call`。

## 12. ZCode 对齐第 2 步：提示词、上下文与插话（只改 TS，2026-10-19）

对照 ZCode v3.15.1（`aac4755`），全部由主代理编写，未用 Grok。Python 未改动；会话日志（journal）里的 `SYSTEM_PROMPT` 也没改，Python 对照测试照旧。改动只发生在每次发给模型的请求视图里。

**分段系统提示**（`packages/agent/src/prompt/`：`sections.ts`、`env-sections.ts`、`builder.ts`）

- 按 ZCode `context/builder.ts` 组装三条 system 消息：短前缀「You are Xueness, an interactive coding agent」；稳定正文（身份、安全声明、`# Harness`），带缓存标记；动态块（`# Communicating with the user` 等行为说明、`# Environment`、`# Context management` 及自主执行附录、git 状态快照、Xueness 的 `# Host notes`）。文本用 ZCode 原文，只把产品名换成 Xueness（待决定事项按建议执行）。
- 宿主追加指令（planning 的执行策略、协议修复提示等）不再拼在 `messages[0]` 末尾，而是作为第四条 system 消息。
- `# Environment`：工作目录、是否 git 仓库、平台、shell、系统版本、当前模型。git 快照（分支、主分支、git 用户、`status --short` 最多 40 行、最近 5 个提交）每个会话在进程内只取一次，与 ZCode「会话开始时的快照」一致（`environment.ts`）。
- 缓存标记以 `_cache_control` 私有字段携带，providers 发请求前会剥掉 `_` 字段，所以对 OpenAI 兼容接口无影响。

**system-reminder**（`system-reminder.ts`、`view.ts`、`extension.ts`）

- 移植 ZCode 31 个 reminder 来源的描述表、`wrapSystemReminder`（空正文、嵌套标签直接报错）和 `wrapSystemReminderForSource`（嵌套标签只转义开头的 `<`；`context_prefix` 结尾带换行）。
- 请求前缀加一条 `context_prefix` 用户消息：`# agentsMd`（工作区 AGENTS.md，按 ZCode 格式写成 `Contents of <绝对路径> (workspace instructions):`）和 `# currentDate`（本机日期）。files 插件仍按原规则读 AGENTS.md，只是给那条消息加了 `_context_source` 和结构化内容，由视图移进这条 reminder。
- 插话：运行中发送的引导（steering）本来就在两步之间写进当前轮；现在请求视图把它包成 ZCode 的 `incoming_message` reminder（「The user sent a new message while you were working: …」），日志里仍保留用户原话。
- 去重：日志不被改写，视图每次请求都从头生成，所以 reminder 不会累积；同一条引导靠 `_input_id` 只写入一次（原有逻辑）。
- 扩展 `promptContextExtension`（id `sessions`，能力 `sessions.prompt_context`）在 agent-service 里排在语义压缩和轻量运行时之后；轻量运行时（lightweight）保持自己的短提示，不经过这个视图。

**界面**：webapp 已有运行中「引导当前轮」和「待处理引导」列表，本步无需改动。

**验证**：ts `npm run check` 通过（行数门禁、插件门禁、类型检查；599 项测试，598 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1699/1699。新增 `packages/agent/test/zcode-prompt-context.test.ts`（17 项，移植自 ZCode `context-builder.test.ts`、`system-reminder-source.test.ts`，含「插话出现在同一轮下一次模型请求」的端到端用例）；`agent-http-production.test.ts` 改为在任一 system 消息里找 planning 策略。

**剩余差异**

- 工具名改成 ZCode 名（给旧会话留别名）和工具说明换成 ZCode 原文，放到第 3 步与工具实现一起做，避免两次改动工具表。
- 会话上下文引用（`session-context/`、read-session-context 工具）没做；记忆（Memory）、技能列表、Desktop Gen UI、工作流子代理身份等分段要等第 5、6 步对应能力迁到 TS。
- 其余 reminder 来源（todo_reminder、date_change、prompt_attachment 附件、hook_context 等）只有描述表，还没有产生方；附件仍按原 `withAttachments` 写进用户消息。
- 没有补 `packages/model-option-map` 的上下文窗口和输出上限表，留给第 4 步。
- `# Harness` 里「displayed … in a terminal」等句子按原文保留，与 Xueness 网页界面略有出入。

## 13. ZCode 对齐第 3 步第 1 轮：核心工具契约、ExitPlanMode、读写改与 bash（只改 TS，2026-10-19）

对照 ZCode v3.15.1（`aac4755`），由主代理编写；Grok 只承担第 2 轮的两块边界清楚的辅助件（ApplyPatch 解析/应用、Edit 匹配器），在单独 worktree 里进行，尚未合入。Python 未改动。对照与分轮见 `/workspace/xueness-018/STEP3-RECON.md`；ZCode 契约原文由 ZCode 源码直接导出，放在 `review/zcode-tool-contracts/`。

**契约层：模型看到 ZCode 工具名**（`packages/agent/src/tool-contract/`）

- 内部名不改：它们同时是 Gate 类型、manifest 名、Python 对照日志名、sessions 投影键和 Python 回退名。只有模型看到 ZCode 名：exec→Bash、read→Read、write→Write、edit→Edit、glob→Glob、grep→Grep、todo_read→TodoRead、todo_write→TodoWrite、ask_user→AskUserQuestion、exec_output→TaskOutput、exec_kill→TaskStop、exit_plan_mode→ExitPlanMode。
- 发出（请求视图，不改写日志）：工具表换成 ZCode 名、说明原文（去品牌；去掉图片/视频；Bash 的 cwd 和后台任务句改成 Xueness 的实际行为）和 schema，按 ZCode 的 provider 顺序排列。历史里的 tool_calls：新调用用日志里保存的 `_model_call` 原文；旧会话用反向映射重建（这就是旧会话别名）。工具结果：成功给输出文本；失败给 `<tool_use_error>…</tool_use_error>`；Bash 失败（command_failed/timeout/cancelled/not_found）保持纯文本；空结果给 `(<Tool> completed with no output)`。
- 收到：先按 ZCode 做 semanticNumber/semanticBoolean（只在 ZCode schema 里有的字段，如 Bash timeout），再按 ZCode schema 校验；不通过时由 beforeTool 否决，模型收到 `<tool_use_error>InputValidationError: X failed due to the following issue(s):…`。通过后转成内部名和参数写进日志，调用上保留 `_model_call {name, arguments}`。内部名的调用原样放行；轻量运行时保持内部名。
- 参数映射要点：Bash timeout 截到 600000（后台除外）、run_in_background→background、description 截 200；Read 的 offset ≤1 省略；路径工具 file_path↔path，回放时转绝对路径；Grep 的 -i/-C/-A/-B/head_limit/offset；TodoWrite 的 content/completed 与内部 text/done 互转；TaskOutput 的 block/timeout→wait_ms（≤30000）；TaskStop 缺 task_id 时报 ZCode 文案。
- driver 的工具重筛和 runTools 的活动集改用 `internalToolName`，否则 ZCode 名的工具会被过滤掉。

**ExitPlanMode**（`plugins/planning/src/plan-exit.ts`、`apps/server/src/plan-mode-port.ts`、`packages/permissions/src/`）

- 新权限类型 `plan_exit`：计划模式下每次都询问（code `plan_exit`，一次性，「允许本会话」不生效）；不在计划模式时直接放行，工具回答 ZCode 的「You are not in plan mode…」。
- 批准后工具调用 `PlanModePort.exit()`：本次运行的权限切到运行自身的模式（原本是 plan 时切到 build），`session.mode = build`，mode_history 追加一条。模型收到「User has approved your plan. You can now start coding. Start with updating your todo list if applicable.\n\n## Approved Plan:\n<plan>」。
- 拒绝由第 1 步已有的 `withPlanExitDeniedTurnStop` 结束本轮（`plan_exit_denied`）。
- 服务端不再把 write/edit/exec/mcp/web_fetch/web_search 加进计划模式的 disallow；计划模式交给 PermissionSession 判断，只读 exec 因此可以直通（第 1 步遗留项）。

**读、写、改、bash 的行为与文案**（`packages/engine-tools/src/`：`read.ts`、`write.ts`、`edit.ts`、`exec.ts`、`exec-tasks.ts`、`file-state.ts`、`zcode-text.ts`）

- Read：不带 limit 时读全文（取消默认 2000 行和 2000 字符截行），全文超过 256KB 报 ZCode 的 too_large 文案；超过 25000 估算 token 时，首次全文读取改为部分视图并给出续读提示，指定范围的读取直接报错；空文件、offset 超出末尾给 system-reminder；文件不存在给「File does not exist. Note: your current working directory is … Did you mean …?」；目录给 `Path is a directory: <绝对路径>`；按扩展名拒绝二进制、拒绝会阻塞的设备路径；去掉 `[showing lines…]` 尾注（续读位置仍在 data.nextOffset）。部分视图记为部分读取，之后的编辑照旧被拒。
- Write/Edit：未读、已变更的报错换成 ZCode 原文；成功文本换成「File created successfully at: …」「The file … has been updated successfully.」加「(file state is current in your context — no need to Read it back)」；diff 移到 data.diff（界面照旧可用）。Edit 增加 old_string 为空时新建文件或填充空文件、「Cannot create new file - file already exists.」，未找到和多处匹配用 ZCode 文案（去掉 Xueness 的「closest line」提示），相同字符串直接报「No changes to make…」。
- Bash：输出 = stdout（去开头空行、去尾空白）+ stderr（trim）；真正失败时前缀 `Exit code N`；grep/rg/egrep/fgrep 退出 1、diff 退出 1、find 退出 1、test/[ 退出 1 视为语义无错，不加前缀（结果仍是 ok:false，界面能看到退出码）；超时/取消追加 `<error>Command was aborted before completion</error>`；输出被截断时给 `<persisted-output>` 信封（前 2000 字符预览，指向完整日志）；后台任务启动文案改为「Command running in background with ID: …」，并说明用 TaskOutput/TaskStop。

**界面**（webapp）：新增 `src/xuenessToolNames.ts`，渲染器选择、批准影响分类和时间线行构造都先把 ZCode 名映射回内部名；时间线工具标签显示 ZCode 名（Write、TodoWrite…，`data-tool-name` 仍是内部名）；对话视图给 todo/提问/后台任务/退出计划模式补了中文标签；ExitPlanMode 的批准卡片显示「批准计划」、说明文字和完整计划正文（保留换行、可滚动）。

**验证**：ts `npm run check` 通过（行数门禁 448 个文件，最大 400 行；插件门禁 6 个插件；类型检查；630 项测试，629 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1700/1700。合入 main 后重跑结果相同。新增测试：`packages/agent/test/tool-contract.test.ts`（改名、旧会话别名、校验文案、结果投影、顺序）、`packages/engine-tools/test/zcode-contract-port.test.ts`（17 项，移植自 ZCode read/write/edit-tool-contract、bash-result-mapping）、`plugins/planning/test/plan-exit.test.ts`（批准前询问、批准返回计划并退出、每次都问、拒绝结束本轮、计划模式外不问）、`apps/server/test/plan-mode-port.test.ts`、`webapp/src/xuenessToolNames.test.ts`。改动的旧断言：`edit-write-read`、`exec` 测试换成 ZCode 文案；`policy.test` 的类型数 19→20；`policy-differential` 和 `bundled-plugins` 把 TS 独有的 `plan_exit`/`exit_plan_mode` 排除在 Python 对照之外；时间线测试改为断言 `Write` 标签。

**剩余差异**

- Bash 的工作目录不跨调用保留（ZCode 保留），也不从用户 profile 初始化；说明文字已按 Xueness 实际行为改写。后台任务没有完成通知，模型需要用 TaskOutput 轮询。
- Read 没有 file_unchanged 去重存根（要和第 4 步压缩一起做）；ZCode 的 offset 0 从第 0 行编号，Xueness 统一从 1 开始；不支持图片、PDF、视频、notebook。
- Edit 匹配器（引号风格保留、删行时连带换行、去行号前缀等 ZCode 细节）和 ApplyPatch 在第 2 轮合入；`.ipynb` 不拒绝（Xueness 没有 NotebookEdit）。
- 非 Bash 工具的所有失败都包成 tool_use_error（ZCode 对部分工具自有错误不包）。AskUserQuestion 仍限 3 问 3 选项，丢弃 preview。
- ExitPlanMode 不落盘计划文件；界面的模式开关可能在下一次运行把会话重新切回计划模式。EnterPlanMode、WebFetch/WebSearch、node-repl、cron 未做。
- 第 2 轮：合入并审核 Grok 的 ApplyPatch 和 Edit 匹配器，Glob/Grep、TodoWrite 优先级、TaskOutput/TaskStop 文案、AskUserQuestion、EnterPlanMode。

## 14. ZCode 对齐第 3 步第 2、3 轮：检索/任务/待办结果、EnterPlanMode、ApplyPatch、Edit 匹配器（只改 TS，2026-10-19）

对照 ZCode v3.15.1（`aac4755`）。第 2 轮由主代理编写；第 3 轮的 ApplyPatch（Grok s3g）和 Edit 匹配器（Grok s3h）由 Grok 辅助移植，主代理逐行审核、接线、修正后合入，提交信息标注「Grok 辅助、主代理审核」。Python 未改动。提交：第 2 轮 `e07863d`（合入 `b57b003`）；ApplyPatch `30e2e76` → `708cbb3` → `c1b80c6`；Edit 匹配器 `b74d7fe`（Grok 原样移植）→ `5198faf` → `bbf6cc6`（接线与修正）→ 合入 main `53a4cc2`。

**第 2 轮：结果投影和 EnterPlanMode**（`packages/agent/src/tool-contract/`、`plugins/planning/`、`apps/server/src/plan-mode-port.ts`）

- Glob：最多 100 条（ZCode MAX_GLOB_RESULTS），无结果给「No files found」，截断时追加 ZCode 的截断句。
- Grep：默认 `files_with_matches`（ZCode 默认；旧会话里没写 output_mode 的调用仍按 Xueness 的 content 回放）；`head_limit: 0` 视为不限（Xueness 上限 5000）；`type` 映射成常见 ripgrep 类型的 glob；content/count/files 三种模式的文本、`[Showing results with pagination = …]` 和「Found N total occurrences across M files.」按 ZCode formatGrepModelContent。
- TaskOutput：`<retrieval_status>/<task_id>/<task_type>/<status>/<exit_code>/<output>/<error>` 分块，running 时区分 timeout 和 not_ready；TaskStop 返回 ZCode 的 JSON；未知任务给「No task found with ID: …」。
- TodoRead/TodoWrite：模型看到 ZCode 的 `content/status/priority` JSON，TodoWrite 带 oldTodos 和状态汇总；priority（high/medium/low）只在 TS 侧保留。
- EnterPlanMode：新权限类型 `plan_enter`（从不询问），`PlanModePort.enter()` 把运行权限和 `session.mode` 切到 plan 并记 mode_history，模型收到 ZCode 的「Entered plan mode…」。

**第 3 轮：ApplyPatch**（`packages/engine-tools/src/{patch-parser,patch-apply,apply-patch}.ts`，Grok s3g 移植）

- 移植 ZCode 的补丁语法（Add/Delete/Update/Move、heredoc、EOF 标记）和 hunk 匹配（exact、trimEnd、trim、Unicode 标点、上下文锚、文件尾锚）；全部段落校验通过才落盘；保留每个文件原来的编码（含 GB2312/GBK/GB18030）和换行；成功文本、错误码、模型说明与 ZCode 一致。内部名 `apply_patch`（gate `edit`），模型名 `ApplyPatch`，files 插件 manifest 和前端工具名映射已加上。
- 审核修正：补丁里的每个文件都单独过权限（`subjectPaths`，任一被拒则整次拒绝），拒绝重复段落，Move 不覆盖已存在的目标，同路径 Move 保留文件。

**第 3 轮：Edit 匹配器**（`packages/engine-tools/src/edit-matchers*.ts`、`edit-locate.ts`、`edit.ts`，Grok s3h 移植）

- `edit-matchers*.ts` 是 ZCode `edit-matchers.ts` 的逐函数移植（脚本比对 34 个函数与 ZCode 完全一致），策略顺序：exact → quote_normalized → line_number_prefix_stripped → escape_normalized → unicode_escape_normalized → line_trimmed → indentation_flexible → block_anchor（首尾行锚定、中间行平均相似度 ≥ 0.8）；replace_all 时跳过后三种宽松策略。旧的 `edit-match.ts`（exact/line-numbers/quotes/line-trimmed + 重新缩进）已删除，`data.strategy` 改用 ZCode 策略名。
- `edit-locate.ts` 按 ZCode Edit handler 的顺序接线（findEditMatch → 出现次数门闩 → normalizeReplacementForMatch → preserveQuoteStyle → 字面替换），替换仍在原始文本上按偏移拼接，编辑范围外的 CRLF、BOM 和编码逐字节不变。
- 审核发现并修正的问题（都是 ZCode handler 本身的行为，Grok 的 SUMMARY 也如实列出了前三条）：
  1. 只含空白的 old_string 会被 line_trimmed 落到空行上，actualString 为空串，ZCode 的 countOccurrences 对空串会死循环；现在宽松策略得到空或纯空白的目标一律 not_found。
  2. 重叠的行窗口（`a\na` 对 `a\na\na`）candidateCount 为 2 而不重叠计数为 1，ZCode 会悄悄改第一处；现在取两者较大值，判为多处匹配。
  3. new_string 为空时，ZCode 只要文件里任意位置出现 `old\n` 就整体改搜 `old\n`：replace_all 会漏掉后面不跟换行的出现，删除到行中间时会把两行接起来。现在逐个出现处理，只有从行首开始（即删掉整行）的那处才连带删换行。
  4. ZCode 只要实际文本含弯引号且与 old_string 不完全相同（包括只差空白的 line_trimmed 命中）就把 new_string 里所有直引号改成弯引号，会把代码里的直引号改坏；现在只在 quote_normalized 命中、且该类引号在命中文本里全是弯引号时才转换，混用时 new_string 原样写入。
- 用例：`test/edit-matchers.test.ts`、`test/edit-matchers-apply.test.ts`（Grok 移植自 ZCode edit-tool-contract / file-tool-port，两条断言按上面的修正改写）、`test/edit-locate.test.ts`（防护用例）、`edit-write-read.test.ts` 新增 CRLF 文件上 line_trimmed 编辑和整行删除的端到端用例。

**验证**：main `53a4cc2` 上 ts `npm run check` 通过（行数门禁 467 个文件，最大 400 行；插件门禁 6 个插件；类型检查；711 项测试，710 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1700/1700。

**剩余差异**

- indentation_flexible 在 ZCode 的策略顺序里排在 line_trimmed 之后，实际不会胜出（行为与 ZCode 相同）；block_anchor 允许中间行有最多约 20% 的差异，命中后整块被 new_string 替换，这是 ZCode 的设计。
- escape_normalized 会把 new_string 里的 `\n`、`\t` 等也解开；unicode_escape_normalized 不解码 new_string（均与 ZCode 相同）。行号粘贴的 new_string 不再去行号（旧 Xueness 会去，ZCode 不去）。
- `.ipynb` 不拒绝（没有 NotebookEdit）；Read 的 file_unchanged 存根随第 4 步；Bash 工作目录不跨调用保留、后台任务无完成通知；AskUserQuestion 仍限 3 问 3 选项。
- WebFetch/WebSearch、Read 的图片/PDF/视频、node-repl、cron 未做；补丁 diff、网页抓取、多媒体预览等结果卡片未做（界面只加了工具名映射）。

## 15. ZCode 对齐第 4 步：上下文压缩（只改 TS 与 webapp，2026-10-19）

对照 ZCode v3.15.1（`aac4755`），摸底见 `STEP4-RECON.md`（不在包内）。核心与前端均由主代理编写；Grok 辅助的 webapp 任务 s4w 运行约 67 分钟无任何改动，按约定停掉，未合入任何 Grok 产出（worktree `/workspace/wt-018-s4w`、分支 `step4/webapp-compact-grok` 保留）。Python 未改动。提交：`caee9b6`（核心）→ `5290bb4`（压缩记录保持扁平）→ `1ed709d`（webapp `/compact`、分隔线文案、审核修正）→ `ec51f9f`（i18n.ts 保持 CRLF）→ 合入 main `5b97ef4`。

**触发与阈值**（`packages/agent/src/compact/{policy,model-limits,rounds}.ts`）

- 与 ZCode `compact/policy.ts` 逐项一致：有效窗口 = 上下文窗口 − min(模型输出上限或 32000, 21000)；阈值 = 有效窗口 − 13000；百分比固定 100；连续失败 3 次熔断；不足两组「assistant 开头的轮次」不压缩。token 数优先用上一次响应的 provider usage 加其后消息的估算，没有 usage 时按 ceil(字符/3) 估算（含 reasoning 和工具调用参数）。
- 窗口：provider 配置的 `context_window` / `max_output_tokens` 优先，其次 `model-limits.ts` 的按模型族保守表（ZCode 开源版没有表，这张是 Xueness 自己的），都没有用 ZCode 缺省 200000。
- 每次模型请求前在**已准备好的请求**上判断（auto）；请求报上下文超限（ZCode `isModelContextExceededError` 的 code/message 规则，加 Xueness provider 的 `contextOverflow`）时压缩一次再重试（reactive，每个模型步最多一次，一批工具执行后复位）；压缩后不到 3 个工具轮又要压缩、连续 3 次则以 ZCode 原文报错暂停（快速回填熔断）。

**摘要**（`compact/{prompt,selection,errors}.ts`、`plugins/providers/src/zcode-compact.ts`）

- 提示词、`formatCompactSummary`、摘要消息（「This session is being continued from a previous conversation…」）逐字照搬 ZCode `compact/prompt.ts`。
- 摘要请求 = 被摘要片段经正常请求视图（同一系统提示词分段、同一 ZCode 工具表，工具超过 100 个时不带）+ 压缩提示词；输出上限 min(…, 20000)；返回工具调用或空摘要按 ZCode 文案失败。
- 保留：auto/reactive 保留最后 1 组，manual 不保留。摘要请求本身超窗：auto/reactive 按报错里的 token 差额多保留近期组；manual 丢最旧的组并补 `[earlier conversation truncated for compaction retry]`，最多 3 次，仍不行给 ZCode 的「Conversation too long to compact automatically…」。auto 整体失败最多试 3 次。
- 新 journal = `[system, 摘要行, 保留组]`；摘要行以 `role: system`、`_compact_summary: true` 存储，请求视图里变成 ZCode 的 user 摘要消息。原文进 `archived_messages`，`context_checkpoints` 记 `kind: "zcode"` 检查点（含原文、摘要、用量），`compactions` 追加扁平记录（`kind/trigger/phase/reason/checkpointId/removed/kept/summarizedMessageCount/preCompactTokens/postCompactTokens/truePostCompactTokens/willRetriggerNextTurn/customInstructions/at`）。
- 失败不丢消息：全部改写先在深拷贝上完成，`save` 成功后才替换内存会话；任何失败（含取消）原会话不变，auto 失败计数 +1 后请求照常发出。

**压缩后续上**（`compact/post-reminders.ts`、`zcode-compact-view.ts`）

- 读文件状态：从被摘要片段里成功的 Read 结果取最近的最多 5 个文件（单个 ≤5000、合计 ≤50000 token，超了给 ZCode 的「Note: … was read before the last conversation was summarized…」），跳过 `.git`、保留组里读过的、之后被 Write/Edit/ApplyPatch 改过的文件；格式为 ZCode 的「Called the Read tool with the following input: …」。
- todo：Xueness 没有 ZCode 的周期 todo 提醒，压缩后用 ZCode `todo_reminder` 原文附一次现有清单。
- 提醒存在摘要行的 `_post_compact_reminders` 上，请求视图在摘要后展开为 system-reminder。
- Read `file_unchanged`：请求视图里同参数、结果一字不差且前一次结果仍在上下文里的重复 Read 换成 ZCode 存根原文；被压缩或 microcompact 清理后自然失效。
- microcompact：移植 ZCode `compact/microcompact.ts`（只清 Read/Bash/Grep/Glob/WebFetch/WebSearch/Edit/Write/ApplyPatch 的旧结果，保留最近 5 组，节省不足 256 token 不做），与 ZCode 一样默认关闭；只在请求视图里清理，journal 不变。

**手动压缩与界面**

- `POST /api/sessions/:id/compact {instructions?}`：标准运行时用会话模型走 ZCode 手动压缩（`apps/server/src/agent-compact.ts`）；历史太少返回 `compacted:false, reason:"nothing_to_compact"`；轻量运行时、没有可用模型或关闭压缩时仍走原来的确定性压缩。运行中返回 409。
- webapp：输入框发送 `/compact [说明]`（没有附件和上下文附加项时）改为调用该接口，不再当普通消息发给模型（`plugins/sessions/manualCompact.ts`）；运行中直接提示「请先停止运行，再压缩上下文。」；过程中和结果用会话提示条显示 ZCode 文案（正在压缩上下文... / 对话已压缩：约 A → B token / 上下文已是最新，无需压缩 / 上下文压缩失败：…）。说明里的换行合成空格（服务端拒绝控制字符，与 Python 一致）。斜杠菜单说明改为「压缩当前对话（可附说明）」。
- 压缩分隔线：最近一条记录是 ZCode 压缩时显示 ZCode 的「上下文已压缩」（附已摘要条数）；旧记录文案不变。

**旧会话**：旧的 `_semantic_summary`、确定性摘要、归档与检查点照常显示、分叉和重放；语义压缩扩展只在轻量运行时生效，确定性 `compact()` 保留给轻量运行时和 Python 对照。分叉把新摘要识别为「已压缩」。

**审核中修的问题**

- `compact_history_changed`（摘要期间历史变了）原先标为可重试，自动压缩会用同一份旧历史再发两次摘要请求、注定失败；改为不可重试。
- 压缩记录曾带嵌套的 usage 对象，webapp 的 `parseSessionCompactions` 会把整条记录丢掉、分隔线消失；改为扁平记录，用量放到检查点上（`5290bb4`）。
- webapp `/compact` 原先被当成普通消息发给模型（第 4 步之前就有的 bug），已改为调用压缩接口；错误回复的 `refusal.detail` 原先会被通用 `post` 封装吞成「HTTP 502」，手动压缩改用自己的请求函数读出可显示的说明。

**验证**：main `5b97ef4` 上 ts `npm run check` 通过（行数门禁 482 个文件，最大 400 行；插件门禁 6 个插件；类型检查；735 项测试，734 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1708/1708。

**剩余差异**

- agent listing（子代理，第 5 步）、计划文件引用（Xueness 不落盘已批准计划）、压缩后重置记忆召回（第 5 步）未做。
- microcompact 没有设置项，只能代码里开；时间触发（空闲 >60 分钟）需要消息时间戳，没做。
- 压缩的 started/retrying/failed 只作为运行事件 `context/compaction_*` 发出，不持久化；界面没有「正在压缩」的时间线行，也没有失败后的一键重试。手动压缩后（不保留近期组）要等下一条消息出现，分隔线才会显示。
- 媒体过大时把图片/文档换成占位再试一次（ZCode）未做。
- 模型窗口表是保守的手写表，新模型需要在 provider 配置里填 `context_window`。

## 16. ZCode 对齐第 5 步第 1 轮：MCP 运行时迁到 TS（只改 TS，2026-10-19）

摸底见 `STEP5-RECON.md`（不在包内），全步分 4 轮：5.1 MCP、5.2 技能与命令展开、5.3 hooks、5.4 子代理与记忆。本轮代码由主代理编写，没有用 Grok。Python 未改动。提交：`964433c`（MCP 插件、加载器、路由与测试）→ 合入 main `562fb58`。

**路由**（`apps/server/src/mcp-servers.ts`、`agent-features.ts`、`agent-service.ts`）

- `loadMcpServers(stateDir)` 逐项照 Python `mcp.load`：拒绝链接的目录与条目，单个条目上限 1 MiB，`*.json`（pathlib 一样包括点文件）按名排序，坏条目、非法 id、停用、缺 command/url 的跳过，最后按 id 排序。对照测试直接比 Python `load()` 的 JSON。
- 请求带 `allow_mcp`、mcp 插件开着、不是远程会话、至少一个可用服务时，这一轮由 TS 执行，能力 `mcp.connections` 由 `{ id: "mcp" }` 扩展声明。下列情况整轮仍交给 Python（不在 TS 里半做）：服务配了 `oauth`、`elicitation: true`、stdio `args` 不全是字符串、id 重复、条目超大、`resources/plugins` 里有 `builtin: "mcp"` 的管控清单。
- 插件按轮启用：运行前把本轮服务交给插件并 `host.enable("mcp")`，结束时（含失败、取消）`disable`，作用域关闭时杀掉 stdio 进程树。与 Python 每轮激活、轮末关闭一致。

**插件**（`plugins/mcp/src/`，自写 JSON-RPC 客户端，不引 MCP SDK）

- 传输：stdio（换行 JSON，单行 16 MiB 上限，子进程只给 PATH、HOME，Windows 另给 SYSTEMROOT 等）、Streamable HTTP（JSON 或 SSE 回复、`Mcp-Session-Id`、`MCP-Protocol-Version`、禁止重定向、1 MB 上限）、旧 SSE（GET 流、同源 endpoint）。URL 校验、`headersEnv` 只认 Authorization/X-Api-Key、回环地址需 `allowLoopbackHttp`，均同 Python。
- 握手：stdio 先 2024-11-05，服务报错再按新到旧试其余版本；HTTP 只试 2025-03-26（或钉的 `protocolVersion`）。超时默认 10 秒、上限 30 秒。服务发来的请求一律回 -32601。
- 工具：`mcp__<id>__<sanitize(tool)>`、`parse_namespaced`、`tool_schema`、批准 subject（sort_keys 紧凑 JSON `{"tool","arguments"}`）与 Python 逐项对照一致；保留 Python 允许 `.` 的规则，旧会话里的工具名照常有效。kernel 工具名正则加了 MCP 名的分支；模型看到服务自己的 `inputSchema`（`modelSchema`），校验只要求对象。服务声明 resources/prompts 时加 `_xueness_resources_*`、`_xueness_prompts_*` 四个工具（结果截 12000 字、标 untrusted）。`tools/list` 支持分页（≤50 页、≤1000 项）。
- 调用：Gate kind `mcp`，每次都要批准（ZCode `needsApproval: true`；yolo 照常放行；计划模式拒绝），manifest 标 mutating（同 Python `Gate.check`）。连接断了先重连一次并确认工具还在。结果文本按 ZCode `formatMcpToolResult`：文本块、resource 文本、`Structured content:` JSON，50,000 字节预算（Python 是 2000 字）；`isError` 时模型看到「MCP tool returned an error:\n…」，其余失败给 `mcp_error`（界面「MCP 调用失败。」）。

**测试**：`plugins/mcp/test/` 用脚本化假服务覆盖 stdio（握手降级、分页、怪名字、结构化结果、isError、服务请求、沉默与退出、重连、环境变量隔离）与 HTTP/SSE（JSON/SSE 回复、拒绝、URL 与认证、重定向、跨源 endpoint）；`mcp-python.test.ts` 对照 Python 的命名、解析、schema、subject 与结果文本；`apps/server/test/mcp-servers.test.ts` 对照 Python `load()` 并覆盖回退判断；`agent-service.test.ts` 端到端：配置假服务 → 模型调用 `mcp__fake__echo` → 批准 → 模型读到纯文本 → 下一轮没有 MCP 工具。

**验证**：main `562fb58` 上 ts `npm run check` 通过（行数门禁 493 个文件，最大 400 行；插件门禁 7 个插件、130 个源文件；类型检查；759 项测试，758 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1708/1708（本轮没改 webapp）。

**剩余差异**

- 图片内容块（ZCode 转 data URL）、MCP app tools、进度通知未做；结果只取文本。
- Node `fetch` 不读 `HTTP(S)_PROXY`，Python urllib 会读；需要代理的 HTTP MCP 服务目前连不上。
- 调用超时沿用 Python 配置（默认 10 秒），不是 ZCode 的 30 秒；取消只在调用开始前生效，进行中的调用等超时结束。
- 同一服务两个工具清洗后同名时保留第一个。
- OAuth、elicitation、插件清单管控、远程会话仍走 Python；设置页、`/mcp` 斜杠命令、诊断与 OAuth 的 HTTP 路由仍由 Python 处理（第 7 步）。

## 17. ZCode 对齐第 5 步第 2 轮：技能迁到 TS（只改 TS，2026-10-19）

本轮代码由主代理编写，没有用 Grok。Python 未改动。提交：`e5f1b8c`（技能插件、Skill 工具契约、技能清单提醒、路由与测试）→ 合入 main `c159850`。

**插件**（`plugins/skills/src/`，fs 只读 state 与 workspace）

- 发现与合并逐项照 Python `file_skills`：工作区 `.xueness/skills`、兼容的 `.zcode/skills`、用户 `<state>/skills`，加 `<state>/resources/skills` 资源技能；每根目录最多 128 个，`SKILL.md` 上限 256 KB，拒绝链接（Windows junction 也算），O_NOFOLLOW 只读普通文件，UTF-8 严格解码（BOM 照 Python 保留判断）。frontmatter 解析（折叠/字面描述、tags、名字校验）、遮蔽顺序、诊断文本、`skill_validate`、目录文本（4000 字）都和 Python 逐字段对照。
- 工具：`skill_read`（模型侧名字 `Skill`，输入 `{skill}`，旧的 `name` 字段和开头的 `/` 都接受；日志里仍是 `{id}`，旧会话照常回放）、`skill_validate`。`skill_read` 是读类 Gate、text subject，默认放行（同 ZCode `needsApproval: false`），针对 `skill_read`/read 的禁止规则照常生效。
- 结果按 ZCode `core/src/tool/handlers/skill.ts`：`<skill_content>` 包裹，展开 `${ZCODE_SKILL_DIR}`/`${CLAUDE_SKILL_DIR}`，正文超过 100,000 字节截断并标「[Skill content truncated]」；资源技能用「描述\n\n正文」，不写目录行。未知技能回「Unknown skill: X」。
- 续读提醒保留 Python 的每轮指针（读过的技能在后续轮次提醒还在用），措辞改成 ZCode 的 Skill 工具。

**提示词**（`packages/agent/src/prompt/`）

- 标准运行时：请求里有 Skill 工具时，在 system 之后插一条只用于请求的 `_context_source: "skills_listing"` 消息，提示词视图把它变成单独的 meta-user system-reminder（排在 context_prefix 前，不持久化），格式照 ZCode `context/sections/skills.ts`：20,000 字预算，描述截到 250 字，超预算只列名字；指南里加 ZCode 的斜杠技能提示行。
- 轻量运行时：保留 Python 的不可信前言 + 目录文本。
- 远程会话不注入清单。

**行为变化**：Python 在关掉 `skill_catalog` 时把资源技能正文直接塞进提示词（eager 模式）；TS 统一用清单 + Skill 工具按需加载（ZCode 做法）。

**顺带修复**：MCP 名字清洗的空白类改成显式的 Python 空白集合，不再剥 U+FEFF（与 Python `str.strip` 一致），对照测试加了 BOM、U+001C、U+0085 用例。

**测试**：`plugins/skills/test/skills-python.test.ts` 用一套夹具（多来源、链接、BOM、CRLF、折叠描述、坏名字、超大文件等）对照 Python 的 list_all、诊断、目录、正文、解析、校验与指针；`skills-zcode.test.ts` 移植 ZCode `context-builder` 与 `skill-tool` 用例；`agent-service.test.ts` 端到端：工作区技能 → 模型看到清单 → 调 `Skill` → 读到 `<skill_content>`。

**验证**：main `c159850` 上 ts `npm run check` 通过（行数门禁 505 个文件，最大 400 行；插件门禁 8 个插件、138 个源文件；类型检查；768 项测试，767 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1708/1708（webapp 只加了 `skill_read → Skill` 的工具名映射）。

**剩余差异**

- composer 的 `/命令` 展开已在第 7 步第 2 轮迁到 TS（第 25 节）；输入 `/技能名` 仍不会像 ZCode 那样直接调技能。
- Skill 工具不支持 `args`；不内置 skill-creator 等技能。
- 「could not be listed」诊断不带 Python 的异常文本；资源技能 JSON 有 16 MiB 上限；Windows 上除 junction 外的其它重解析点不识别为链接。
- Python 对只有 CR 的文本校验会抛 StopIteration，TS 返回 `skill_empty_body`（有意的差异，测试里写明）。

## 18. ZCode 对齐第 5 步第 3 轮：hooks 迁到 TS（只改 TS，2026-10-19）

本轮代码由主代理编写，没有用 Grok。Python 未改动。提交：`743c639`（hooks 插件、接线与测试）→ 合入 main `a4697bc`。前一个执行者留下的未提交改动（`plugins/hooks/src/{files,load,workspace,trust,runner}.ts`、manifest、package）经审核后原样保留，本轮补齐了入口、ZCode 输出解析、接线和测试。

**插件**（`plugins/hooks/src/`，exec `*`，fs 只读 state 与 workspace）

- 资源 hooks：`<state>/resources/hooks/<id>.json`（`id/event/command/args/matcher/enabled/timeout/pipeline`），加载、跳过规则、排序和 matcher（Python `re.search`，`(?i)` 等前缀、`(?P<>)` 命名组转换）照 Python `hooks.py`。matcher 同时对 Xueness 工具名（`exec`）和模型看到的 ZCode 名（`Bash`）匹配，所以旧配置和 ZCode 风格的 `Bash|Read` 都能用。
- 运行器照 Python `HookRunner`：argv 不经 shell，cwd 为会话工作区，子进程只给 `PATH`、`HOME`（Windows 另加固定的系统变量），stdin 是 `json.dumps(payload)`（ASCII 转义、Python 分隔符），stdout+stderr 合并截到 2000 字，超时上限 30 秒（超时整棵进程树结束），exit 0 通过、2 拦截（仅 PreToolUse）、其它是警告；启动失败、坏工作目录都只记 exit -1，不会让运行失败。
- 工作区 hooks：`.xueness/hooks.json`（原生列表）和 `.zcode/config.json`（ZCode 嵌套 `hooks.events`，只认 `type: "process"`，`command` 类型只报诊断不执行），默认关，需 `<state>/workspace-hooks.json` 恰为 `{"enabled": true}`；声明摘要和整包摘要、信任库 `hook-trust.json`（schema 1、512 条、坏库一律不信任）与 Python `workspace_hooks.py` 逐字段一致，未授权的记一条去重的 `hook_diagnostics.pending_trust`。授权/撤销仍由设置页 HTTP 和 CLI（Python）写，运行时只读。

**触发点**（agent 扩展 `hooks.commands`，照 `core.run_session`）

- 请求带 `allow_hooks` 时（旧称 legacy）：运行开始触发 SessionStart（`{session_id, workspace}`）和 UserPromptSubmit（`{session_id, prompt}`）；每个调用执行前 PreToolUse（`{session_id, tool_name, tool_call_id, arguments}`），在批准之前，exit 2 拦截，结果是 `{"ok": false, "error": "blocked by hook <id>", "hook_blocked": true, "hook_output_untrusted": …}`（输出截 500 字，只作为数据，不拼进错误文本）；拒绝后（`approval_required`/`permission_denied`/`plan_mode_denied`，即 Python 的 `error == "denied"`）触发 PermissionRequest，只观察、永不放行；每个结果后 PostToolUse/PostToolUseFailure；运行结束触发一次 Stop（`{session_id, status, steps}`）。每次触发写一行 `session.hook_log`（最多 100 行，只记元数据，不存输出）。
- `"pipeline": true` 的 Post hooks 不看 `allow_hooks`，对每个进入工具桥的调用触发（插件订阅 `before_tool_execution` 记下调用），stdin 带结果（超过 8000 字只给预览），不写审计，同 Python `tool_events.py`。
- ZCode `output.ts`：通过（exit 0）的 PreToolUse hook 若在 stdout 打印 `{"continue": false}`、`{"decision": "block"}` 或 `hookSpecificOutput.permissionDecision: "deny"`，按拦截处理，理由取 `permissionDecisionReason`/`stopReason`。`allow`/`approve`、`ask`、`updatedInput`、`additionalContext`、Stop 续跑都解析但不采用。

**路由**：`hooks.commands` 由 TS 声明，配置了资源 hooks 或工作区 hooks 不再整轮回退 Python（`agent-service.test.ts` 相应断言改为原生）。插件 reconcile 列表补上 `skills`、`hooks`，设置里开关插件会即时生效。

**测试**：`plugins/hooks/test/hooks-python.test.ts` 用一套夹具（坏 JSON、BOM、链接、空白 id、坏正则、`(?i)`、工作区原生/兼容各种坏条目、重复 id）对照 Python 的 load、select、discover（含摘要）、grant_trust 之后的 admitted、extend_for_runner、load_trust、feature_status、clip、`_bounded_result`，并用真实子进程对照 fire 的结果（stdin 回显、exit 2/3、找不到程序、超时、坏参数、坏工作目录、pipeline 过滤）和 `_timeout_for`；`hooks-zcode.test.ts` 移植 ZCode `hooks-seven-events.test.ts` 的输出与 matcher 用例并测只收紧的规则；`apps/server/test/agent-hooks.test.ts` 端到端测七个事件、拦截 Bash、审计、PermissionRequest 不放行、无 `allow_hooks` 时只跑 pipeline、工作区 hooks 未授权不跑、授权后跑。

**验证**：main `a4697bc` 上 ts `npm run check` 通过（行数门禁 516 个文件，最大 400 行；插件门禁 9 个插件、145 个源文件；类型检查；779 项测试，778 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1708/1708（webapp 未改）。

**审核发现**

- 前任的移植逐项对照 Python 全部一致（包括摘要），只有一处有意差异：`timeout` 为 `"nan"` 时 Python 得到 NaN 秒（`subprocess.run` 行为未定义），TS 改用上限；对照测试不含这一项。
- 并行读批次与串行调用分批执行，所以 Read 的 PostToolUse 会先于后面 Bash 的 PreToolUse，和 Python 的执行顺序一致。
- PermissionRequest 最初只认 `permission_denied`，补上 `approval_required` 和 `plan_mode_denied`，与 Python `permission_result` 的三种 `denied` 对齐。

**剩余差异**

- ZCode 的 `type: "command"`（shell 字符串）hooks、插件 hooks、异步 hooks、`additionalContext` 注入、`updatedInput` 改参、hook 放行、Stop 续跑、UserPromptSubmit 拦截都没做（Python 也没有）。
- ZCode 的 hook stdin 字段（`hook_event_name`、`transcript_path`、`tool_input` 等）没加，stdin 仍是 Python 格式。
- ZCode 的 matcher 对 `a|b` 是精确匹配，Xueness 仍按 Python 正则搜索（`Edit` 也会匹配 `NotebookEdit` 这类名字）。
- pipeline hooks 的结果是 TS 结果形状（`output`、`error.code`），不是 Python 的结果字典。
- hooks 设置页、信任审核 HTTP、`hooks` CLI 仍是 Python（第 7 步）。

## 19. ZCode 对齐第 5 步第 4 轮：子代理迁到 TS（只改 TS 与 webapp 工具名表，2026-10-19）

本轮代码由主代理编写，没有用 Grok。Python 未改动。提交：`1653063`（插件、Agent 合约、子运行器、接线与测试）、`1bc4d6a`（审核修正：子运行独立读状态）→ 合入 main `7bbf65c`、`56057e8`。

**插件**（`plugins/subagents/src/`，fs 读写 state）

- `definitions.ts`：照 Python `subagents.py` 读 `<state>/resources/subagents/<id>.json`（拒链接、坏 JSON、非对象、`enabled: false`、空 id/name；id/name 去空白；按 id 排序），`select`（id/name 精确再大小写不敏感，回落内置 `general-purpose`/`explore`）、`agent_tool_allowlist`（缺省继承、`*` 全部、未知名不授权；另认 ZCode 名，如 `Bash`→`exec`）、`normalize_disallowed_tools`、`clip`、`build_system_prompt`。
- `profiles.ts`：ZCode 内置 `general-purpose` 与 `Explore` 的描述和提示词（产品名替换）、子代理通用 Notes、`<env>` 环境段、强制剔除 EnterPlanMode/ExitPlanMode；已存定义按名字覆盖内置（ZCode `normalizeAgentProfiles`）。`subagent_type` 认 ZCode 名、Python id，以及 Python 的小写 `explore`、`general_purpose`。
- `records.ts`：Python 的子会话布局 `<state>/subagent-sessions/<parent>/<child>.json`（逐级 0700、拒链接、每个父会话最多 100 个子会话），子会话字段与 `delegation` 记录照 `run_subagent`，`recovery_info` 照 `child_sessions.py`；父会话 `task_runs` 行照 `TaskRegistry.record/finish`（只记 `promptChars`，摘要 4000、错误 500 字截断，按 id 合并留最新 100 条），另记 `childSessionId/parentSessionId/rootSessionId/canResume/recoveryReason`；ZCode `formatAgentOutputForModel` 的完成结果文本（去掉 SendMessage 提示）。
- `index.ts`：工具名仍是 `task`（gate `planning`，与 Python 一致；日志、Python、会话投影都按这个名字），模型看到 ZCode 的 `Agent`（`packages/agent/src/tool-contract/agent-contract.ts`：ZCode 描述去掉 SendMessage、后台、工作流三处，schema 是 `description/prompt/subagent_type`，不含 `run_in_background`；`subagent_type`→`agent`）。agent 扩展只在请求允许委派时保留 `task`；标准运行时每次请求在系统提示词后插入 ZCode 的 `agent_listing_delta` 提醒（`Available agent types for the Agent tool:`，全量重建，不进日志，压缩后照样在），Explore 列出子运行实际拿得到的工具。

**子运行**（`apps/server/src/agent-subagents.ts`，照 Python `runner.run_subagent`）

- 前台、同一内核和工作区，`plan` 权限上限（只读命令可跑，写、改、MCP、网络和非只读命令都拒），批准器一律拒绝（子代理不能问人），独立的读文件状态。子运行看不到也调不了 `task`、计划模式切换、`ask_user`、待办和交付计划（这几个作用在父会话上），以及 Python 的 `workflow_create/amend`；父运行禁用的工具、定义里的 `disallowedTools` 也去掉；定义的 `tools` 是白名单。
- 上限照 Python：4 步、120 秒、提示词 1–24000 字；父运行停止时子运行在下一个边界停下，子会话记 `stopped` + `delegation.cancelled`，结果 `cancelled`。定义里的 `providerId/model/reasoningEffort` 照 Python 叠在父会话的模型选择上，用服务的 `resolveProvider` 解析。
- 结果：成功时 `output` 是 ZCode 文本（子代理最后一条消息、`agentId: task-…`、`<usage>`），另带 `task_id`、`agent`（Python 的定义 id，没点名时为 null）、`steps`、`childSessionId`、`summary`；失败按 Python 文案（`sub-agent ended with status …`、`sub-agent run failed`），错误码用 ZCode 的 `agent_unknown_type`、`agent_child_runtime_failed`。

**路由**：`allow_subagents` 现在要的是 `subagents.tasks`（TS 声明），不再整轮回退；`subagent_coordination` 里有未收集的任务时 `configuredAgentFeatures` 和 `agentSupport` 都要 `subagents.coordination`，仍交给 Python。插件 reconcile 列表补上 `subagents`。webapp 工具名表加 `task`↔`Agent`。

**测试**：`plugins/subagents/test/subagents-python.test.ts` 用一套夹具（链接、坏 JSON、数组、禁用、空 id、NaN、非 `.json`）对照 Python 的 load、select（14 个选择器）、allowlist、disallowed 规则、clip、build_system_prompt、摘要选择和 `recovery_info`；`subagents-zcode.test.ts` 改写 ZCode `agent-listing.test.ts`、`tool-contracts.test.ts` 的清单与结果文本用例，并测 Agent 合约、适配器和扩展；`apps/server/test/agent-subagents.test.ts` 端到端测 Explore 子运行（只读、工具面、清单、结果文本、`task_runs`、子会话文件；Python 的 `ChildStore` 能载入这个子会话，Python 的会话投影能显示这次委派）、已存定义的提示词和白名单、未允许委派时没有 Agent、未知类型、父运行停止、未收集的 Python 后台任务仍回退。

**验证**：main `56057e8` 上 ts `npm run check` 通过（行数门禁 525 个文件，最大 400 行；插件门禁 10 个插件、149 个源文件；类型检查；793 项测试，792 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1708/1708。

**审核发现**

- 子运行最初共用父会话的工具环境，子代理 Read 过的文件会让父代理不读就能 Edit；改为子运行独立的读状态（ZCode 子代理也各有 readFileState），并加端到端用例。
- planning 插件的待办、提问、交付计划工具读的是"当前会话"，也就是父会话；子运行一律不给这些工具（Python 的子代理待办写在子会话里，所以 Explore 的 TodoWrite 在这里没有）。
- `select` 对内置回落返回 Python 的小写 id（`explore`），`task_runs.agent` 与 Python 一致；模型看到的类型名仍是 ZCode 的 `Explore`。

**剩余差异**

- 只有前台：`run_in_background`、`task_collect`、`task_resume`、`task_send_message`、ZCode 的 SendMessage 和完成通知都没做；同一条消息里的多个 Agent 调用按顺序跑（所以清单里去掉了 ZCode 的并发提示）。未收集的 Python 后台任务仍回退。
- `inherit_history: true` 直接报错（Python 支持复制父会话上下文）；轻量运行时下 `task` 保留 Python 名、不插清单。
- 子运行的工具调用不触发 pipeline Post hooks，hooks 插件为这些调用记下的 id 不会清掉（只占内存）。
- 子代理的 Bash 后台任务在子运行结束后不会被收回。
- 子代理设置页、子会话记录 HTTP、单个任务取消接口仍是 Python。

## 20. ZCode 对齐第 5 步第 5 轮：记忆迁到 TS（只改 TS，2026-10-19）

本轮代码由主代理编写，没有用 Grok。Python 未改动。前一个执行者写好插件和测试后被打断，接手者审核、修正后提交。

**插件**（`plugins/memory/src/`，fs 只读 any，不带工具）

- `memory.ts`：照 Python `bundled_plugins/memory/memory.py` 只读加载三条轨：`<root>/MEMORY.md`、`USER.md`、`projects/<sha1(cwd)[:12]>/KEY.md`。条目按 `\n§\n` 切分，去掉 frontmatter、HTML 注释、`[id:…]`、`[YYYY-MM-DD]`、`[branch:…]`、连续的 `[git …]` 前缀和行首项目符号，渲染成 `- ` 条目；每轨预算 2500/1500/4000、总计 12000 字，按码点计（Python `len`），`\s`、`\d` 照 Python 的 Unicode 语义。轨道文件解析后必须在记忆根内（链接逃逸、目录、非 UTF-8、读不了的一律当空），什么都不写。存储格式与 dsh-grok-memory 字节兼容，旧数据原样读取。
- `index.ts`：`memoryExtension`（能力 `memory.context`）。记忆根取 `XUENESS_MEMORY_ROOT`（去空白，空串视为未配，同 `memory_api.memory_root`）；设置 `general.memoryEnabled === false` 或插件关闭时不注入（同 `catalog.load_run_memory`）。每轮开始读一次，只进请求视图、不进日志：
  - 标准运行时：系统提示词后插一条 ZCode `relevant_memory` meta-user 提醒，开头是 ZCode `formatRelevantMemoryAttachment` 的「Retrieved for possible relevance — …」，接 Python 的不可信前言和记忆正文；`wrapSystemReminderForSource` 转义，存储文本闭合不了提醒。
  - 轻量运行时：Python 的 injected 块（`UNTRUSTED_PREAMBLE` + 记忆），排在工作区说明之后、技能目录之前。
  - 召回重置（第 4 步挪来，ZCode `resetProjectMemoryRecall` 在压缩和 resume 后调用）：日志里的压缩边界（ZCode `_compact_summary`、语义压缩 `_semantic_summary`、确定性「Older history compacted」行）一变就从磁盘重读；新一轮（含 resume）也重读。
- 接线：`apps/server` 加依赖和 bundled 插件；`agent-service` 声明 `memory.context`，不再因记忆整轮回退；扩展顺序改为 记忆 → 技能 → 轻量视图（见审核发现）。

**测试**：`plugins/memory/test/memory-python.test.ts` 用一套夹具（BOM、CRLF、阿拉伯-印度数字日期、全角空格、Python 独有空白、emoji 截断、链接根、链接逃逸、目录轨、非 UTF-8、缺失根、带空白的根）对照 Python 的 `project_hash`、`clip`、`render_track`、`load`（含自定义预算和 label）、`memory_root` 与 `load_run_memory`；`memory-zcode.test.ts` 测 relevant_memory 提醒的位置与转义、一轮一读、三类压缩的召回重置（含原地替换摘要）、轻量 injected、关闭/未配/空根不注入；`apps/server/test/agent-memory.test.ts` 端到端测 TS 服务不回退、提醒内容、不落盘、`memoryEnabled:false` 与插件关闭、轻量运行时记忆在技能目录之前。

**验证**：分支与 main 上 ts `npm run check` 通过（行数门禁 531 个文件，最大 400 行；插件门禁 11 个插件、151 个源文件；类型检查；801 项测试，800 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1708/1708。

**审核发现**

- 召回重置原先用 `_compact_summary` 的个数和最后位置判断边界；ZCode 第二次压缩会把旧摘要原地换成新摘要，个数和位置都不变，于是不重读；也漏了语义压缩和确定性压缩的边界行。改为按边界行对象身份（加 `_message_id` 与长度）判断，三类各加一例。
- 技能扩展原先排在轻量运行时视图之后，视图已经消费了 `injected`，轻量运行时下技能目录其实没送到模型（把顺序改回去，端到端用例即失败）。现在记忆、技能都在视图之前，顺序同 Python（说明、记忆、技能）。

**剩余差异**

- 只迁了 Python 的只读注入。ZCode 的模型驱动记忆（记忆目录与 MEMORY.md 索引、manifest + selector 语义召回、extraction 写入、dream 整理、按路径失效）都没做：它们需要后台模型调用并写记忆目录，与 Python 只读轨的设计不同，留待评估。
- 标准运行时的提醒固定放在系统提示词后、每次请求重建（ZCode 作为附件跟在用户消息后，只注入被选中的条目）。
- 子代理不带记忆（与 Python 子运行一致）。
- `/api/memory` 编辑器、工作区列表、`operator_cli` 仍是 Python（第 7 步）。

## 21. ZCode 对齐第 6 步第 1 轮：Office 文档迁到 TS（只改 TS，2026-10-19）

本轮代码由主代理编写，没有用 Grok。Python 未改动。ZCode 的四个文档包（documents/pdf/presentations/spreadsheets）都是技能包，没有 TS 运行时代码可抄，所以本轮移植的是 Xueness 自己的 Python office 插件（`bundled_plugins/office/tooling.py`、`office_preview.py`），ZCode 技能包放第 3 轮作为随附技能。

**插件**（`plugins/office/src/`，fs 读写 workspace，依赖 files，19 个源文件，最大 227 行，无第三方依赖）

- 容器与 XML：`zip.ts`（只读 stored/deflate，成员数、解压量有上限，`KeyError` 文本照 Python repr）、`xml.ts`（够 OOXML 用的命名空间 XML 解析，拒 DTD/实体，错误文本照 expat，含「unclosed token」等）。
- 读：`read.ts` 照 `_read_office`（docx 段落与表格、pptx 幻灯片、xlsx 工作表，与 python-docx/python-pptx/openpyxl 的读取结果一致）；PDF 由 `pdf-objects.ts`、`pdf-document.ts`、`pdf-text.ts`、`pdf-read.ts` 实现，照 pypdf 的布局：经典/流式 xref、`/Prev` 与 XRefStm 链、对象流、Flate（含预测器）/ASCII85/ASCIIHex，ToUnicode、UCS2、cp1252+Differences，按字宽算位置决定换行与空格。上限照 Python：100 页、16 MB 解压、每页 1 万字、总计 40 万字；加密 PDF 报「encrypted PDFs are not supported」。
- 写：`ooxml-write.ts`（docx）、`write-pptx.ts`、`write-xlsx.ts`、`pdf-write.ts` 生成的文件在两个后端读回一致，Python 读得出 TS 写的，TS 也读得出 Python 写的；版面照 python-docx/python-pptx/openpyxl/reportlab 的输出（A4、页边距、标题/小标题/正文字号与行距、STSong-Light + UniGB-UCS2-H 字宽表，所以 pypdf 抽出来的换行和空格相同）。`document.ts` 照 `_document_object` 校验，错误文本全部照 Python。
- 工具：`tools.ts` 照 Python 的 `office_read`（read 门）、`office_create`（write 门）、`office_replace`（edit 门）：路径照 `_target`，O_NOFOLLOW 读，进程内路径锁（忙时 `{ok:false,conflict:true,error:"path busy"}`），原子写（0600 临时文件、link/rename、目录 fsync），读证明存在 `session._office_read_proofs`（最多 20 条，顺序照 Python），结果用 `pyJsonDumps`。`schemas.ts` 把 Python 的工具 schema 原样给模型。
- 预览：`preview*.ts` 照 `preview_bytes(include_full_document=False)` 出有界 DTO（嵌入图片校验魔数、计入预算，链接与公式不执行）。目前没有 HTTP 路由用它，`/api/sessions/<id>/file` 仍在 Python（第 7 步）。
- 接线：`apps/server` 加依赖和 bundled 插件；`agent-service` 注册三个工具（`knownTools`、reconcile 列表），声明 `office.delivery`，`checkDelivery` 的 `officeText` 钩子接 `deliveryContentText`。交付清单里有 `.docx/.xlsx/.pptx/.pdf` 时不再整轮回退 Python。插件门禁 11 → 12 个插件。

**测试**（`plugins/office/test/`，`oracle.ts` 批量调 Python 插件；没装 `desktop/requirements-office.txt` 时跳过）

- `office-python.test.ts`：合法和非法文档各一组，对照 Python 的构建错误、双向读回（TS 写 Python 读、Python 写 TS 读）、交付文本；还有恶意和截断的输入。
- `office-preview.test.ts`：两个后端写出的三种包，加上非 zip、DTD 实体、坏 XML、截断、扩展名大小写、嵌入图片（有效 PNG、假 PNG、路径穿越、外链、缺失成员），预览 DTO 与 Python 逐字段相同。
- `office-tools.test.ts`：37 步工具流程（创建、覆盖、读证明、替换、冲突、权限、符号链接等），对照 Python 的 `_read/_create/_replace`。
- `office-tools-unit.test.ts`：移植 `tests/test_office_tools.py`，以及 ZCode `core/tests/read-pdf.test.ts` 里的非普通文件、大小上限、缺 `%PDF` 头三例，外加 PDF 文本操作符。
- `office-delivery.test.ts`：`checkDelivery` 带 `officeText` 对照 `test-support/python/delivery_oracle.py`。
- `apps/server/test/agent-office.test.ts`：端到端，TS 服务不回退；模型调 `office_create` 写 docx、`office_read` 读回，交付检查 `contains` 通过（`delivery_status: passed`）；插件关闭时不要求 `office.delivery`。

**手工验证**：LibreOffice 能打开 TS 生成的 docx/pptx/xlsx 并转 PDF；`pdftotext`、`pdfinfo` 能读 TS 生成的 PDF；LibreOffice 写出的 docx/pptx/xlsx 预览两边相同。

**验证**：分支与 main 上 ts `npm run check` 通过（行数门禁 558 个文件，最大 400 行；插件门禁 12 个插件、171 个源文件；类型检查；816 项测试，815 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17，装有 office 依赖，Office 对照用例实际运行）。webapp `npm run typecheck` 通过，`npm test` 1708/1708。

**审核发现**

- 只把 `office.delivery` 加进服务的能力集合不够：运行器的 `agentSupport` 只认扩展声明的能力，真实运行在第一次请求前就报 `agent_backend_required`（`supports()` 却返回 true）。端到端用例发现的；加了一个 id 为 `office` 的空扩展声明该能力，由插件开关控制。
- 坏 XML：输入在开始标签里结束时 expat 报「unclosed token」，TS 原来报「invalid token」；`</ a>` 这种结束标签 expat 报 invalid token，TS 原来报 mismatched tag。都已照 expat 改，预览用例覆盖。
- 工具参数经过 `pyJsonLoads`（非无损）解析，`1e16` 到 TS 是整数；改为不安全整数一律当浮点数，xlsx 的 `1.5e100` 错误文本与 Python 一致。
- `str.splitlines` 会在 `\u0085`、`\u2028` 处切行，Python 插件实际按 `\n` 处理；TS 改为只切 `\n`。openpyxl 对全是 None 的行也写空 `<row>`，TS 照做。
- pypdf 会在居中标题前加空格，多行居中时也会；TS 改成按位置判断空格，并照 reportlab 用相对 `Td` 居中，两边抽出的文本相同。

**剩余差异**

- 别家生成的 PDF：LibreOffice 的 PDF 基本与 pypdf 一致，仍有小差（中英文块之间多一个空格、个别双空格）。
- 坏 XML 错误不带 expat 的「: line N, column M」位置后缀（测试里去掉后缀再比）。
- 工具参数里 ≥2^53 的整数字面量 TS 接受、Python 拒绝（解析是有损的）。
- 生成的包比 Python 模板精简：没有缩略图、settings、numbering 部件；docx 的 List Bullet/List Number 样式没有编号定义（读回文本相同，Word 里不显示项目符号）。
- PDF 写入遇孤立代理项时错误文本不同。
- TS 清单没有 `frontendModules`（同其他 TS 插件，`OfficeDocumentRenderer.tsx` 仍由 Python 清单拥有，第 7 步再迁）。
- `read` 工具读 PDF、图片、视频仍不支持，留第 7 步（需要工具结果带图片/文档块）。
- Office 预览 HTTP 路由在 Python（第 7 步）。

## 22. ZCode 对齐第 6 步第 2 轮：浏览器迁到 TS（只改 TS，2026-10-19）

本轮代码由主代理编写，没有用 Grok。Python 未改动。ZCode 的浏览器（`pkgs/browser-use-plugin`、`core/browser-client/`、`pkgs/node-repl-host`）是让模型在 node REPL 里写任意 JS 驱动 IAB/CDP，和 Xueness「不执行模型给的 JS、每个动作单独批准」的安全模型相反，所以本轮移植的是 Xueness 自己的 Python 浏览器插件（`bundled_plugins/browser/plugin.py`、`snapshot.py`、`runtime.py` 与 `bridge.mjs`），ZCode 的 browser-client 用例不适用（见「剩余差异」）。

**插件**（`plugins/browser/`，exec + state 读写，依赖 files，6 个源文件，最大 150 行，无第三方依赖）

- `bridge.mjs`：Python 的 worker 原样复制，测试保证与 `xueness/bundled_plugins/browser/bridge.mjs` 字节一致（目录深度相同，开发时同样找 `webapp/node_modules/playwright`；桌面版仍由 `XUENESS_DESKTOP_PLAYWRIGHT` 指定）。
- `worker.ts` 照 `_BrowserBroker`：`$XUENESS_DESKTOP_NODE|node bridge.mjs <profile>`，cwd 为工作区；环境去掉名字含 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL 的变量，桌面 node 加 `ELECTRON_RUN_AS_NODE=1`；JSON 行协议，请求 100 KB、响应（含换行）1 MB、启动 25 s、调用 45 s，调用串行；超限、超时、坏 JSON、非对象、`ok` 不是布尔、进程退出都关掉 worker，错误文本照 Python（`browser worker returned invalid output` 等），下次调用重启。资料目录照 `managed_profile` 与 broker 的检查（`<state>/browser-profile`、不经链接、0700）。进程用插件作用域的 `ctx.spawn` 起，整组随作用域结束。
- `registry.ts` 照 `_BROKERS`：每个 state 目录一个 worker，所有会话环境共用；`shutdown` 等在途调用结束再关。`heldElsewhere`：资料目录的 Chromium 单例锁（POSIX `SingletonLock` → 本机 hostname-活着的 pid；Windows `lockfile` 打不开）被别的进程（Python 侧栏标签的 worker）持有。
- `tools.ts` 照 `_call`/`REGISTRY`：六个工具同名、同 schema（`additionalProperties:false`）、同描述、`exec` 门、click/fill 为 mutating、都不并发；审批 subject 是 `{"action":…,…args}` 的 sort_keys 紧凑 JSON（subjectKind text，不走命令只读判定）；navigate 照 `urlsplit` 预检（https、有主机、无用户/密码、≤4096 字，含 C0 剥离、`\t\r\n` 删除、方括号 IPv6/IPvFuture 校验、NFKC 检查），selector 1–1000、fill 文本 ≤5000（按码点）；截图按 CPython 3.11 `b64decode(validate=True)`（严格模式）复核、PNG 魔数、≤450 KB 并规范化；快照照 `format_snapshot`（`snapshot.ts`：200 节点、24 层、名字 120、12000 字、扫描 5000，Python `\s` 与 Unicode `\d`，截断标记逐字相同）。结果 `pyJsonDumps` 后给模型；worker 的 `{ok:false}` 原样返回，错误码 `execution_error`。
- 接线：`apps/server` 加依赖和 bundled 插件；`agent-service` 注册插件（per-state worker）、`knownTools` 带上 6 个工具（`browser:false` 时照 Python 进 disallow），reconcile 列表加 browser（关插件即关 worker）。`agent-features` 删掉 `browser.tools` 整轮回退；只在 Python 的 worker 正占着资料目录、且这轮显式开了浏览器时要 `browser.python_worker`，路由留 Python（已在 TS 上跑的轮次不会被中途打断）。
- 资料目录交接（`apps/server/src/browser-handoff.ts`）：前门转发 `POST /api/browser/tabs/<id>/action`、`/api/browser/data`、`/api/browser/profiles` 之前，先等 TS worker 的在途调用结束再关掉它，让 Python 能打开、替换或清空资料目录；TS 有运行中的轮次时，清数据与导入资料照 Python 对自己运行中任务的做法返回 409（`stop running tasks before clearing browser data` / `tasks_running`），其余校验仍由 Python 给出。

**测试**

- `plugins/browser/test/browser-python.test.ts`（Python 对照，`oracle.ts` 批量调 `plugin._call`/`format_snapshot`）：快照 172 例（固定用例 + 随机树：空白/控制字符/emoji 名字、非法角色与 ref、Unicode 数字 ref、深度/节点/字符/扫描上限、上报总数与截断）；navigate/selector/text 68 例（scheme 大小写、用户信息、IPv6/IPv4/IPvFuture 方括号、全角 `＃`、℀、超长、非字符串）与 Python 判定一致、命令与审批 subject 一致；截图/快照整形 12 例；b64 严格模式 27 例；subject 编码；工具名、schema、描述、门、标志。
- `plugins/browser/test/browser-worker.test.ts`（假 bridge `fake-bridge.mjs`）：同一 worker 持久复用、命令原样、环境无凭据；参数错误不起 worker；6 类协议故障各自关 worker 且下次重启、恰好 1 MB 的响应可收；请求超 100 KB 拒绝但 worker 不停；启动失败的 5 种原因文本；不安全资料目录（文件、链接、state 是链接）；两个会话共用 worker、shutdown 后重启；`heldElsewhere`（活锁、死 pid、别的主机、自己的 worker）；命令与环境构造；bridge 字节一致。移植自 `tests/test_browser_snapshot.py`、`test_parity_browser.py`、`test_browser_runtime.py`、`test_browser_bridge.py` 的对应断言。
- `apps/server/test/agent-browser.test.ts`：端到端，TS 服务不回退，模型 navigate → snapshot，worker 跨调用常驻、`dispose` 后停；build 模式每个动作要批准、批准前不起 worker，`browser:false` 时调用被拒；Python 持有资料目录时显式浏览器轮次路由 Python、已在 TS 的轮次照常完成；关插件即关 worker；前门交接与 409。
- `bundled-plugins.test.ts`：默认关闭的插件（browser，同 Python 默认关）也显式开启检查授权与工具；插件门禁 12 → 13。

**手工验证**：box 上用真 Chrome（`XUENESS_BROWSER_EXECUTABLE=/usr/bin/google-chrome`）跑 TS 插件：原版 bridge 因 box DNS 是 FakeIP（198.18.0.0/15）按设计拒绝所有导航；用去掉该网段的临时副本，navigate/snapshot/click/inspect/screenshot 在 example.com 上都正常，`https://127.0.0.1/` 仍被拒。

**验证**：分支与 main 上 ts `npm run check` 通过（行数门禁 569 个文件，最大 400 行；插件门禁 13 个插件、177 个源文件；类型检查；836 项测试，835 通过、1 项 Windows ACL 跳过、0 失败；`XUENESS_PYTHON` 为 uv 的 CPython 3.11.17）。webapp `npm run typecheck` 通过，`npm test` 1708/1708。

**审核发现**

- `base64.b64decode(validate=True)` 在 3.11.17 是 `a2b_base64(strict_mode=True)`：完整四元组后多余的 `=` 接受、`AAA==` 拒绝，和系统 3.13 不同；TS 按门禁用的 3.11 实现，对照覆盖。
- `browser.python_worker` 起初在每次模型请求前都重算，侧栏中途占用资料目录会让已在 TS 上的轮次报 `agent_backend_required`；改为只在路由时判定（运行器声明该能力），对应用例覆盖。
- 运行器只认扩展声明的能力（第 21 节同一问题），`browser.python_worker` 也由一个 id 为 `browser` 的空扩展声明。
- bundled 插件测试默认按 `defaultEnabled` 启动，browser 默认关会被跳过；测试改为全部显式开启。

**剩余差异**

- 侧栏标签（`/api/browser/tabs`）、远程连接的浏览器标签、Chrome 资料导入、浏览器数据清理和运行环境检测仍在 Python（第 7 步）；它们和模型工具不能同时占用资料目录，交接方向是「TS 让给 Python」：Python 的 worker 起来后要到 Python 关掉它（关插件、清数据、导入、重启）为止，显式开浏览器的轮次都走 Python。远程连接的标签动作不经前门，TS worker 在跑时 Python 那边会报 worker 不可用。
- 运行中停止不会中断正在等待的浏览器调用（最多 45 s），与 Python 相同。
- 构建产物 `dist/` 里 bridge 的默认 Playwright 相对路径不对（同 Python 冻结包），桌面版靠 `XUENESS_DESKTOP_PLAYWRIGHT`。
- 截图仍以 data URL 文本进入工具结果（同 Python）；工具结果带图片块留第 7 步。
- ZCode browser-client 的 IAB/CDP、node_repl、录屏、tab claim、turn-tail 截图等不对齐（安全模型不同），列入待决定。
- worker 回传 JSON 里 `1.0` 这类浮点等级 Python 视为非整数、TS 视为整数（worker 实际只写整数）。

## 23. ZCode 对齐第 6 步第 3 轮：网络工具迁到 TS，随附 ZCode 文档技能包（只改 TS，2026-10-19）

本轮代码由主代理编写，没有用 Grok。Python 未改动。

**网络插件**（`plugins/network/`，net `*:443` + state 只读，15 个源文件，最大 178 行，无第三方依赖）

- 移植 Python `bundled_plugins/network`（`tooling.py`、`transport.py`、`search_settings.py`、`search_services.py`、`search_model.py`）：`web_fetch`、`web_search`、`image_search` 三个工具同名、同描述、同 schema；`web_fetch` 走 `web_fetch` 门，另外两个走 `web_search` 门，审批 subject 是 URL 或查询原文。
- 传输照 `transport.py`：只连 HTTPS 443；所有解析记录都要过公网 IP 检查（SSRF 拦截）；连接钉在检查过的地址上，TLS 仍校验请求的主机名；只有系统 DNS 全是 FakeIP（198.18.0.0/15）时才用设置里明确配置的 DoH；不跟随重定向；正文 1 MB、模型请求 64 KB、响应 512 KB、DoH 64 KB；错误码和中文提示逐字照 Python。HTML 转文本照 `transport._Text` 与 `html.unescape`，主机名照 Python IDNA 2003（含 stringprep 表）。
- 设置只读：`<state>/network/settings.json` 和属主私有的 key 文件，环境变量兜底。旧配置原样可用；保存设置和诊断路由（`/api/network/*`）仍在 Python。
- 搜索：Tavily / Brave / SearXNG 适配、独立 OpenAI 兼容搜索模型、`image_search` 有界结果与来源链接，结果整形照 Python。
- 查询非法（空、纯空白、超 1000 字）时照 Python 在批准前拒绝。为此 `engine-tools` 的 `ToolDefinition` 新增可选的 `precheck`，`tool-bridge` 在 schema 校验后、权限判定前调用它。
- ZCode 对齐：采用 `core/src/tool/handlers/webfetch-cache.ts` 的 15 分钟缓存（总量 50 MB，LRU）。只缓存成功的 `web_fetch`，每次调用仍要先批准，命中时结果带 `cacheHit: true`。插件关闭时清空缓存。所有连接先过插件的 `net.connect` 授权（`ctx.guard`）。
- 接线：`apps/server` 加依赖和 bundled 插件；`agent-service` 注册 `createNetwork({ stateDir })`，`knownTools` 带上三个工具，reconcile 列表加 network。此前 TS 原生运行静默缺这三个工具，现在 TS 上可用。web 端本来就拒绝 `allow_network` 这类整体批准，所以 TS 上逐次批准与 Python 一致；yolo 照 Python 直接放行。工具名与结果 JSON 不变，带着 Python 时期 `web_fetch` 调用的旧会话可以在 TS 上接着跑。

**ZCode 文档技能包**（`plugins/skills/bundled/`）

- 随附 ZCode v3.15.1 `apps/zcode-cli/packages/` 下的 `documents-plugin/skills/docx`、`pdf-plugin/skills/pdf`、`presentations-plugin/skills/pptx`、`spreadsheets-plugin/skills/xlsx`，共 109 个文件，Apache-2.0，`LICENSE.txt` 保留。改动只有两处：
  - frontmatter 的 `license: Proprietary…` 改成与 `LICENSE.txt`、`package.json` 一致的 `Apache-2.0`；
  - 「Final response citations」一节原用 ZCode 客户端专用的 `::zcode-file-citation{…}` 指令，改写为按绝对路径引用文件（来源注明已核对的页、幻灯片或工作表区域）。
  其余脚本与参考资料原样保留。ZCode 的 `visual-judge` 评审 agent 不带。
- 技能插件新增 `bundled` 来源，优先级最低（project > project-compat > user > resource > bundled），同名的用户或项目技能会遮蔽它，jail 是包目录本身。`discover`、`listAll`、`loadSkill`、`createSkills`、`skillsExtension` 多一个可选的 `bundled` 参数，默认 null 时行为与 Python 完全一致（对照测试不变）。`agent-service` 传入 `BUNDLED_SKILLS_DIR`，所以 TS 运行的技能清单和 `Skill`/`skill_read` 能看到并加载这四个技能，结果给出包内的 Base directory。
- `visualize` 不带：它依赖 ZCode 客户端的 `window.zcode.*` 小部件运行时（Gen UI 沙箱 iframe），Xueness 前端还没有这个运行时，留第 7 步。

**测试**

- `plugins/network/test/network-python.test.ts`（Python 对照，`oracle.ts`，共 4 项）：
  - HTML 转文本与 unescape：406 例，含随机拼接；
  - URL、IP、IDNA 检查；
  - 工具表；
  - 112 个整次工具调用：脚本化 DNS/HTTPS 覆盖 FakeIP+DoH、SSRF、状态码、内容类型、超限、三种搜索服务、搜索模型、图片搜索、设置文件。
  均与真 Python 一致。
- `apps/server/test/agent-network.test.ts`（共 4 项）：
  - TS 服务提供三个工具，非法输入得到 Python 结果 JSON，不发起网络请求；
  - build 模式按 URL 请求批准，空查询在批准前就被拒；
  - `disallowed` 生效，关插件后不再提供；
  - 带 Python 时期 `web_fetch` 调用的旧会话能在 TS 上完成。
- `plugins/skills/test/skills-bundled.test.ts`（共 3 项）：
  - 四个技能都被发现且校验通过，许可为 Apache-2.0，加载不截断，没有 zcode 专用语法；
  - 优先级最低，可被用户或项目技能遮蔽，Base directory 指向包内；
  - 不传 bundled 根时与 Python 一致。
- `bundled-plugins.test.ts` 通过（Python Gate 与标志对照包含三个网络工具）；插件门禁从 13 个插件变为 14 个。

**验证**：分支与 main 上 ts `npm run check` 都通过：
- 行数门禁：589 个文件，最大 400 行；
- 插件门禁：14 个插件，192 个源文件；
- 类型检查通过；
- 测试 847 项：846 通过，1 项 Windows ACL 跳过，0 失败。`XUENESS_PYTHON` 用 uv 的 CPython 3.11.17。

webapp `npm run typecheck` 通过，`npm test` 1708/1708。

**审核发现**

- `BUNDLED_TS_PLUGINS` 的顺序要与插件目录清单一致，否则 bundled 插件测试的工具注册顺序断言失败。network 已排在 memory 与 office 之间。
- 首版留下了 `test/fixtures/*.pem`（测试 CA、证书、私钥），没有被任何测试引用，而且被根 `.gitignore` 的 `*.pem` 忽略。已删除，不入库。
- ZCode 技能 frontmatter 写着 `Proprietary`，但同目录的 `LICENSE.txt` 与 `package.json` 都是 Apache-2.0，而 frontmatter 自己也写明以 `LICENSE.txt` 为准。随附副本已改为 Apache-2.0，NOTICE 中说明。

**剩余差异**

- 模型看到的仍是 Xueness 名字 `web_fetch`/`web_search`/`image_search`。ZCode 的 `WebFetch {url, prompt}` 会用辅助模型按 prompt 处理页面，还有预批准域名、出站限制；它的 `WebSearch` 契约没有接成 ZCode 名字。ZCode 的 image-search 走 Z.AI 账号 MCP，不对齐。
- `/api/network/*`（设置保存、DNS 诊断）仍在 Python（第 7 步）。
- 真实 TLS 路径（`nodeNet`）只在对照里用脚本化网络替身，没有本地 HTTPS 夹具测试；box 的 DNS 是 FakeIP，真连外网要配 DoH。
- 随附技能的脚本由模型通过 Bash/Read 在用户环境里执行。包目录在工作区外，读写和执行照常走批准，安装依赖（python-docx、docx-js、LibreOffice 等）由技能说明引导。
- `visualize` 技能、Gen UI 渲染与 `visual-judge` 评审 agent 留第 7 步。Python 运行时不列随附技能。

## 24. ZCode 对齐第 7 步第 1 轮：设置与工作区迁到 TS（只改 TS，2026-10-19）

本轮代码由主代理编写，Python 未改动。第 7 步拆成 10 轮（路线图第 3 节），这是第 1 轮。

**设置插件**（`plugins/settings/`，apiVersion 2，exec `osascript`，fs 读 any、写 state，7 个源文件，最大 252 行，无第三方依赖）

- 移植 Python `bundled_plugins/settings` 的 `preferences.py`、`settings_store.py`、`workspaces_api.py` 和 `plugin.py` 的 dispatch。另外移植了 `files/directory_api.py` 的 `list_level`（放在 `plugins/files/src/directory-level.ts`，`d_type` 未知时用 lstat 兜底）和 `web.py` 的 `_declared_workspace_roots`。5 个功能项与 Python 清单一致。
- `/api/settings`：GET 读全部或单节，POST 保存单节。
  - 偏好校验照 `preferences.py`，覆盖缩放、字号、tab、主题与配色、语言、终端字体、默认 shell、调用预算、自动归档天数、多绑定快捷键和作用域冲突。
  - 请求体无损解码：`1.0` 和 `1`、大整数、`-0.0`、`1e400` 都按 Python 区分，并原样写回。
  - `settings.json` 逐字节照 Python：`indent=2`、`ensure_ascii=False`，先写临时文件并 fsync，再原子替换。
  - 读到坏 UTF-8、BOM、重复键、NaN 或非对象内容时，回复也照 Python。
- `/api/workspaces`：
  - 路由：摘要（允许列表、最近项目、默认目录）、选择器浏览一层（条目上限取 `XUENESS_BROWSE_MAX_ENTRIES`，默认 1000）、`default`、`confirm`。
  - 授权根照 Python：宿主声明的根（启动参数、`XUENESS_WORKSPACE_ROOTS`、cwd）加上用户选过的根。`/`、家目录、挂载点、临时目录这类过宽的根会被拒绝。
  - `paths.ts` 照 Python 实现了相关路径语义：`expanduser`、`resolve(strict=True)`、`os.access`、`ismount`、`gettempdir`、`which`、`shlex.quote`。
  - 错误码和提示与 Python 逐字一致。`OSError` 文本由 sessions 新增的 `pyOSErrorText` 生成，格式为 `[Errno N] 说明: '路径'`。
- 本机原生文件夹选择（非桌面模式）：
  - macOS 上用 `osascript` 弹选择框，同一时间只开一个，600 秒超时，输出的换行照 Python 处理。
  - 只对回环地址开放：远程客户端 GET 看到 `available: false`，POST 得到 403。
  - 选择框打开期间插件被关闭，选中的目录不会登记。
  - 其他平台照 Python 返回 501。
- 访问控制：settings 插件关闭时，整个 HTTP 面返回 403 `plugin_disabled`；工作区路由还要求 sessions 插件开启。两条都与 Python 相同。

**接线**

- `apps/server`：bundled 插件加入 settings，排在 sessions 之后。`application-api.ts` 在转发 Python 之前先交给 settings 插件，所以设置和工作区两个 HTTP 家族不再转发。会话和附件的允许根、默认目录、最近项目登记改用 TS 的 `Workspaces`；内部桥删去 `workspaces()` 和 `rememberWorkspace`。
- 回环判断改用请求的真实对端：前门把 `req.socket.remoteAddress` 传给 dispatcher。以前请求经前门转发，Python 看到的对端总是本机，远程客户端因此也能拿到原生选择器；现在只有本机请求能用。
- `api-body.ts` 的 `readApiBody` 新增 `lossless` 选项，dispatcher 可以声明哪些路由要无损解码。`main.ts` 传入 `cwd: projectRoot`，`desktop-host.ts` 传入 `env`，所以声明根与 Python 读的是同一组来源。
- contracts 新增 `utf8DecodeErrorMessage`。`pyDecodeUtf8`（strict 和 surrogatepass）报出的 `UnicodeDecodeError` 文本与 CPython 逐字一致，读坏 UTF-8 文件时的错误回复因此也一致。

**测试**

- `plugins/settings/test/store-python.test.ts`：78 个校验用例、17 个请求（比对回复和写出的 `settings.json` 字节）、10 个文件读取，均与真 Python 一致。
- `plugins/settings/test/workspaces-python.test.ts`：45 个请求，均与真 Python 一致。覆盖：
  - 摘要、默认目录、确认；
  - 声明根（对照 `web._declared_workspace_roots`）、过宽根、符号链接、不可读目录；
  - 浏览一层；
  - 原生选择器，用脚本化选择框覆盖取消、选中、不可用、失败、非回环、带初始目录、中途关插件；
  - 桌面模式下的路由归属、插件关闭。
- `plugins/files/test/directory-level.test.ts`：一层目录列表对照 Python `list_level`。
- `packages/contracts/test/py-codecs.test.ts`：新增 UTF-8 解码错误文本对照，22,500 例，0 差异。
- `apps/server/test/application-api.test.ts` 新增 1 项：无损 POST 写出的字节、GET 文本、原生选择器 GET/POST 都与 Python 相同，且没有转发 Python。
- `apps/server/test/prepared-handoff.test.ts`：TS 给出的 `/api/workspaces` 与 Python 相同，最近项目是该根。
- 插件门禁从 14 个插件变为 15 个，`scripts/test/plugin-gate.test.ts` 已同步。

**验证**：ts `npm run check` 通过：
- 行数门禁：601 个文件，最大 400 行；
- 插件门禁：15 个插件，200 个源文件；
- 类型检查通过；
- 测试 852 项：851 通过，1 项 Windows ACL 跳过，0 失败。`XUENESS_PYTHON` 用 CPython 3.11。

webapp 未改动。

**剩余差异**

- 桌面模式下，原生选择器由 Electron 宿主负责，`/api/workspaces/native-picker` 仍交给 Python desktop 宿主，等第 5 轮迁移 desktop 家族。
- 运维 CLI `settings`/`settings-set`（`operator_cli.py`）仍是 Python，第 9 轮随 TS CLI 迁移；onboarding 也还在 Python（第 5 轮）。
- Python 侧仍有写 `settings.json` 的地方，例如 git clone 登记目录、providers 默认选择、回退到 Python 的会话登记。两个进程都整文件原子替换，文件不会写坏；但两边几乎同时写时，后写的会覆盖先写的改动。Python 原本也只在进程内加锁。
- Windows 上 Python 以文本模式写文件，换行是 CRLF，TS 写 LF。两边都能读对方写的文件。
- 仍在 Python 的插件（git、hooks 信任、browser 标签、memory、remote 等）照旧通过 Python 的 `workspaces_api` 读同一个 `settings.json`，授权结果与 TS 相同。

## 25. ZCode 对齐第 7 步第 2 轮：composer 与命令迁到 TS（只改 TS，2026-10-19）

本轮代码由主代理编写，Python 未改动。这是第 7 步的第 2 轮。

**命令插件**（新插件 `plugins/commands/`，`@xueness/plugin-commands`，apiVersion 2，fs 读 state/workspace、写 state，8 个源文件，最大 175 行）

- 移植 Python `bundled_plugins/commands` 的 `commands.py`、`file_commands.py`、`builtin_prompts.py` 和 `files_api.py`。
- 命令来源按 Python 的顺序合并：聊天内建命令、内建提示词（`/init` 等，按界面语言选文本）、项目 `.xueness/commands`、兼容的 `.zcode/commands`、用户 `state/commands`、资源存储。遮蔽关系、保留名（含插件清单声明的命令名）、frontmatter（折叠块、字面块、BOM、CRLF）、文件大小和数量上限、诊断文本都与 Python 一致。
- `/命令` 展开：支持 `$1…`、`$ARGUMENTS` 替换，结果最多 8000 字符，从不执行 shell。
- HTTP 路由：
  - `GET /api/resources/commands/files`：在工作区围栏内列出合并后的命令行、诊断和上限。
  - `GET/POST/PUT /api/resources/commands`、`PATCH/DELETE /api/resources/commands/<id>`：通用资源存储，代码移到 sessions 包的 `resource-store.ts`，请求体无损解码，数字写回与 Python 相同。
  - commands 插件关闭时返回 403 `plugin_disabled`。

**composer**（`plugins/sessions/src/composer-*.ts`，7 个文件，最大 175 行）

- `GET /api/composer`：综合目录。包括允许根、隔离根、工作区文件（广度优先，跳过 `.git`、`node_modules` 等目录）、同根会话、技能、生效插件、能力、模型、`allowReal`、未完成工作流数、git 分支。
- `POST /api/composer/prepare`：按 Python `_prepare` 的顺序处理：
  1. 校验请求；
  2. 展开 `/命令`；
  3. 拼接引用的会话、技能、插件和能力上下文，这些块都标为不可信数据；
  4. 处理内联附件（UTF-8 文本、媒体签名校验、ffmpeg 抽视频帧）、工作区文件快照和持久附件引用；
  5. 按所选模型的能力检查附件；
  6. 固定模型选择。

  结果放进一次性缓存：有效 5 分钟，最多 8 条，只能在同一根使用，或者在该根下生成的 `web-runs/<id>` 会话中使用。
- `POST /api/composer/branch`：先检查同根是否有运行中的会话，再切换分支。切换时禁用 hooks，工作区有未提交改动时拒绝。
- 各种错误的状态码和提示文本都与 Python 逐字一致。sessions 插件关闭时，整个 composer 家族返回 403 `plugin_disabled`，与 Python `web.py` 的路由门控相同。
- 能力表和插件上下文用到的工具说明表（47 个工具，`exec` 按宿主系统选说明）是从 Python 注册表生成的快照，放在 `composer-data.ts`。

**配套**

- skills：新增 `readSkill`，与 Python `read_skill` 一致。composer 的技能目录和技能上下文会带上 TS 随附的 docx/pdf/pptx/xlsx 技能，Python 没有这些技能，这是有意的差异。
- git：新增 `branches.ts`，提供 `runGit`、`gitStatus`、`branchCatalog`、`switchBranch`，错误码和文本照 Python `git_api`。
- providers：新增 `composer-models.ts`。它按 id 排序列出已保存的 OpenAI/Anthropic 配置，并加上环境变量配置的模型，同时给出供应商标签、能力和推理档位。

**接线**

- `apps/server/src/composer-features.ts`：把 skills、git、providers、commands 和插件清单的读取函数注入 composer。插件之间不互相 import。
- `application-api.ts` 新增 commands 和 composer 两个 owner，它们的路由不再转发 Python。会话创建和排队消息的 prepared 消费、`/命令` 展开都改在进程内完成。`python-feature-bridge.ts` 删去 `expandCommands`。
- remote 或 subscriptions 插件生效时，`GET /api/composer` 和 `/prepare` 仍转发 Python，因为远程连接和订阅模型的准备还在 Python。这时 prepared 消费先查 TS 缓存，未命中再走内部桥。`/branch` 始终由 TS 处理。

**测试**

- `plugins/commands/test/commands-python.test.ts`：列出、加载、展开（4 种语言、21 段输入），以及资源 CRUD 和链接根，均对照真 Python。
- `apps/server/test/composer-api.test.ts`：共 5 项，与真 Python `composer_api`/`files_api` 逐字节比对。
  - 目录 12 个请求；
  - 准备与消费 35 个请求：成功路径有纯文本、带文件/会话/技能/插件和命令展开、`/init` 加目标、环境模型、图片和文本附件、固定推理档位，其余是各种拒绝；
  - 命令展开 8 段输入；
  - 分支切换：守卫、运行中、未提交改动、真实切换；
  - sessions 插件关闭时的门控。
- `plugins/sessions/test/composer-data.test.ts`：能力表和工具表与 Python 注册表逐项一致。
- `apps/server/test/prepared-handoff.test.ts` 改为经前门对照：TS 的目录（技能除外）和准备结果与 Python 相同；目录、准备、创建都不转发 Python；草稿只能用一次。
- 插件门禁从 15 个插件变为 16 个，`scripts/test/plugin-gate.test.ts` 已同步。

**验证**：ts `npm run check` 通过：
- 行数门禁：624 个文件，最大 400 行；
- 插件门禁：16 个插件，217 个源文件；
- 类型检查通过；
- 测试 861 项：860 通过，1 项 Windows ACL 跳过，0 失败。`XUENESS_PYTHON` 用 CPython 3.11。

webapp 未改动：接口与 Python 相同，现有 composer 界面直接可用。

**剩余差异**

- remote 和 subscriptions 生效时，composer 仍转发 Python，留到第 6 轮迁移或删除这两个插件时处理。Python 的 `/api/composer/expand-command`、`/consume-prepared` 两个过渡路由，随第 10 轮删除 Python 时一起删掉。
- 输入 `/技能名` 仍不会像 ZCode 那样直接调用技能，与 Python 行为一致。
- 分支切换时，"检查运行中会话"和"执行切换"之间没有像 Python 那样持有全局锁。同一进程里，这两步之间如果有新的运行开始，仍可能切换分支。
- 工作流计数只读 `state/workflows`，第 7 轮迁移 workflows 时改为读 TS 的存储。

## 26. ZCode 对齐第 7 步第 3 轮：已迁插件的其余 HTTP 和 extensions（只改 TS，2026-10-19）

本轮只改 `ts/`。Python `xueness/` 未动。delivery/goal 上一轮已经在 TS，没有再迁。

**资源 HTTP**

- hooks：`GET /api/resources/hooks/trust` 读信任文档。`/api/resources/hooks` 的增删改走 sessions 的资源存储。id 为 `trust` 的 PATCH/DELETE 仍是资源存储；`/trust` 上的 POST/PUT 不接管。
- skills：`GET /api/resources/skills/files` 只列工作区技能（`bundled=null`，不列出 TS 随附的 docx/pdf 技能）。其它方法 405。资源 CRUD 同存储。
- mcp：只接管 `/api/resources/mcp`。OAuth、elicitation、`/api/mcp/check`、带清单的 MCP 仍给 Python。
- subagents：只接管 `/api/resources/subagents`。`sessions/*/tasks` 留到第 4 轮。

**设置和文件**

- network：`GET/POST /api/network/settings`，`POST /api/network/diagnostics` 且 body 只能是 `{operation: dns|search}`。诊断不回显供应商原文。
- memory：`GET /api/memory/tracks`、`GET /api/memory/workspaces`、轨道文件的读和确认后写入。空的 `XUENESS_MEMORY_ROOT` 得到 `configured: false`。
- files：`GET /api/system`（家目录）、`GET/POST /api/directory`、`GET /api/sessions/<32hex>/files` 和 `.../file`。其它动词不接管。`/api/home` 仍给 Python。
- Office 预览走现有 `previewBytes`（`include_full_document=False`）。docx/pptx 成功消毒时，Python 还会给 `fullDocument`，TS 没有这段 zip/XML 重写，响应里没有该字段。

**git 和浏览器**

- git：原有 checkpoint 之外，接管 `GET /api/sessions/<32hex>/git/{status,diff,log}` 和 `POST /api/git/clone`。clone 只允许 https/ssh/scp，并登记工作区。插件关闭时，面板和 clone 的 403 比 Python 多一个 `code: "plugin_disabled"`，为了和 checkpoint 共用同一错误体。
- 分支切换的 `GIT_CONFIG_GLOBAL` 和 `core.hooksPath` 改用 Python 的 `os.devnull`（Windows 上是 `nul`）。Node 的 `\\.\nul` 会让 Git for Windows 直接拒绝切换。
- browser：`projectDir` 和 `webRuns` 都在时，标签页由 TS 回答。没有这道围栏时，标签动作仍先放开 worker 再交给 Python。`/api/browser/{runtime,data,profiles}` 始终由 TS 回答。导入资料只在桌面模式；清数据要确认，且有任务在跑时返回 409。

**extensions**（新插件 `plugins/extensions/`，门禁从 16 个插件变为 17 个）

- 接管 `plugins/marketplace`、`plugins/profiles`、`resources/plugins`。`GET /api/plugins` 和 `POST /api/plugins/<id>` 不接管。
- 设置了 `XUENESS_MARKETPLACE_URL` 时，目录只拉取一次。截断或坏 JSON 是 400。`NetworkError` 仍是宿主 500。
- 应用配置档案后，TS 下次请求会重读 `plugin-state.json`。Python 进程里的 `sync_services`（终端、浏览器 worker、调度器）不会因此拆掉，留到 Python 进程退出或第 10 轮。

**这台 Windows 上为了跟 CPython 3.11 对齐而改的旧差异**

- 浏览器 navigate 的括号主机按 3.11 `urlsplit`：`https://a[::1]/` 和 `https://[::1]x/` 都放行。
- 网络 `is_global` / `str(ip)` / HTML 抽取改回 3.11：`192.0.0.0/29`，IPv6 没有 3.13 的例外网段，`::ffff:8.8.8.8` 印成 `::ffff:808:808`，`plaintext` 不是 CDATA。
- 日志里的相对路径，根是 `/ws` 这种 POSIX 根时不再被拼上当前盘符。
- 当前进程不能创建文件符号链接（EPERM）。mcp 加载、Office 工具、apply_patch 这三处在建链接失败时跳过链接本身，其余断言仍跑。整组跳过的 POSIX 用例保持原样。

**验证**：`ts/` 下 `npm run check`，`XUENESS_PYTHON` 指向 CPython 3.11.9：

- 行数门禁：663 个文件，最大 400 行；
- 插件门禁：17 个插件，246 个源文件；
- 类型检查通过；
- 测试 849 项：835 通过，14 项跳过（POSIX shell、符号链接、openssl、ACL），0 失败。

webapp 未改动。

**剩余差异**

- 第 25 节的四条仍在：remote/subscriptions 下的 composer、`/技能名`、分支切换没有全局锁、工作流计数仍读 `state/workflows`。
- 第 24 节的原生选择器、onboarding、`settings`/`settings-set` CLI 仍分别留到第 5 轮和第 9 轮。
- 第 4 轮：MCP OAuth、`elicitation: true`、清单管控的 MCP、`/api/mcp/check`、子代理后台任务（`sessions/*/tasks`）。
- Office 预览没有 `fullDocument`。extensions 不调用 Python `sync_services`，也不做跨进程 flock；Windows 重解析点不按链接处理，回滚时的 OSError 文本对不上 `[Errno N]`。

## 27. ZCode 对齐第 7 步第 4 轮：MCP OAuth、elicitation、清单管控和子代理任务（只改 TS，2026-10-20）

本轮只改 `ts/`。Python `xueness/` 未动。`/api/workflows` 不接管。delivery/goal 没有再迁。`packages/providers/src/http.ts` 未改。

**MCP**

- OAuth（PKCE S256、verifier `token_urlsafe(48)`、state `token_urlsafe(32)`、pending 600 秒、refresh、revoke）和 HTTP `status/start/finish/revoke`。令牌只写在 `<state>/mcp-oauth/<sid>.json`。公开 status 不含令牌。交换失败一律是 `MCP request failed (details suppressed)` 或 `OAuth token exchange failed (details suppressed)`。进程内互斥，没有跨进程 flock。
- HTTP 和 SSE 传输在 `bearer()` 里刷新。`elicitation: true` 时 POST 超时按 600 秒加连接超时。
- `elicitation: true` 的服务由 TS 原生回答。schema、`/api/sessions/<32hex>/elicitation` 和进程内协议都在 `plugins/mcp`。`connect()` 在 `start()` 之前装上 `answerServer`，initialize 才广告 elicitation。无人值守（不是对象、`permission_mode` 或 `mode` 为 `plan`、`read_only is True`、有 parent、id 以 `sub-` 开头）直接拒绝。这个进程没有 TTY，不做 CLI 提问；web 会话停在应答上。RPC `receive` 不等那 600 秒。
- 可读清单按 `plugin_sdk.plan` 决定 mcp 进不进这一轮。清单不可读或只读到一半时仍整轮交给 Python。`resources`/`prompts` 目录动作仍不接管，仍要先 `confirmed is True`。
- 只接管 `POST /api/mcp/check` 这条路径（其它动词在处理器里 405）。插件关闭时整个 `mcp` 家族 403，没有 `code`。`connect is not True` 是 400 `explicit connect approval required`。连上失败或工具列表失败返回 200，`error` 只有 `connection failed` 或 `tool discovery failed`，不回显异常原文。

**子代理任务**

- 接管 `GET /api/sessions/<id>/tasks`，以及长度 6 且动作是 `resume`、`message`、`messages`、`transcript`、`cancel` 的路径。其它动作 `owns()` 为假，Python 还能看见。workflows 不在此列。
- 状态码按 Python：插件关闭是 403 且没有 `code`。`cancel` 在打开会话之前先看方法、空 body 和 `agent.subagentCancelOneEnabled === true`，开关关闭是 403 `single subtask cancellation is disabled`。非法父 id 是 403 `workspace root not permitted`。resume/message 成功是 202。
- 一个进程内 `TaskRegistry` 同时给任务 HTTP 和前台 `task` 子运行。GET 不会把还在这个进程里跑的前台子运行 `restore` 成 `interrupted before result collection`。`cancel_one` 把登记标成 cancelled 之后，子运行在下一步边界停下。
- `TaskCoordinator` 的 dispatch、resume、send、collect、轮次记录和 completion check 在进程内。不把 `subagents.coordination` 写进能力、`supportedCapabilities` 或 `configuredAgentFeatures`。前台 `task` 仍是默认。未收集的后台行仍让整轮交给 Python。
- 没有跨进程 flock，也没有 `session_signals`。`apply_messages` 和 `inherit_context` 没移植。`task_collect`、`task_resume`、`task_send_message` 没有注册到工具面。没有绑定协调器时，HTTP resume 是 409 `start a parent turn before resuming this child`。

**验证**：`ts/` 下 `npm run check`，`XUENESS_PYTHON` 指向 CPython 3.11.9。这次检查包含前台子运行和任务 HTTP 共用登记表的接线。

- 行数门禁：677 个文件，最大 `packages\providers\src\http.ts`（400 行）；
- 插件门禁：17 个插件，255 个源文件；
- 类型检查通过；
- 测试 858 项、200 个套件：844 通过，14 项跳过（POSIX shell、符号链接、openssl、ACL），0 失败。`duration_ms` 185379.7343。

未收集后台任务的那条断言仍是假：`supports(session, {}) === false`。webapp 未改动。

**剩余差异**

- 第 26 节里 Office 预览、extensions、remote/subscriptions composer、`/技能名`、分支锁、工作流计数、原生选择器、onboarding、`settings` CLI 都还在。
- 第 5 轮：terminal（PTY）、tools（干跑和调用预算）、diagnostics（含 `doctor`）、usage、updates、model_monitor、desktop 宿主、onboarding。
- 后台子运行还不能真正被 steer 或 resume，直到宿主绑上 executor。

## 28. ZCode 对齐第 7 步第 5 轮：terminal、tools、diagnostics、usage、updates、model_monitor、desktop、onboarding（只改 TS，2026-10-20）

本轮只改 `ts/`。Python `xueness/` 未动。不接管 `/api/workflows` 和 `/api/workspaces`。没有 `npm install`，没有 node-pty。`packages/providers/src/http.ts` 未改。CLI（`doctor`/`usage`/`update`/`onboarding`/`settings`）和 webapp 不在本轮。

八个插件都进了 `bundled-plugins.ts`，插件门禁从 17 到 25。`node_modules/@xueness/plugin-*` 用目录联接，没有文件符号链接。前门在 `round5-http.ts` 里组装，排在 extensions 之后、provider 回退之前。关闭应用时关掉终端 broker。

- usage：只拥有 `GET /api/usage`。未知 range 回到 `7d`。插件关闭是 403，没有 `code`。
- model_monitor：拥有整个 `/api/model_monitor`。`effectivePlugins` 仍因 `installPackage` 把它判成关闭，避免把 subscriptions 一起打开。HTTP 另用 `modelMonitorEnabled`：marketplace 标记 `xueness-model-monitor`、开关显式为 true、providers 开着，三者都成立才不是 403。默认关闭。没有 `ObservedProvider` 包装，不会自动打模型。
- onboarding：只拥有 `api/onboarding/desktop`。顺序是插件 403、没有桌面宿主 403、desktop 插件关闭 403，然后 GET/POST。POST 只接受 `{completed:true}`。
- diagnostics：拥有整个 `/api/diagnostics`。runtime、export/storage、cleanup。cleanup 要 `confirmed === true` 且天数是 1..3650 的整数。会删已结束工作流日志，不拥有 `/api/workflows`。`doctor()` 只是库，HTTP 不调用它。`runtime.python` 是 `process.version`。
- tools：只拥有 `GET /api/tools/call-budget`。干跑和调用预算默认关。干跑在 `before_tool_execution` 拒绝写/改/执行和带副作用的工具，不先走 Gate。预算是 `<state>/.tools-call-budgets/<sid>.json` 的简化边车，不是 Python 那套执行域账本。
- terminal：拥有 `/api/terminals`。会话带 `remote_connection` 时 409，不打开本地终端，也不拥有 `/api/remote`。最多四个。实现是真实 PTY：`@lydell/node-pty` 的预编译二进制（Windows `conpty.node` + `OpenConsole.exe`，POSIX `pty.node`），装在 `@xueness/engine-tools` 的 `pty.ts` 里，插件本身仍只依赖 `@xueness/*`。预编译缺失的平台回退到 `child_process` 管道，`kind` 字段告诉前端当前是 `pty` 还是 `pipe`。关闭时 PTY 直接 `kill()`，管道仍用 `taskkill /T /F`；宿主退出钩子会杀掉所有活着的 PTY。
- updates：只拥有长度 3 的 `/api/updates`。没有桌面 token 和 bridge 时，GET 是 200 `unsupported`，其它方法 409。`apply`/`check` 导出了，HTTP 不调用，测试也不对 Xueness 仓库 fetch 或 merge。没有接上 Python 的「正在处理的操作」那条原因。
- desktop：只拥有 status（仅 GET）、tray、permissions、permissions/policy、permissions/request、host-capability、host-capability/consume。其它 `/api/desktop/*` 仍交给 Python。托盘成功时第三个元素是 `text/html; charset=utf-8`。宿主能力头 `X-Xueness-Host-Capability` 从前门送进 dispatch。`pickDirectory()` 抛 `PickerUnavailable`，不实现 osascript。

**验证**：`ts/` 下 `npm run check`，`XUENESS_PYTHON` 指向 CPython 3.11.9。这次检查在上述接线之后。

- 行数门禁：718 个文件，最大 `packages\providers\src\http.ts`（400 行）；
- 插件门禁：25 个插件，286 个源文件；
- 类型检查通过；
- 测试 874 项、208 个套件：860 通过，14 项跳过（POSIX shell、符号链接、openssl、ACL），0 失败。`duration_ms` 180472.9865。

未收集后台任务的那条断言仍是假：`supports(session, {}) === false`。webapp 未改动。

**剩余差异**

- 原生目录选择器仍在 `/api/workspaces`。onboarding CLI、doctor/usage/update CLI、`settings`/`settings-set` 留到第 9 轮。
- remote 或 subscriptions 生效时，composer 目录与准备仍转发 Python。`/技能名`、分支没有全局锁、工作流计数仍读 `state/workflows`。
- Office 预览没有 `fullDocument`。extensions 不调用 Python `sync_services`。
- 终端不是 PTY。tools 干跑不经过 Gate。model_monitor 没有包装上游调用。updates 没有「正在处理的操作」。
- 第 6 轮：remote、subscriptions、bots、automation。Z.AI 账号不做。


## 29. ZCode 对齐第 7 步第 6 轮：remote、subscriptions、bots（只改 TS，2026-10-20）

本轮只改 `ts/`。Python `xueness/` 未动。没有 `npm install`。Z.AI 账号不做。automation 推迟到第 7 轮：它的调度器要建工作流运行，必须和 workflows 一起迁。接手时树里的 automation 半成品（`plugins/automation/src` 下 offpeak 四个文件和 `tool.ts`，没有清单，过不了插件门禁）已移出，第 7 轮重做。

三个插件进了 `bundled-plugins.ts`，插件门禁从 25 到 28。remote 排在 network 之后：宿主按依赖分层激活，工具注册顺序要和清单目录顺序一致。前门在 `round6-http.ts` 组装，排在 round5 之后。

- remote：拥有整个 `/api/remote`。
  - 保存的 SSH 连接：GET/POST/DELETE。保存取 `.plugin-state.lock`，不提 `system` 的保存保留原值。
  - 连接生命周期：active、operations（查询、取消）、connect/reconnect/disconnect、request、sessions 分页。错误码与 Python 相同：KeyError 404，ValueError 409，传输错误 503，RPC 拒绝按 `reasonCode` 和状态。
  - `remote_exec` 经批准执行。会话绑定远程时，`supports` 声明 `remote.execution`，本地内核工具不暴露，也不装 hooks 扩展。
  - composer 目录与准备、prepared 消费、命令前检查、会话列表的远程摘要都在 TS 完成（`composer-remote.ts`）。
  - stdio `app-server` 和 `remote` CLI 留到第 9 轮。
- bots：拥有 `/api/bots`。
  - 频道存在 `bots.json`，token 只存环境变量名。
  - poll 调 Telegram `getUpdates`。白名单聊天的文本建成待处理会话，先存会话再记 inbox，用 `bot_source` 去重。
  - reply 要 `confirmed: true`，聊天也要在白名单里。
  - 所有拒绝都是同一个 400。`bots` CLI 留到第 9 轮。
- subscriptions：拥有 `/api/subscriptions`：列表、status、connect、login/import/manual/cancel/models/quota/disconnect、set-models。
  - `worker.mjs`、protocols、compat、catalog 和 vendor 原样复制到 `plugins/subscriptions/assets`。worker 按需启动，用 `XUENESS_DESKTOP_NODE` 或当前 Node。
  - 环境变量里去掉名字含 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL 的，导入账号要用的几个除外。
  - JSON 行协议，支持分块、取消和截止时间（generate 610 秒，其它 125 秒）。每 250 毫秒检查一次插件是否可用，关闭时杀进程组。
  - 订阅模型通过 `ProfileStore.external` 进入 providers。`GET /api/providers` 同时列出已保存的行和订阅行，按 Python 的规则排序。默认选择、推理档位、composer 模型目录、会话创建和运行都认订阅 id，`NativeProvider` 带会话 id。
  - 订阅行的连接测试和 Python 一样，返回 400「provider protocol does not support connection tests」。
- 插件可用性：带 `installPackage` 的插件，marketplace 标记（包 id 加 builtin）装好后，`effectivePlugins` 视为可用。model_monitor 的 HTTP 仍另走 `modelMonitorEnabled`。
- 去掉的转发：
  - providers 的 `cutover.ts`：订阅或远程生效时，不再把选择交回 Python；
  - remote 或 subscriptions 生效时，composer 不再转发 Python，prepared 也不再兜底消费；
  - `python-feature-bridge.ts` 只剩 CSRF 握手。
- 其它修复：
  - `browser/url.ts`、`network/ip.ts`、`network/html.ts` 在接手时被放宽成旧版 CPython 3.11 的行为，现已改回带安全补丁（3.11.17）的检查。对照解释器更旧时，`pythonPredatesSecurityBackports()` 让那几项不比较；
  - 接手压缩包里有几个中文文件名按 GBK 编码，解压后是乱码，已改回。本轮压缩包统一用 UTF-8 文件名；
  - 子代理协调器关闭时不再为已结束的 worker 留下 130 秒的定时器。之前 `tasks-http.test.ts` 每次要多挂 130 秒。

**新增测试**：`subscription-owner.test.ts`（替换 `provider-cutover.test.ts`）用同一份数据建两个状态目录，一个给 Python 后端，一个给 TS，逐条比较 providers、subscriptions、默认选择和 composer 模型目录，再建一个用订阅模型的会话。`remote/test/http.test.ts` 和 `bots/test/http.test.ts` 逐步比较 Python 插件的 `dispatch`，bots 两边都用假的 Bot API。`subscriptions/test/broker.test.ts` 用假 worker 测协议。

**验证**：`ts/` 下 `npm run check`，`XUENESS_PYTHON` 指向 CPython 3.11.17。这次检查在上述接线之后。

- 行数门禁：745 个文件，最大 `packages/providers/src/http.ts`（400 行）；
- 插件门禁：28 个插件，309 个源文件；
- 类型检查通过；
- 测试 927 项、211 个套件：926 通过，1 项跳过（Windows ACL），0 失败。`duration_ms` 191303.2。

**剩余差异**

- automation（含 off-peak）和 workflows 留到第 7 轮。
- `app-server`、`remote`、`bots`、onboarding、doctor/usage/update、`settings`/`settings-set` CLI 留到第 9 轮。
- 原生目录选择器仍在 `/api/workspaces`。`/技能名`、分支没有全局锁、工作流计数仍读 `state/workflows`。
- Office 预览没有 `fullDocument`。extensions 不调用 Python `sync_services`。终端不是 PTY。tools 干跑不经过 Gate。model_monitor 没有包装上游调用。updates 没有「正在处理的操作」。

## 30. ZCode 对齐第 7 步第 7 轮：workflows 与 automation（只改 TS，2026-10-21）

本轮只改 `ts/`。Python `xueness/` 未动。没有 `npm install`。接手时树里已有 `plugins/workflows`（17 个源文件）和 `plugins/automation`（10 个源文件）的移植，是按 `docs/round7-interfaces.md` 分工做的，插件门禁已是 30 个插件。但这两个插件没有接进服务端：`/api/workflows`、`/api/automations` 仍由 Python 回答，worker 也没有 TS 入口。本轮把它们接上，并修正了接手代码里的几个问题。

前门在 `round7-http.ts` 组装，排在 round6 之后。

- 路由：TS 负责 `/api/workflows`（含 `dwf`、`expert`）、`/api/automations` 和 `/api/automation/offpeak`。
  - 先过 Python `route_owner` 的门禁：插件或它的依赖不可用时，直接回 403 `plugin_disabled`。automation 依赖 workflows，所以关掉 workflows 时三个家族都回 403。
  - POST/PATCH 请求体按无损方式解码，保留 plan 里的整数和浮点数。
  - workflows 的路由围栏顺序是 web-runs、项目目录、声明的根。相对路径按 web-runs 解析，与 `_allowed_root` 相同。
- worker：`launch` 启动独立的 TS worker（`apps/server/src/workflow-worker.ts`，构建后是 `.js`），对应 Python 的 `xueness.workflow_worker`。
  - cwd 是项目根，stdio 丢弃。
  - 非桌面模式下 detached 并 unref，界面或服务端退出后运行继续。
  - 桌面模式（`XUENESS_DESKTOP_HOST`）下 worker 留在进程组里，并拿到 `XUENESS_DESKTOP_OWNER_PID`。在 POSIX 上，worker 发现宿主不在了就取消运行。
  - `api.close()` 按 `desktop_lifecycle.shutdown` 收尾：先取消，最多等 2 秒，然后按记录的 pid 结束命令进程组，最后结束 worker。
  - `setWorkerLauncher` 让 dwf、expert、已存工作流和 agent 工具新建的 store 也用这个启动器。
- actor 节点（`workflow-actors.ts`）：
  - 每个节点在 `workflows/<wid>-sessions` 下有自己的会话，根目录是节点的 cwd。
  - 只读节点用 plan 模式，可写节点用 edit 模式。没有审批者，仍需审批的调用会让运行暂停，与无人值守的 Python actor 一样。
  - memory 插件开着时，依赖结果作为不可信的 memory 块传给模型。
  - provider 按保存的档案解析。bucket 是「`provider_id` 或类名小写」加 `:model`。
  - 最多 20 步，节点超时就是墙钟上限。
  - 工具有 files、shell、planning（`ask_user`）、office、network。`/answer` 把回答写进 actor 会话，节点重新排队，运行暂停，与 `answer_actor` 相同。
- 调度器：每个 state 目录一个，跑在服务端。第一次检查立即进行，之后每 15 秒一次。automation 关着时空转。
- agent：会话的插件宿主加上 workflows 的 12 个工具和 `offpeak_create`。同时装上 `sessions` 标记插件，满足 workflows 的依赖。
- 修正接手代码：
  - `drive` 原来同步阻塞地取 `.runner` 锁。进程内启动时，`launch` 正拿着这把锁，事件循环会卡死。现在改为每 50 毫秒非阻塞地试一次。
  - 调度器：`nextRunAt` 存的是浮点数，无损读取后是装箱值，原来的 `typeof === "number"` 判断永远不成立，定时任务从不触发。现在用 `numericValue`。第一次检查改为立即进行，因为 Python 线程不会先等 15 秒。遇到意外异常时调度器停止，不再让进程崩溃。
  - bundled 的 automation 不再在 `.` 上起调度器。`createAutomationTools` 只提供工具，调度器归服务端。
  - `AgentNodeHost` 补上了会话目录和 bucket 计算。Python 在算依赖上下文之前就解析 provider，坏档案会让节点失败。

**新增测试**

- `workflow-owner.test.ts`：两份状态目录，一份给 Python 后端，一份给 TS，逐条比较回复。
  - workflows：列表、创建（含非法 plan、越界根、同时给 plan 和 script）、amend、start/pause/recover/未知动作、concurrency、日志、actor 回答、expert、dwf。
  - 批准后各跑一个命令节点。Python worker 和 TS worker 的最终记录去掉 id、时间、pid 和耗时后完全相同。
  - automation：保存、修改、未批准时运行、批准、删除。off-peak：概览、设置、非法提交、取消。
  - 最后关掉 workflows，三个家族都回 403。
- `workflow-actors.test.ts`：actor 读文件，看到依赖结果，用 `ask_user` 暂停；回答后恢复运行并完成。
- `automation/test/scheduler.test.ts`：已批准且到期的定时任务在第一次检查时启动，`nextRunAt` 前移；插件关着时不启动。

**验证**：在 `ts/` 下运行 `npm run check`，`XUENESS_PYTHON` 指向 CPython 3.11.17。检查在上述接线完成之后进行。

- 行数门禁：788 个文件，最大 `packages/providers/src/http.ts`（400 行）；
- 插件门禁：30 个插件，336 个源文件；
- 类型检查通过；
- 测试：1066 项、237 个套件：1065 通过，1 项跳过（Windows ACL），0 失败。`duration_ms` 175145.6。

**剩余差异**

- Python 后端自己的调度器还在跑。两边领取到期任务时用同一把锁，同一次到期只会启动一次，但可能被 Python 领走，起的是 Python worker。第 10 轮删除 Python 后不再有这个问题。
- 由 Python CLI 启动的运行仍然用 Python worker。
- CLI `workflow`、`jobs`、`expert`、`automation`，以及聊天里的 `/expert`、`/dwf`，留到第 9 轮。
- actor 只有上面五个插件的工具。Python 的 actor 能用所有已启用插件的工具，包括 skills、browser、subagents 和 MCP。
- worker 里只能解析保存的档案，解析不了订阅模型。
- spawn 失败是异步的。记录会标成 failed，但这次 start 请求仍然回 200，Python 回 400。worker 脚本不存在时同步报错，与 Python 相同。

## 31. ZCode 对齐第 7 步第 8 轮：前端模块与媒体（只改 TS 与 webapp，2026-10-21）

本轮改了 `ts/`、`webapp/`（源码和重新构建的 `dist/`）、`tools/check_frontend_bundle.mjs` 和一份前端文档。Python `xueness/` 与 `tools/check_plugin_architecture.py` 未动。

**插件目录与前端模块**

- TS 清单新增 `panels`、`frontendModules`、`desktopModules`，归属照搬 Python 清单。`scripts/frontend-gate.ts` 由 `check:plugins` 运行，规则和提示与 `tools/check_plugin_architecture.py` 的前端部分相同。
- 插件目录改由 TS 清单生成（`plugins/extensions/src/catalog.ts`，`apps/server/src/manifests.ts` 改为 `loadCatalogManifests`）。`round8-http.ts` 负责 `GET /api/plugins` 和 `POST /api/plugins/:id`，接在 `application-api.ts` 里。
- webapp 的 `check:plugins` 改为运行 TS 门禁（`node ../ts/scripts/check-plugins.ts`）。原因是 Python 门禁读的是冻结的 Python 清单，而 `xuenessToolNames.ts`、`plugins/sessions/manualCompact.ts`（前几轮加的）和本轮的 `plugins/sessions/Visualizations.tsx` 只在 TS 清单里登记了归属，Python 门禁会把它们报成 unowned。

**read：图片与 PDF**

- `packages/engine-tools/src/image/`：纯 TS 实现的 PNG、JPEG（解码和编码）、GIF 编解码与缩放。`prepare.ts` 移植 ZCode `prepareJimpImageForModel`：base64 不超过 5 MiB，最长边 2000，输入不超过 20 MiB；依次尝试原图、PNG 优化、JPEG 质量阶梯、缩放，最后用 JPEG 兜底。处理放在工作线程里，可以取消。
- `pdf-render.ts`：用 `pdfinfo` 取页数，用 `pdftoppm -jpeg -r 100` 渲染。错误分类和提示与 ZCode 相同。
- `read-media.ts`：图片返回 `[Attached <mime>: Read image]`。模型支持 PDF 时整份附加（不超过 20 MB，超过 10 页必须给 `pages`）。给了 `pages` 就渲染指定页，每次最多 20 页。read 的说明和 schema 随模型能力变化，支持 PDF 时用 ZCode 的 `ReadPdfInputJsonSchema`。
- 移植时修了两个问题：缩放时 alpha 没有截断；YCCK JPEG 的反色顺序错误。

**工具媒体进入模型请求**

- `ToolResult.media` 在 afterTool 扩展之前取出，所以结果和 journal 里都没有 base64。`packages/agent/src/tool-media.ts` 校验 mime、base64 和文件签名，按 sha256 原子写入 `<stateDir>/tool-media/<sid>/<sha256>`，工具消息上记 `_tool_media` 引用。
- `toolMediaExtension()` 在主会话、子代理和工作流 actor 上注册，压缩请求不注册。规则如下：
  - 请求里的工具消息仍含占位行时才附加，被 microcompact 清掉的跳过；
  - 从新到旧最多 20 项、20 MB，并扣掉请求里已有的用户附件，保证不超过 providers 的 32 项、64 MiB 总预算；
  - 每段连续的工具消息之后插一条合成 user 消息 `Tool result media: …` 来绑定附件，这条消息不写 journal；
  - 模型不支持、超出预算或旁路文件缺失时，在占位行后写一行说明。
- `env.modelInput` 按当前模型的能力给出；有待切换的模型时，以待切换的为准。Anthropic 消息协议声明 `acceptsPdfDocuments`。

**visualize（Gen UI）与 visual-judge**

- `plugins/skills/bundled/visualize/` 原样打包 ZCode 的 visualize 技能。
- 可视化目录：
  - 启用技能且不是远程会话时，每个会话有自己的可视化目录 `<stateDir>/visualizations/<sid>`。目录建好后取 realpath，是链接就拒绝。
  - 这个目录作为宿主可写目录（`hostWritable`）交给权限层：目录下的绝对路径在所有模式下（含 plan）都可以免批读、写、编辑。
- 提示里新增一个稳定的系统节「Xueness Desktop Context」，内容是「### Interactive views」的三条说明，与 ZCode 桌面上下文相同。位置在身份之后、动态行为之前。
- 渲染接口 `GET /api/visualizations?path=&title=`：
  - `visualize.ts` 移植 `render.py` 的 `_render_document`：片段不超过 1 MB，vendor 脚本内嵌并核对 sha256；
  - 响应带 CSP `sandbox allow-scripts; frame-ancestors 'self'` 和 `Referrer-Policy: no-referrer`；
  - 路径必须在本会话的可视化目录里。参数错误回 400，文件不存在回 404，内容不合法回 422，非 GET 回 405，技能关闭时回 403；
  - `visualize-vendor.ts` 按 CPython 3.11.17 `HTMLParser` 的行为查找 `<script src>`。
- webapp：`plugins/sessions/Visualizations.tsx` 把助手消息里代码块之外的 `::visualize{"path":...}` 换成沙盒 iframe（`sandbox="allow-scripts"`，不给同源）。旧写法 `path="..."` 和 `"mode":"wide"` 也能识别。流式输出时先隐藏，输出结束后再显示。样式在 `conversation-refresh.css`。
- visual-judge：`plugins/subagents/bundled/visual-judge.md` 原样打包，`profiles.ts` 新增内置 profile，工具是 Read 和 Bash。

**webapp 构建**

- 前几轮只跑了 webapp 的类型检查和测试，没有重新构建 `webapp/dist`，所以 ZCode 工具名、`/compact` 等界面改动一直没有进发布包。本轮重新构建了。
- 项目里缺 `webapp/tray.html`：`vite.config.ts` 引用了它，旧 dist 里也有它的构建产物。本轮按产物恢复，入口是 `src/plugins/desktop/tray-main.tsx`。
- 启动包 JS gzip 为 403.2 KiB，超出 400 KiB 预算（第 7 轮的旧 dist 已到 399.6 KiB）。预算上调到 408 KiB，改动在 `tools/check_frontend_bundle.mjs` 和 `docs/frontend-optimization-2026-10-04.md`。CSS 为 50.8 KiB，预算 64 KiB。

**新增测试**

- `plugin-catalog-python.test.ts`（6 项）：插件目录与开关的回复和 Python 相同；
- `frontend-gate.test.ts`：合法归属通过；报错与 `tools/check_plugin_architecture.py` 一致；Python 清单里的前端声明按顺序全部出现在 TS 清单里；
- `image-codecs.test.ts`（7 项）：解码结果与 Pillow 一致（基线、渐进、子采样、CMYK、restart、EXIF、PNG、GIF），无法解码时拒绝，编码往返，缩放保留颜色和 alpha，ZCode 的预算与压缩阶梯，工作线程与取消；
- `read-media.test.ts`（4 项）：图片附件与 ZCode 的二进制拒绝，`pages` 校验，支持 PDF 的模型附加整份文档，poppler 渲染指定页；
- `tool-media.test.ts`（6 项）、`tool-media-binding.test.ts`：按摘要存储并拒绝篡改，journal 不含 base64，OpenAI/Anthropic 的绑定位置，省略说明（不支持、超预算、旁路缺失），PDF 只发给接受 PDF 的 provider，跟随待切换的模型；
- `visualize.test.ts`（7 项）：5 个片段 × 2 个标题与 Python `render.py` 逐字节一致，另含脚本扫描的停止点、拒绝情形、默认标题、提示位置；
- `host-writable.test.ts`、`visualizations-route.test.ts`；
- webapp `plugins/sessions/Visualizations.test.tsx`。

改动的旧断言：`skills-bundled`（多了 visualize）、`subagents-zcode`（内置 profile 多了 visual-judge）。

**验证**

在 `ts/` 下运行 `npm run check`，`XUENESS_PYTHON` 指向 CPython 3.11.17：

- 行数门禁：815 个文件，最大 `packages/providers/src/http.ts`（400 行）；
- 插件门禁：30 个插件，339 个源文件；
- 类型检查通过；
- 测试：1104 项、245 个套件：1103 通过，1 项跳过（Windows ACL），0 失败。`duration_ms` 189023.6。

webapp：`npm run typecheck` 通过，`npm test` 1710/1710，`npm run build` 通过（含 TS 插件门禁、设计门禁和启动包预算）。

**剩余差异**

- extensions：Python 端的 `sync_services` 要等 Python 收到下一次请求才执行，有短暂滞后。
- 图片：
  - GIF 不保留原格式；
  - 透明区域铺白底，jimp 是黑底；
  - 解码上限 50 MP，jpeg-js 是 100 MP；
  - 没有复刻 jpeg-js 对 Adobe RGB 的特殊处理；
  - 3000×1800 的噪声 JPEG 走完整压缩阶梯约需 8 秒（纯 TS DCT）。
- 不支持读取视频。PDF 只能附给支持 PDF 的 Anthropic 模型。
- 工具媒体预算是从新到旧 20 项、20 MB。删除会话时不清理工具媒体和可视化的旁路文件。轻量运行时的 JSON 工具调用模式不附加工具媒体。
- visualize：
  - 没有 widget 状态（`untrusted_gen_ui_state`），也没有关于代码注释和「Files & URLs」的说明；
  - iframe 是固定高度，可以手动拉伸；
  - 查找脚本时，基本六个以外的具名 HTML 实体不解码；
  - 可视化目录在所有模式下都可写，包括 plan。
- visual-judge 忽略 frontmatter 里的 `model` 和 `thoughtLevel`。
- 桌面打包脚本（`desktop/scripts/build_backend.py`）、CI 和 `tools/prepare_release.py` 仍然运行 Python 门禁。这个门禁会因为上面三个只在 TS 清单里登记的 webapp 模块而失败，第 10 轮替换。

## 32. ZCode 对齐第 7 步第 9 轮：CLI（只改 TS，2026-10-21）

本轮改了 `ts/`，另加一个启动脚本 `bin/xueness-ts`。Python `xueness/` 与 `tools/check_plugin_architecture.py` 未动。沙盒重置过一次，本轮是从第 8 轮检查点重做的。

**入口与结构**

- `apps/server/src/cli/main.ts` 是 TS 版 `xueness` 命令行，对应 Python `xueness.cli.main`。`bin/xueness-ts` 用 Node 24 直接运行源码（剥离类型）。Python 的 `bin/xueness` 和 `python -m xueness` 留到第 10 轮再切换。
- `argparse.ts` 移植了 CLI 用到的 argparse 行为：子命令、`nargs`（`?`、`*`、`+`、REMAINDER）、`choices`、`append`、`store_true`、互斥组、长选项前缀缩写、`-h` 和用法行。错误消息与退出码 2 都和 Python 相同。子命令按 Python 的注册顺序排列（`COMMAND_ORDER`）。
- 命令归属与 `plugin_runtime.cli_owner` 相同：resources 按种类，其余按 TS 清单的 `commands`。插件关闭时报 `ERROR: plugin disabled or dependency unavailable: <id>`。
- `host.ts` 的 `Cli` 在本进程里建一个不连 Python 的 `createApplicationApi`：
  - 没有 upstream，自己生成 CSRF token；
  - `scheduler: false`，cron 和 off-peak 调度器归正在服务的进程；
  - 子命令通过它调用与 Web 相同的 `/api/...` 路由，输出格式照搬 Python（`json.dumps(indent=2, ensure_ascii=False)`、`ERROR: …`、`[Errno N] msg: 'path'` 等）。

**子命令**

- 会话：`new`、`run`、`chat`、`list`、`journal`、`answer`、`show`、`sessions`、`goal`。
  - `run` 和 `chat` 实时打印事件，审批在终端里回答。为此 `agent-service` 新增 `approver` 选项。
  - chat 支持 `/help`、`/status`、`/mode`、`/model`、`/models`、`/effort`、`/attach`、`/attachments`、`/detach`、`/paste`、`/paste-image`、`/compact`、`/retry`、`/dwf`、`/expert`、`/exit`、`/quit` 和自定义命令。API key 等用隐藏输入（`input.ts`）。
- 运维：`providers`、`memory-tracks`、`settings`、`settings-set`、`usage`、`git`、`doctor`、`update`、`onboarding`。
- 目录：`commands`、`skills`、`hooks`（含 trust 写入）、`mcp-check`、`mcp`、`plugins`/`plugin`（含 validate）、`resources`。
- 工作流：`workflow`、`jobs`、`expert`、`workflows`、`automation`（含 `offpeak`；`daemon` 一直运行到 SIGINT）。
- `remote`：list、save、remove、exec。exec 要么在终端确认 `Approve exec …? [y/N]`，要么加 `--allow-exec`。`bots`：list、save、poll、reply。
- `app-server`：stdio 上的 JSON-RPC 2.0，最小实现。
  - 方法：`initialize`、`session/list|get|create|setModel|setEffort`、`turn/start|cancel`、`shutdown`、`exit`；
  - 通知：`session/event`、`turn/started`、`turn/finished`；
  - 服务期间 stdout 只写协议帧，其他输出转到 stderr。

**其他改动**

- 为 CLI 新增或导出的函数：
  - `packages/sessions` 的 `enqueueAttachment`（`cli_input.enqueue`）；
  - `plugins/sessions/src/fork-cli.ts`；
  - `plugins/commands/src/inspect.ts`；
  - `plugins/skills` 的 `inspectSkill`；
  - `plugins/hooks/src/trust-write.ts`；
  - `plugins/extensions/src/cli.ts`；
  - `plugins/mcp` 的 `loadServers`、`checkServer`；
  - `plugins/remote` 的 `cliLocalFailure`、`cliPayload`。
- planning HTTP API 新增 `source`：CLI 暂存的目标标为 `cli`。
- `off-peak-queue.ts` 的 `nextWindowAt` 改为按 Python float 输出。

**与 Python 的已知差异**

- 没有移植全屏 TUI，`--tui` 会提示并退回行式界面。
- `chat` 等待输入时持有会话租约，每次运行时交给 agent runner。
- `doctor` 的 `version.python` 显示的是 Node 版本。`mcp disconnect` 没有连接池可断。
- 未匹配的 API 路由报 `ERROR (404): not found`。`-h` 的说明文字比 Python 简短，用法行和错误相同。
- `app-server` 没有以下部分：
  - protocol v1 的 session、terminal、browser 方法族；
  - 帧重放、`command/execute`、响应分片；
  - remote 被关闭后的后台检查。
- 其他输出差异：
  - `initialize` 的 `xuenessVersion` 是 TS 版本号；
  - 内置 `/init` 命令的路径指向 `ts/plugins/commands/src/builtin-prompts.ts`；
  - `show`、`journal`、`answer` 找不到会话时打印 `ERROR: [Errno 2] …`（退出码 1），Python 打印 traceback；
  - `XUENESS_ALLOW_REAL=0` 时 `providers discover` 先报「real model requests are disabled by the server」，Python 先检查 profile（默认允许真实请求时两边都报 provider profile not found）。
- CLI 的 fork 和 Python 一样不检查工作区白名单。

逐条对照了约 80 条命令行（全新状态、同样的输入），除上面列出的差异和时间戳外，stdout、stderr 和退出码都相同。

**新增测试**

- `apps/server/test/cli-oracle.test.ts`（7 项）：在两个全新的状态目录上分别运行 `python -m xueness` 和 TS CLI，比较 stdout、stderr 和退出码。覆盖：
  - 18 条只读列表命令；
  - 缺失项和坏路径的报错；
  - argparse 错误和 `--version`；
  - remote 的保存、列出、删除；
  - app-server 的 JSON-RPC 回复（未知方法、解析错误、`initialize`、`session/list`、协议版本不符、通知、批量帧、`shutdown`）；
  - remote 关闭时拒绝 app-server；
  - 新建会话。

`npm run check`：1111 项测试，1110 项通过，0 项失败，1 项跳过（与第 8 轮相同的那一项）；`check:lines` 837 个文件，`check:plugins` 30 个插件。

## 33. ZCode 对齐第 7 步第 10 轮：删除 Python（2026-10-21）

本轮删除了 Python 后端 `xueness/` 和 Python 测试 `tests/`，TS 成为唯一后端，第 7 步（第 1–10 轮）完成。第 5 节等处的「交给 Python」只是历史记录：现在没有处理方的路由一律返回 404。

**启动方式**

- `apps/server/src/main.ts`（`bin/xueness-web`）是独立的 Web 服务，不再启动或代理 Python。参数：`--port`（默认 8137）、`--host`、`--state`、`--web-runs`、`--workspace-root`、`--allow-real-provider`、`--project-root`。监听非本机地址需要 `XUENESS_ALLOW_REMOTE=1`。
- `bin/xueness` 改为运行 TS CLI（第 32 节），删除 `bin/xueness-ts`。
- `install.sh`：检查 Node ≥ 24.11，需要时运行 `npm ci`，然后启动 `main.ts`。
- `Dockerfile` 与 `compose.yaml`：基于 `node:24-slim`，只复制 `ts/` 和 `webapp/dist`，运行 `npm ci --omit=dev`；健康检查用 Node 的 `fetch`。`.dockerignore` 排除 `ts/node_modules`、`ts/dist`、`desktop/`。
- 桌面：
  - Electron 的 `front-door.cjs` 用 Node 启动 `desktop-host.(ts|js) --assets A --project-root R`，没有 Python，也没有回退开关；`main.cjs` 启动前检查脚本是否存在；
  - electron-builder 不再打包 `runtime/backend`，删除 `prepare:backend`；
  - `apps/server/src/desktop-host.ts` 只用 TS：`--data` 必填，启动后打印 ready 行，从 stdin 读桌面桥请求（`DesktopBridge` 按 id 配对），收到关闭或 stdin 结束时关闭服务。

**front door 与路由**

- `front-door.ts` 没有 upstream 和代理，只处理 csrf、health 等核心路由和 application-api 的路由。没有处理方的路由返回 404 `{"error":"not found","code":"not_found","status":404}`。status 里的 backend 是 `{kind:"ts", pid, …}`。
- 删除 `proxy.ts`、`python-backend.ts`、`python-feature-bridge.ts`、`scripts/front-door-broker.ts`。
- application-api 自己生成 CSRF token，新增 `desktopBridge` 选项。桌面模式下，设置和工作区的目录选择通过桌面桥完成。
- 原先交给 Python 的部分，改为 TS 处理或明确拒绝：
  - browser：浏览器路由全部由 TS 处理，删除 `releaseForPython` 和 `browser.python_worker`；
  - agent-features：MCP 固定为 `mcp.connections`，删除 `subagents.coordination`；
  - sessions：会话正在另一个进程里运行（externalRun）时，conversation、transport、lifecycle、live、question、queue（媒体除外）、steering 和 message-actions 统一返回 409 `{"error":"session is running in another process","code":"session_busy"}`（`queue-http.ts` 的 `sessionBusy()`）；
  - commands：上述情况回执 `rejected`（`session_busy`），不支持的命令回执 `rejected`（`unsupported_command`）；
  - lifecycle：不支持的运行返回 409 `unsupported_run`；没有 runQueue 时排队返回 409；没有 appendUserTurn 时 `prepared_token` 返回 409 `unsupported`；
  - 会话详情 `GET /api/sessions/:id` 直接读磁盘，不再转发。
- 路由审计：从 webapp 源码提取 143 条 `/api/...` 路径，逐条检查 TS 处理方。下面两组以前一直由 Python 处理，本轮补上：
  - `POST /api/sessions/:id/git/{init,stage,unstage,commit,branch,stash}`（`plugins/git/src/write-actions.ts`，对应 Python `git/actions.action`）。都需要 `confirmed: true`，并持有会话租约。路径不能以 `-` 开头，也不能越出工作区。commit 禁用 hooks，branch 先跑 `check-ref-format`。报错与 Python 相同：校验失败返回 400「invalid Git operation or missing session」，git 失败返回 409；
  - `POST /api/mcp/:id/{resources,prompts}` 和 `…/read`（`plugins/mcp/src/mcp-ops-http.ts`，对应 Python `lifecycle.dispatch`）。需要 `confirmed: true`；每次请求启动一次配置的服务器，用完即关；失败一律返回「MCP request failed (details suppressed)」。

**插件清单**：放在 `ts/catalog/<id>.json`（30 个），`manifests.ts` 和 `runtime.ts` 从这里读，构建时复制到 `dist/catalog`。

**删除的文件**

- `xueness/`、`tests/`；
- `desktop/entrypoint.py`、`desktop/requirements-build.txt`、`desktop/requirements-office.txt`；
- `desktop/scripts/` 下的 `build_backend.py`、`check_backend.py`、`check_artifact_terminal.py`、`check_file_paths.py`；
- `tools/check_plugin_architecture.py`、`tools/prepare_release.py`、`docs/release-preparation.md`；
- `ts/test-support/python/run_via_front_door.py`；
- 只测转发与交接的 TS 测试：application-api、prepared-handoff、proxy-replay、proxy、python-backend、subscription-owner、workflow-owner（第 9 轮检查点里还有）。

**保留的 Python 脚本**：只用标准库，供 CI 使用。

- `desktop/scripts/check_app.py`：改为读 `ts/catalog` 和 `desktop/package.json` 的版本号，worker 路径改为 `backend-ts/plugins/browser/bridge.mjs`；
- `desktop/scripts/check_windows_update.py`、`desktop/scripts/checksums.py`、`desktop/tests/test_windows_update_smoke.py`、`tools/generate_web_notices.py`。

**CI**

- `ts-backend.yml`：删除 Python 矩阵、步骤和路径。
- `desktop-build.yml`：`setup-python` 只留给上面的标准库脚本；删除 pip、`check_plugin_architecture`、Python 单元测试和后端冻结与检查；新增 macOS 的 `test:packaged`。
- `windows-runtime-check.yml`：改为 Node 加 `npm --prefix ts run check`；产物复查用 `gh run download` 下载，解压便携版后跑 `test:packaged`。

**文档**：README.md、AGENTS.md、CONTRIBUTING.md、使用说明.txt、docs/xueness-desktop.md、docs/github-publishing.md、ts/README.md 已改成只有 TS 的说明。CONTRIBUTING.md 注明：文中沿用的 Python 名称指对应的 TS 实现。

**测试**

- 新增：
  - `apps/server/test/desktop-host.test.ts`（3 项）：拒绝错误 token；`DesktopBridge` 按 id 配对和关闭；完整的宿主 API、选择器转发和关闭流程；
  - `apps/server/test/front-door.test.ts`（5 项）：独立模式下的界面与静态资源、csrf 与 health、所有写请求都要 CSRF、无处理方的路由返回 404、拒绝外部 Host 并报告自己是唯一后端；
  - `plugins/git/test/write-actions.test.ts`（3 项）、`plugins/mcp/test/catalog-http.test.ts`（3 项，用 `fake-server.mjs`）。
- 改为只测 TS：agent-http-production、native-lifecycle、head-limits、stream-response、desktop、agent-browser、agent-service、agent-subagents、route-catalog、plugin-manifest-v1、browser-http-python、browser-worker、network-python、queue-commands。
- `smoke-built.ts`、`smoke-packaged.ts` 只测 TS：安装包里不能有 `resources/backend`，`backend.kind` 必须是 `ts`。
- desktop：`desktop/tests/front-door.test.cjs` 重写（2 项）。`desktop` 测试共 119 项，114 项通过，0 项失败。
- `ts/test-support/python/*.py` 和各个 `*-python.test.ts` 对照测试保留，找不到 Python 后端时自动跳过。需要对照时，指向仍有 `xueness/` 的第 9 轮检查点运行：`XUENESS_PROJECT_ROOT=<第 9 轮目录> npm run check`。
- 测试总数从 1111 项降到 847 项：删掉了只测转发和交接的测试；整组跳过的 Python 对照只按 1 项计数。

**已知差异与遗留**

- Windows 上没有像 Python 那样用 job object 管理子进程。
- `RouteTable` 里仍有名为 `python` 的路由族，只是名字，不再转发。部分字段沿用 Python 的名字，例如 `doctor` 的 `version.python` 显示 Node 版本。
- `stage-desktop-release.yml` 引用的 `tools/stage_desktop_release.py` 原本就不存在，不是本轮删除的。
- `complete-project-manifest.json`、`source-manifest.json` 从第 7 步第 2 轮起没有维护，内容已过时。
- 安装包、Docker 镜像和 CI 工作流在这里无法运行，只做了静态修改，没有实际构建。

`npm run check`：847 项测试，785 项通过，0 项失败，62 项跳过（Python 对照测试）；`check:lines` 829 个文件，`check:plugins` 30 个插件。

## 34. ZCode 对齐收尾第 11 轮：Python 遗留清理与剩余差异（2026-10-21）

本轮在第 10 轮之后清理 Python 遗留，并补上几处剩余差异。开始时沙箱再次被重置，从第 10 轮检查点恢复，没有丢失工作。

**Python 遗留清理**

- `packages/contracts/src/route-catalog.ts` 删除迁移期的 `RouteTable`、`Backend`、`RouteDecision`（含名为 `python` 的路由族）。`apps/server/src/manifests.ts` 的 `routeTable()` 改为 `routeFamilies(projectRoot)`，返回 `{pattern: owner}`；front door 的选项 `routes` 改为 `families`，status 里是 `routes.families`；`main.ts`、`desktop-host.ts` 随之修改。
- 删除 `packages/sessions/src/flock-broker.ts`（`PythonFlockBroker`，靠 Python 进程持锁）、它的导出和 `packages/sessions/test/locks.test.ts`。原来用 Python 持锁模拟「另一个进程」的 7 项测试，改为用另一个 `NativeFileLocks` 实例（两个实例互斥，见 native-locks 测试），不再因缺 Python 跳过：forking、queue-commands、live-ownership（2 项）、attachment-faults、runner-lease（2 项）。native-locks 删去 2 项 Python 互斥测试。
- `stage-desktop-release.yml` 引用的 `tools/stage_desktop_release.py` 原本不存在，新增 `ts/scripts/stage-desktop-release.ts` 代替，工作流删去 `setup-python`。脚本依次：
  - 检查运行已完成且成功，commit 和 workflow（Desktop installers）一致；
  - 用 `gh run download` 下载产物，逐个核对产物里的 SHA256SUMS；
  - 用 js-yaml 核对 `latest*.yml` 的 sha512 和 size，合并两个 `latest-mac.yml`，写出合并的 `SHA256SUMS.txt`；
  - 新建或刷新草稿 `v<version>`；版本已发布时拒绝。
- 新增 `ts/scripts/project-manifest.ts`（`npm run manifest`）：Node 版清单生成。不加参数时列出变更并在过时时退出 1，`--write` 写回（保持原有顺序和 CRLF），`--migration` 记录迁移说明。已用它重新生成 `complete-project-manifest.json`。`source-manifest.json` 描述原始 0.1.8 源码包，保持不变。

**补上的差异**

- 永久删除会话（`deleteArchivedSession` 的两条路径）后，清理 `<state>/tool-media/<sid>` 和 `<state>/visualizations/<sid>`（`plugins/sessions/src/archive.ts` 的 `removeSessionArtifacts`，跳过链接和非法 id）。归档时仍保留。
- 输入 `/技能名 …`：没有匹配的命令时，如果名字与已启用技能的 id 或名称一致（不分大小写），composer 把这个技能加入本轮的 `skills`：原文保留，附加技能块，`metadata.skills` 有记录（`plugins/sessions/src/composer-prepare.ts` 的 `slashSkillId`）。

**测试**

- 新增：`scripts/test/stage-desktop-release.test.ts`（4 项，用假 `gh`）、`scripts/test/project-manifest.test.ts`（2 项）、`plugins/sessions/test/archive-artifacts.test.ts`（1 项）、`apps/server/test/composer-slash-skill.test.ts`（2 项）。
- 删除：route-catalog 的 RouteTable 测试（1 项）、`locks.test.ts`、native-locks 的 2 项 Python 测试。
- desktop 测试未改，共 119 项，114 项通过，0 项失败。

**已知差异与遗留**

- Windows 上没有像 Python 那样用 job object 管理子进程。部分字段沿用 Python 的名字，例如 `doctor` 的 `version.python` 显示 Node 版本。
- `stage-desktop-release.ts` 只用假 `gh` 测过；安装包、Docker 镜像和 CI 仍没有实际构建。
- `scripts/bench` 的 Python 侧、`test-support/python-oracle.ts` 和各个 `*-python.test.ts` 对照测试保留，找不到 Python 后端时跳过。
- 其余差异见路线图第 7 步的状态：全屏 TUI、PTY、子代理的 `task_collect`/`task_resume`/`task_send_message`、图片与 PDF 的限制、visualize 的 widget 状态等。

`npm run check`：853 项测试，800 项通过，0 项失败，53 项跳过（Python 对照测试）；`check:lines` 833 个文件，`check:plugins` 30 个插件。

## 35. 剩余差异第 1 批：子代理后台任务、PTY、图片与 PDF、可视化状态与高度、Windows job object（2026-10-21）

本轮处理路线图第 3 节列出的前五项差异。第 6 项（全屏 TUI，约 1.4 万行，需要按 400 行上限拆分）和第 7 项（安装包、Docker、CI，需要在用户自己的 GitHub 上跑各平台工作流）不在本轮。

**1. 子代理后台任务**

`coordinator.ts` 早就实现了 `TaskCoordinator`（派发、恢复、发消息、收集、turn 记录、完成检查），`tasks-http.ts` 也早已提供 `/api/sessions/:id/tasks`，缺的是插件从未注册这三个工具、从未声明 `subagents.coordination`、服务端从未构造 coordinator。

- 新增 `plugins/subagents/src/background-tools.ts`：`task_collect`、`task_resume`、`task_send_message` 三个工具。没有 coordinator 时返回 `agent_subagent_unavailable`；`task` 在 coordinator 与后台 runner 都存在时走 `coordinator.dispatch`，否则退回前台 `binding.run`。
- `subagentsExtension` 的 `capabilities` 改为 getter：有 coordinator 才是 `["subagents.tasks", "subagents.coordination"]`。`prepareRequest` 在远程会话里连 `task` 一起摘掉；没有 coordinator 时摘掉三个后台工具（模型不该看到永远不会成功的工具），但 `task` 本身保留（前台 runner 仍能跑）。
- `apps/server/src/agent-service.ts` 在 `subagents` 启用且非远程时构造 `TaskCoordinator` 并 `bindExecutor(backgroundChildRunner(...))`，`finally` 里清空三个绑定并停掉 coordinator。coordinator 不只在允许委派时创建：会话里留着没收集的行时，仍要能收集。
- 修 `coordinator.ts` 的 `sync()`：它原本用 registry 的行整体覆盖持久化的 `session.task_runs`，丢掉了 `childSessionId`、`parentSessionId`、`rootSessionId`、`canResume`、`recoveryReason`、`childStatus` 和归一化后的 `agent` id，还把 `workerActive` 漏进日志。现在按 `DURABLE_FIELDS` 合并，并删掉 `workerActive`。
- `plugins/subagents/manifest.json` 到 0.3.0，工具与 feature 同步；`catalog/subagents.json` 补上 `subagents.coordination`。
- `apps/server/test/agent-subagents.test.ts` 的 4 项按后台语义重写（派发返回 receipt、结果从 `task_collect` 拿、未知类型是失败的 task 而不是失败的工具调用、取消后看 task 行与子日志），另加 1 项「留着未收集的行时仍然 supports」。

**2. PTY 终端**

原来的 broker 是 `child_process` 管道，注释明确写着「不是 ConPTY」。现在换成真实伪终端。

- 新增 `packages/engine-tools/src/pty.ts`：`@lydell/node-pty` 的懒加载包装（`nodePty()` / `spawnPty()` / `livePtys()`）。用 `createRequire` 加载，平台没有预编译二进制时返回 `null` 而不是抛错；`encoding: null` 保持原始字节，`name: "xterm-256color"` 让程序按终端能力输出。宿主退出钩子杀掉所有活着的 PTY。
- `@lydell/node-pty` 1.2.0-beta.15 的主包只是选择器，二进制在 `@lydell/node-pty-{platform}-{arch}` 的 optionalDependencies 里（Windows 是 `conpty.node` + `conpty.dll` + `OpenConsole.exe`，POSIX 是 `pty.node`），安装时不编译。
- `plugins/terminal/src/broker.ts` 重写：`Terminal` 有 `kind: "pty" | "pipe"`，PTY 可用时走 PTY，否则退回管道；输出缓冲区抽成 `OutputBuffer`，两个后端共用同一套绝对游标。`resize` 真正下发到 PTY（管道只记录尺寸）。关闭时 PTY 直接 `kill()`，管道仍是 `taskkill /T /F`。
- 插件只依赖 `@xueness/*` 的门禁不变：node-pty 装在 `@xueness/engine-tools` 里，`plugins/terminal/package.json` 只加了 `@xueness/engine-tools`。
- 新增 `plugins/terminal/test/pty.test.ts`（4 项）：子进程 `process.stdout.isTTY` 为真（管道会得到 `notty`）、`resize(100, 40)` 后子进程读到 `100x40`、越界尺寸与已关闭终端被拒、`kill()` 后从 live 集合移除。用 Node 自报的 `isatty` 和尺寸，不依赖本地化的 `mode con` / `stty` 输出。
- 实测：Windows 上 `PROBE tty 100x40`；构建后的 `ts/dist` 里同样能启动 PTY（`BUILT-PTY-OK`），`node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/` 下的二进制确实随构建产物一起复制。

**3. 图片与 PDF**

对照 ZCode 的 `jimp-compression.ts` 与 `model/transform.ts`，三处差异都补上：

- 新增 `packages/engine-tools/src/image/gif-encode.ts`：纯 TS 的 GIF89a 单帧编码器（5:5:5 直方图 + 加权中位切分调色板 + 变长 LZW）。`prepare.ts` 的 `formatPreserving` 对 `image/gif` 现在重新编码成 GIF，不再直接掉到 JPEG 阶梯。LZW 的位宽增长点比解码器晚一格（解码器读第二个码时才建第一项），这一点在文件里写明了原因。
- `raster.ts` 的 `flatten()`（把透明像素刷白）换成 `dropAlpha()`：保留源里存的 RGB、只把 alpha 置 255，和 jimp 的 JPEG 编码器行为一致。透明区域不再被铺白。
- PDF 发给 OpenAI 与 Gemini：`providers/src/media.ts` 的 `providerCapabilities` 默认集合加上 `pdf`（gpt-4o/4.1/4.5、gpt-5、o1/o3/o4，以及 `gemini*`）；`openAiMessages` 把 PDF 作为 `{ type: "file", file: { filename, file_data: "data:...;base64,..." } }` 发出；`OpenAICompatible` 加 `acceptsPdfDocuments = true`（`tool-media.ts` 的 `modelInputOf` 靠它决定要不要附文档）；`tool-media.ts` 重新附加工具媒体时把 `placeholder` 当文件名传下去。
- 测试：`image-codecs.test.ts` 加 2 项（超尺寸 GIF 仍是 GIF 且 PSNR > 25；透明区域保留原色，RGB 平均误差 < 60，而刷白路径约 227）；`tool-media.test.ts` 加 OpenAI `file` part 的断言（含真实文件名 `a.pdf`）。
- 视频仍不读（支持的模型太少）。

**4. 可视化组件的保存状态与自适应高度**

两个真实缺陷：`GET /api/visualizations` 带 `Content-Security-Policy: sandbox allow-scripts`，页面是不透明源，自己的 `localStorage` 会抛错，所以 `setWidgetState` 从来存不下来；外壳量了片段高度却从不告诉嵌入方，`.xn-viz` 一直是 CSS 固定的 520px（`.xn-viz--wide` 640px）。

- `plugins/skills/bundled/visualize/assets/standalone-shell.js` 增加宿主协议：`xueness-visualization-state-read`、`xueness-visualization-state-write`、`xueness-visualization-height`。持久化先问宿主（5 秒超时），拿不到才退回自己的 `localStorage`；高度只在片段第一次自报高度之后上报（此前 `calc(100vh - 2rem)` 不是内容高度）。
- `webapp/src/plugins/sessions/Visualizations.tsx` 增加 `useVisualizationHost(frame)`：监听 `event.source === frame.contentWindow` 的消息，读写 `localStorage` 并回执，把高度夹到 `MAX_FRAME_HEIGHT` 后作为 `.xn-viz` 的行内高度。
- 新增 `webapp/src/plugins/sessions/Visualizations.host.test.tsx`（3 项）：两侧的消息名一致、外壳先问宿主再退回本地存储、只在测量后才上报高度。
- webapp 重新构建（`dist` 166 个文件，含新的 `workbench-*.js` 哈希），`npm test` 1713 项全过。

**5. Windows job object**

`taskkill /T /F` 是在杀的时候遍历进程树，被重新挂到别处的孙进程会漏掉；宿主崩溃、`TerminateProcess`、断电时退出钩子根本不会执行。

- 新增 `packages/engine-tools/src/windows-job.ts`：每个宿主进程一个 job object，设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，宿主句柄关闭时由内核结束里面所有进程。句柄从不显式关闭，所以 `detachedBackground` 那种故意活过父进程的孙进程不会被提前杀掉；Windows 8 起支持嵌套 job，宿主本身已在 job 里也能用。koffi 加载 `kernel32`，`contains()` 用 `PROCESS_QUERY_LIMITED_INFORMATION`（用 `PROCESS_TERMINATE` 时 `IsProcessInJob` 会返回错误 5）。
- `process.ts` 在 `spawn` 之后把子进程加进 job；逐子进程的杀法仍是 `killTree`。
- 新增 `packages/engine-tools/test/windows-job.test.ts`（3 项，非 Windows 跳过）：宿主 job 能接纳子进程、孙进程靠继承而非逐个加入、宿主被 SIGKILL 时子进程随之结束。第 3 项用临时 `host.mjs` 子进程验证，import 说明符必须用 `pathToFileURL(...).href`（ESM 不接受裸 Windows 路径）。

**验证**

- `npm run check`：832 项测试、249 个套件，772 通过、0 失败、60 跳过（Python 对照测试，本机无 CPython 3.11 后端）；`check:lines` 836 个文件（最大仍是 `packages/providers/src/http.ts` 400 行）；`check:plugins` 30 个插件 / 344 个源文件；typecheck 通过。
- `npm run build` + `npm run test:built` 通过（静态 UI、原生会话/历史、插件目录、健康检查、未拥有路由 404）。
- webapp：`typecheck` 通过，`npm test` 1713 项全过，`build` 成功。
- 构建过程中两次踩到 `vite build` 在 Windows 上清空 `webapp/dist` 后失败（esbuild 无法删除系统临时目录）：先备份 `dist`，再改用项目内的临时 `outDir` 构建，成功后替换。`dist` 最终 166 个文件，与备份一致。
- 观察到 `plugins/mcp/test/mcp-stdio.test.ts` 与 `plugins/browser/test/browser-worker.test.ts` 各有一次偶发失败，单独重跑 3 次与全量重跑均通过，与本轮改动无关，未改动它们。
- 项目清单 `npm run manifest -- --write` 刷新到 1965 项（第 13 轮更正原记录的 1964），复核 `changed 0`。

## 36. Sessions 全屏终端聊天首版（2026-10-22）

sessions 插件新增 `sessions.tui`，由 `plugins/sessions/src/tui.ts` 实现 `FullscreenChatTerminal`；渲染、终端文字处理和输入编辑分别放在 `tui-frame.ts`、`tui-text.ts`、`tui-editor.ts`，均保持在 400 行以内。CLI 侧的 `output.ts` 与 `CliTerminal` 只负责终端适配，继续复用既有 `chatLoop`、`run` 和审批路径。功能已登记在插件 manifest 与 catalog 的 features 中，实现模块登记在 catalog 的 modules 中，没有新增共享白名单或依赖。

用户显式传入 `--tui` 且 stdin 与 stderr 是 TTY 时启用全屏界面；无 TTY 时沿用行模式。首版支持流式 transcript、PgUp/PgDn 历史滚动、Unicode 输入、多行 bracketed paste、运行期间保留独立的下一条草稿、窗口 resize，以及正常退出、中断和退出时的终端清理。CLI parser 的 `setDefaults` 先前未覆盖 action 默认值，导致聊天交互审批静默关闭；现已修正，显式 `--non-interactive` 仍关闭审批提示，运行命令仍默认非交互。结构化工具错误现在显示其 `message`，不再渲染为 `[object Object]`。

**验证（隔离临时状态目录和工作区）**：五个定向 Node 测试通过（`tui.test.ts`、`cli-terminal.test.ts`）；build 与 typecheck 通过（597 个 JS 模块）。Windows ConPTY 源码版与构建版均使用本机脚本化 provider 完成三次调用，显式 `y` 批准写入验证通过；90×28 → 54×18 → 90×28 resize 与后续内容持久化通过，alternate screen 恢复通过，管道输入回退通过。`check:plugins` 通过（30 个插件、349 个源文件），行数门禁通过（最大 400 行）。没有调用真实模型或付费服务。按用户要求未运行完整后端或前端套件；`webapp/` 未改动、未重建。

首版尚未实现 ZCode 的模糊菜单、鼠标和终端图像协议，尚未与其 TUI 完整对齐；Linux/macOS TUI 未测试。安装包、Docker 和 CI 仍需在目标环境工作流中处理；没有在本轮宣称完成这些交付。

## 37. TUI 交互对齐（2026-10-22，第 14 轮）

以本地 ZCode v3.15.1 `aac4755666d09fdcd70272fcf063c077a639015f` 的 TUI（91 个 src 文件）为行为参照，沿用 Xueness ANSI 渲染与既有插件端口。补全命令、模型、档位、模式及文件建议，多行编辑与历史，鼠标选文、复制与定位输入光标，结构化审批/项目精确规则记忆，多问题选择/自定义/跳过/复核，运行中持久排队与当前轮指导，思考/工具/压缩/工作流卡片，主题与自动背景检测，宽屏侧栏/窄屏浮层/独立滚动，新建/恢复/分叉和只读子代理时间线。思考流可从已保存 stream history 恢复；工具详情使用内部端口，不扩大公开工具事件输出。

sessions 新增七个稳定子功能 ID，并登记全部 TUI 模块。`tui-fullscreen.ts` 协调独立显示与交互模块，`tui-session-port.ts` 复用 store、queue、steering、附件与 HTTP 能力，`cli/chat-tui.ts` 接入 providers/workflows。状态变化通过文件通知驱动，忽略锁与临时文件；关闭时解除订阅。没有增加依赖或共享白名单，没有修改或重建 webapp。

联调定位并修复普通输入分支的悬垂 else、新结果被旧输出遮盖、词内下划线被误作 Markdown 强调，以及异步面板查询拿旧审批快照覆盖成功卡片。最终会话快照在面板查询结束后读取；已完成的调用不接收过期的等待审批结果。审批中的卡片显示 awaiting approval。

**验证**：Windows x64，Node v24.19.0、npm 11.17.0，隔离状态与工作区，未调用真实或收费模型。27 项相关 Node 测试通过：`plugins/sessions/test/tui.test.ts`、`tui-parity.test.ts`、`tui-port.test.ts`、`apps/server/test/cli-terminal.test.ts` 共 16 项，`packages/agent/test/lifecycle.test.ts` 11 项。Typecheck/build 通过（615 个 JS 模块）；插件门禁通过（30 个插件、366 个源文件）；行数门禁通过（866 个 TS 文件，最大 400 行）。遵照用户要求未运行完整后端或前端套件，前轮全量测试仅为历史记录。

Windows 真实 ConPTY：源码版和构建版均通过 `tools/verify-tui.mjs` 与 `tools/verify-tui-queue.mjs`，每个流程使用三次本地模拟 provider 调用。主流程验证模型和文件 Tab 补全不触发 provider、只按 y 的审批、实际文件与成功结果、成功工具卡片、续聊落盘、90×28 → 54×18 → 90×28 缩放、退出恢复和管道回退；队列流程保持首请求未完成，验证 Enter 与 Ctrl-S 的接受回执、模型按指导后队列顺序消费、会话与 sidecar 最终 completed。该环境的 node-pty 退出回调有时不提供 exitCode，验收记录 null，独立 wrapper 确认 CLI main 返回 0 并检查备用屏幕恢复，没有把未知原生退出码当作 0。

**边界及历史更正**：第 36 节对“模糊菜单/终端图像协议”的描述不准确；参考菜单实际是关键词子串过滤，图片入口是剪贴板 PNG 附件。本轮已对齐这两种交互。Xueness 继续使用 `plan/build/edit/yolo`，没有移植 ZCode guarded 的后端权限语义；没有迁移账号、计费、品牌或遥测，也不宣称逐像素一致。macOS/Linux 终端和各平台真实剪贴板未实机验证；安装器、Docker 和真实仓库 CI 不在本轮范围。具体对照见 `../docs/tui-parity-round14.md`，操作说明见 `../docs/xueness-terminal-chat.md`。

## 38. 收尾第 15 轮：全量验证与定稿（2026-10-22）

本轮基于第 14 轮交付包（SHA-256 `90d21aea74e5a67512ac9a0099d3978dfc072c2c44311b43e173fb1644a425bc`），在 Linux x64（Node v24.14.1）上补跑第 13、14 轮没有跑的全套测试，修复发现的问题，整理文档并重新生成清单。没有调用真实或收费模型。

**修复**

- `ts/scripts/build.ts`：打包随附的 Node 时，原来只在 `node` 同目录找 `LICENSE`。这是 Windows 压缩包的布局；Linux、macOS 的官方包（包括 `actions/setup-node`）把 `LICENSE` 放在 `bin/` 的上一级，所以 `npm run build` 在 POSIX 上必然失败，macOS 的桌面工作流也会卡在这里。现在两个位置都找。
- 纸感外观（`claudex`）的会话面板有一圈强调色（赤陶红）边框：`pane-workbench.css` 给获得焦点的面板加 `inset 0 0 0 1px var(--accent)`，经典外观在 `xueness-superposition.css` 里覆盖掉了，纸感外观没有覆盖。`claudex-scheme.css` 补上同样的规则：只有一个面板时不画边框，分屏时用中性细线（`--fg` 的 24%）标出焦点。`codexPaletteScheme.test.ts` 加 1 项回归测试。webapp 重新构建，`dist` 仍是 166 个文件（文件名哈希有变化）。

**验证（全部通过）**

- `npm run check`：878 项测试，822 项通过，0 项失败，56 项跳过（大部分是找不到 Python 后端的对照测试，其余是 Windows job object、Windows ACL 等平台专属测试）；`check:lines` 866 个文件（最大 400 行），`check:plugins` 30 个插件、366 个源文件；typecheck 通过。
- `npm run build` 和 `npm run test:built` 通过。
- desktop：119 项测试，114 项通过，0 项失败，5 项跳过。
- webapp：`typecheck` 通过，`npm test` 1714 项全部通过，`build` 成功。
- TUI：`tools/verify-tui.mjs` 和 `tools/verify-tui-queue.mjs` 的源码版与构建版在 Linux 真实伪终端（`@lydell/node-pty-linux-x64`）上都通过，每个流程 3 次本地模拟模型调用；PTY 退出码为 0（Windows 上曾记为 null），CLI 退出码为 0，备用屏幕恢复，管道回退正常。记录在 `验收资料/验证记录/tui-linux-*.json`。
- 用 Playwright 打开纸感外观的会话页，逐个检查元素的边框、轮廓和阴影：修复前会话面板（`.xn-workbench-leaf`）带 `rgb(154, 79, 52)` 内阴影，修复后页面上没有红色系边框。

**文档**

- 路线图第 7 步补上第 12–15 轮，剩余差异按现状更新；`docs/xueness-terminal-chat.md` 记入 Linux 验收；新增根目录 `WORK-SUMMARY-20261022-ROUND15.md`。
- 新增 `docs/engine-roadmap.md`：下一阶段的引擎深化路线图（对照 ZCode 与 Codex 的规模和差距，分 E1–E9 九个阶段，约 20–28 轮，先做评测基线）。
- `complete-project-manifest.json` 用 `npm run manifest -- --write` 重新生成。

**仍未完成**

- 安装包、Docker 镜像和 CI 只做了静态修改，没有实际构建；`stage-desktop-release.ts` 只用假 `gh` 测过。需要在自己的 GitHub 仓库上跑一遍工作流。
- macOS 终端和各平台真实剪贴板没有实机验证；TUI 没有 ZCode 的 `guarded` 模式（Xueness 保留 `plan`、`build`、`edit`、`yolo`）。
- 路线图第 7 步「剩余差异」里的零碎项，以及引擎深化路线图列出的能力。

## 39. 引擎深化 Z1 第 1 轮：ZCode 模型失败分类与自动重试（2026-10-22，第 16 轮）

引擎路线图改为 ZCode 优先（`docs/engine-roadmap.md`，Z1–Z8，Codex 放到之后）。本轮做 Z1 模型执行层的第 1 块：照 ZCode v3.15.1 `apps/zcode-cli/packages/adapters/src/model/` 的失败分类、业务码、重试策略和 runner 重试语义。没有调用真实或收费模型。

**providers（`packages/providers/src`）**

- `failure.ts`：ZCode 的 `ModelErrorCode`、`ModelFailureReason`、`ModelRetryReason` 和 `classifyModelFailure`。顺序与 `failure-classifier.ts` 一致：无效响应/请求 → 取消 → 业务码 → 额度耗尽 → 超时 → 429 → 529 → 401/403 → 400/413/422（区分超窗）→ 超窗 → 5xx → TLS → 代理 → 网络 → 供应商标记可重试 → 未知。只读状态码、Xueness 类别和阶段、业务码、传输提示和 Retry-After，文案用 ZCode 的固定英文，上游文本不会进入结果。
- `failure-codes.ts`：`failure-provider-business-codes.ts` 的码表（Z.AI/BigModel 的 1302/1303/1305 可重试限流、1113/1304/1308… 终止、1261 超窗、1234 网络、1312 过载、3006/3007 等，以及 `insufficient_quota` 等额度码、`overloaded_error`），外加网络、TLS、代理错误码判断。
- `retry-policy.ts`：`retry-policy.ts`、`retry-budget.ts` 和 `calculateRetryDelay`：默认 11 次尝试（10 次重试），2 s 起按 2 倍增长、上限 60 s，50–100% 抖动；5 分钟以内（或短于未封顶指数值）的 Retry-After 优先；环境变量 `XUENESS_MODEL_RETRY_MAX_RETRIES / BASE_DELAY_MS / BACKOFF_FACTOR / MAX_DELAY_MS`；`default`、`unbounded`、`single-attempt` 三档预算，事件里无上限记为 `maxAttempts: 0`。
- 传输层：错误状态的响应体（8 KiB、250 ms 上限不变）现在对所有 4xx/5xx 读取业务码（Python 只读 400/413/429，那三种的超窗和额度判断照旧）；SSE 错误包也带出业务码；`retry-after-ms` / `retry-after` / `x-should-retry` 按 ZCode `parseRetryAfterMs` 解析成未截断的毫秒值；TLS 证书错误和代理隧道失败带 `tls` / `proxy` 提示（异常名仍是 Python 的 `URLError`）。这些作为 `ProviderRequestError` 的新字段 `providerCode`、`retryAfterMs`、`transport`，`toJSON()` 和 0–2 s 的 `retry_after` 不变。
- 适配器：`ProviderCallOptions.transportAttempts`（1–3，默认 3）控制标准档的 HTTP 尝试次数。

**驱动（`packages/agent/src/model-retry.ts`、`driver.ts`）**

- 每次模型请求一个 `ModelRetry`：失败先分类并发出 `model_request_failed`；可重试、预算允许、没有已提交的输出（正文、思考、工具活动）、并且等待结束前不会超过运行的时间上限时，发出 `model_retry_scheduled`，等待后重发同一请求。等待期间用户停止（`signal` 或 `shouldStop`）按“已停止”结算。
- 标准档请求带 `transportAttempts: 1`，重试由这一层负责（ZCode 的 runner 同样关闭 SDK 自带重试）；轻量档默认 `single-attempt`，继续用它自己的 `transportRetries`。
- 超窗压缩和 `retryRequest` 恢复仍然只做一次（原来靠 `attempt === 0` 判断，现在用单独标记），之后的失败交给模型重试。成功后 `_request_attempts` 加上模型层重试次数。
- `RunOptions.modelRetry` 可覆盖策略和预算；扩展可实现 `modelRetryScheduled` 观察重试。

**界面**

- providers 插件的请求活动记录新增 `retrying` 阶段和 `retry`（下一次尝试序号、总次数、等待毫秒、原因、错误码、状态码、预计重试时间）；sessions 的公开投影只放行这些字段。
- 网页端会话流状态显示“模型请求失败，正在自动重试…”，本地运行监视器显示“自动重试”；TUI 原来就把 `model_request_*` / `model_retry_*` 事件放进网络面板。

**验证**

- `npm run check`：893 项测试，837 项通过，0 项失败，56 项跳过；新增 `packages/providers/test/failure.test.ts`（分类、业务码、策略、Retry-After、真实本地 HTTP 服务的业务码和 Retry-After 透传）、`packages/agent/test/model-retry.test.ts`（重试与事件、预算、不可重试、已输出不重试、轻量档、等待中停止、时间上限）和 `plugins/providers/test/activity.test.ts` 的重试记录用例。`check:lines` 872 个文件，`check:plugins` 30 个插件、366 个源文件。
- webapp：`typecheck` 通过，`npm test` 1714 项全部通过；`webapp/dist` 已重新构建（166 个文件）。

**还没做（Z1 后续）**

- 空补全重试、流重试边界（只缓冲前奏事件）、`model_request_started/completed` 状态事件、最终失败分类写进会话并给中文提示；请求整形（工具输入归一化、工具调用校验、严格 schema、system 消息兼容、思考历史归一化、Anthropic 流兼容）。

## 40. 引擎第 17 轮：模型执行层 Z1 第 2 块（2026-10-22）

基于用户提供的 `Xueness-round16.zip`（SHA-256 `41c24df88a5f0e9e4d16ba00798f3c33d2a58ffdf7e5c223ec45e3441dea8ce7`）；原包 2011 项文件清单逐项校验通过，在独立目录继续开发。参考 ZCode v3.15.1（`aac4755666d09fdcd70272fcf063c077a639015f`）。本轮所有子代理使用 GPT-6-Luna / max，仅按主代理确定的任务执行。

**请求与重试**

- `packages/agent/src/model-request.ts` 从 driver 提取单次逻辑请求循环；媒体物化/释放、插件有效性、超窗恢复与一次协议修复继续走既有路径。
- `empty-completion.ts`：提供异常结束原因、没有正文/工具且没有报告用量的空补全，最多额外重试一次，仍占原尝试预算；正常 stop、工具结束、有用量或思考输出不触发适配层空重试。连续两次空响应由核心异常检查结算为供应商错误；思考独有、零用量、异常结束也由核心检查终止，不重复思考。single-attempt 不额外重试，unbounded 不放大空重试次数。
- `stream.ts` 暂存部分工具参数快照；在正文/思考文字产生或完整工具调用被接受时提交。失败前奏直接丢弃，不进入工具活动或观察回调。空 delta 不提交，空白字符算非空输出；隐藏思考同样阻止重放。已提交输出失败时保留部分显示，不重试、不重复执行工具。旧会话的 tool_activity 不参与本次请求的提交判断。
- `packages/providers/src/stream-idle-timeout.ts`：默认 600000 ms，每次重试增加 30000 ms；每个完整 SSE data payload 刷新计时，注释心跳不刷新。超时关闭响应并抛出独立的 `ModelStreamIdleTimeoutError`，分类为 `stream_idle_timeout`；取消立即结束等待并清理计时器/监听器。`RunOptions.modelRetry.streamIdleTimeoutMs` 可覆盖，非正数关闭事件计时器；现有连接/请求截止时间仍有效。轻量档保留自己的 transportRetries 与内部投递边界。

**状态与界面**

- 每次物理尝试发出 started，再发 completed 或 failed，含模型、供应商协议、尝试预算、时间戳及实际耗时；completed 只带实际报告的白名单 usage。被丢弃的首次空补全只记 failed；最终空补全在适配器 completed 后由核心异常检查再记终态 failed。失败含分类、阶段、终态标记与安全状态/业务码。保留第 16 轮跨重试稳定的逻辑 `requestId`，新增唯一 `attemptId` 标识每次物理调用；这是与参考每次请求 ID 的有意兼容适配。
- providers 的 `activity.ts` 连接生命周期；新增 `model-status.ts` 保存最终 `session.model_failure`。中文/英文提示由分类映射生成，不采用供应商响应原文；公开会话投影仅包含声明字段。下次请求开始或成功时清除旧失败，取消不记录成供应商错误。
- CLI 按语言显示终态原因；TUI 保留网络状态并增加去重的中文错误卡，用户取消不显示失败卡。Web 复用现有 pause_reason 提示，无前端源码改动；沿用第 16 轮随附的 166 个 webapp/dist 文件。
- 新增四项 providers feature（空补全重试、流提交边界、流空闲超时、请求状态），manifest/catalog 同步登记，model_status 模块归 providers 插件。

**验证与交付**

- Windows / Node 24：相关回归累计 73 项（72 通过，1 项缺少已退役 Python 后端的旧活动对照跳过，0 失败）；新增 17 项聚合测试。覆盖预算、状态顺序、工具仅执行一次、部分输出、隐藏思考、媒体释放、取消、失败持久化/清除、公开投影和终端显示。
- 类型检查、插件门禁（30 插件、367 源文件）、行数门禁（881 个 TS 文件，最大 400 行）、后端构建（623 个 JS 模块）通过。遵照用户减少非必要测试的要求，没有运行后端/前端全套，也没有重建未改动的 Web 界面。
- `test:built` 搬迁后运行验证通过。本地 HTTP 验收脚本为 `tools/verify-model-execution.mjs`；源码版和 `--built` 版各 7 场景、11 次请求全部通过，记录随工程保存在 `验收资料/验证记录/model-execution-windows-{source,built}-round17.json`。构建版使用 dist 的 canonical 包入口，产品模块解析未改动。所有验收使用隔离状态及本地模拟服务，不调用真实或收费模型。
- 交付完整源码 ZIP、相对第 16 轮的补丁 ZIP、更新的文件清单及本节交接。安装器、Docker、CI、macOS 与真实剪贴板没有在本轮验证。

**下一轮**

Z1 第 3 块：工具输入归一化、调用校验、严格 schema、system 消息兼容、思考历史归一化及 Anthropic 流兼容。并发准入和本地调试记录仍属可选第 4 块；本轮不宣称整个 Z1 或全部引擎完成。

## 41. 引擎第 18 轮：模型执行层 Z1 第 3 块（2026-10-22）

基于第 17 轮完整包（SHA-256 `6c907071704203ac3ffc0239d91e2553673e771a94fa03095330c71c7c756993`），在独立 `_round18` 目录继续。参考 ZCode v3.15.1（`aac4755666d09fdcd70272fcf063c077a639015f`）模型适配层的七组行为；本轮主代理决定方案、边界和验收预期，GPT-6-Luna / max 子代理仅执行指定任务。

**参数、工具调用与严格 schema**

- `packages/providers/src/tool-input-normalization.ts` 规范化最终参数：undefined/null/空字符串及 JSON null 转成 `{}`，BOM JSON 可解析，对象/标量按有限 JSON 序列化。`normalizeNative` 对名称 trim，保留调用 ID；客户端空名称且有有效 ID 时，`agent/tools.ts` 生成同 ID 的普通 unknown_tool 结果，不调用 bridge。非字符串名称、供应商执行的空名、缺失/重复 ID、错误类型/envelope 仍无执行权。
- **有意适配**：参考损坏 JSON 会降为 `{}`；本项目保留原始损坏/重复键字符串，由既有参数校验生成普通失败结果，避免零参数工具被意外执行。没有把参数错误升级为整个模型请求失败，也不从文本猜调用或补 ID。轻量 JSON 工具协议继续走既有解码器。
- `strict-tool-schema.ts` 按参考递归转换属性、items、anyOf/allOf；数值/长度/pattern/default 和不支持的 format 折入 description；无法表达的引用、tuple、字典等回落。**仅工具显式声明 `function.strict: true`、Anthropic 原生适配器且裸 `claude-` 模型、schema 可表达时发送 strict**。不默认开启全部工具，不改原 schema 或本地工具验证。工具契约改名时保留显式 strict 声明。

**消息与思考历史**

- `system-message-compat.ts` 在 OpenAI-compatible 序列化边界合并连续开头的 system，直接拼接，不补空白，保留最后一段 cacheControl 副本；之后的 system 留原位。Anthropic 的中间 system 也不再被统一提到开头。原 journal 不变。
- `reasoning-history-normalization.ts` 按顺序过滤跨模型/服务的签名思考，移除纯思考 assistant，清理末尾思考，移除空白/(no content) assistant 并在允许时合并相邻 user，最后给非末尾空 assistant 补占位。携带工具的 assistant、tool-result user 和请求期媒体绑定边界受保留；没有移植品牌账号身份分组。
- `reasoning-metadata.ts` 在 `_reasoning_blocks` / `_reasoning_origin` 保存可回放 thinking/redacted_thinking，身份由模型 ID 与服务地址摘要组成；不包含 API key。请求副本映射为 canonical reasoning blocks，再由原生协议转换；正文与请求状态不混入这些元数据。unsigned thinking 只可显示，不作为签名历史回放。
- 只有 HTTP 400 窄文案符合 thinking signature 拒绝时，受限错误体转为 `reasoningSignatureRejected` 布尔事实；错误原文不存储，`ProviderRequestError.toJSON()` 形状不变。providers 的 `request-shaping.ts` 通过既有一次语义恢复预算删除请求副本内的签名/脱敏块；保留正文，无正文且需要时补 `[Thinking removed]`，不重新执行结构 passes，不改原 journal。已提交正文/思考后不恢复。请求专用 `reasoningHistoryNormalized` 标记避免适配器再次归一化。
- 扩展接入主会话、子代理及工作流。对实时切换模型的 facade，准备请求及状态事件使用 upcomingProvider 身份，不把旧模型签名送给待启用的新模型。

**原生流适配**

- `anthropic-stream.ts` 从 `streams.ts` 提取，后者保留兼容导出。工具输入必须等对应 content_block_stop；重复 stop 不重复执行，重复/冲突调用身份拒绝。JSON 首次可解析、message_stop 或 EOF 不合成最终工具调用；截断 JSON 保留原终止语义，普通损坏 JSON 交给工具错误结果。
- 按 index 抑制 bare tool_result 的 start/delta/stop，不漏到正文、观察回调或执行。thinking start 的签名可回放，出现原生 signature_delta 时以原生拼接值为准；支持 redacted_thinking。只有闭合思考块留下回放元数据，空闲计时、取消、用量和结束原因继续沿用第 17 轮行为。
- OpenAI 的原生参数拼装以 finish_reason 关闭输入；单独 [DONE] 不授予工具执行权。本项目直接读原生协议，不引入 AI SDK；没有照搬仅为 SDK 重新拆帧/重编码的 fetch 包装、memory selector output_config 特例或 provider-native 托管工具。
- 新增 request_shaping 模块和四项 providers feature：请求整形、显式严格 schema、思考历史、工具流兼容，manifest/catalog 同步登记。

**验证与交付**

- Windows / Node v24.19.0：相关回归累计 78 项全部通过；新增 19 项聚合测试。包括待应用模型身份、媒体边界、原历史不变、strict 声明保留、一次签名清理和既有工具契约/子代理/工作流/重试/取消/媒体回归。
- 类型检查、插件门禁（30 插件、368 源文件）、行数门禁（893 个 TS 文件、最大 400 行）、构建（630 个 JS 模块）及 test:built 搬迁后运行验证通过。
- `tools/verify-request-shaping.mjs` 的源码版及 `--built` 版各 6 场景、12 次 loopback 请求全部通过，验证实际 wire、签名持久化/回放/恢复、部分正文不重放、工具只执行一次、未闭合调用和内部工具结果不执行。结果随工程保存在 `验收资料/验证记录/request-shaping-windows-{source,built}-round18.json`；请求记录均为模拟数据。
- 按用户要求只做相关验证，没有后端/前端全套；无前端源码改动，保留随附的 166 个 Web dist 文件。完整源码 ZIP 与相对第 17 轮的补丁 ZIP 更新清单；安装器、Docker、CI、macOS、真实剪贴板未在本轮验证。
- 无真实/收费模型调用，无提交、推送或发布。Z1 第 1–3 块完成；可选第 4 块并发准入/本地调试和后续 Z2 回合运行时仍未完成。

## 42. 引擎第 19 轮：模型执行层 Z1 第 4 块（2026-10-22）

基于第 18 轮完整包（SHA-256 `561fd450976c6f99b8002ced032abebcb079c909f0a6522db7196ab7a768bbf7`），在独立目录继续。主代理负责范围、实现取舍与验收，GPT-6-Luna / max 子代理仅执行指定模块和脚本。参考 ZCode v3.15.1 `aac4755666d09fdcd70272fcf063c077a639015f` 的 request-admission、runner 调用点及 diagnostics/debug。

**准入与生命周期**

- 共享 providers 增加可选 `ModelRequestAdmission` 端口、ticket 与 `admitAttempt`；agent 每个尝试先获取名额，再发布 started，结束或退避前释放，重试重新获取。状态观察者和 ticket publish 不改变执行结果，release 幂等；queue/admitted hook 与事件沿用插件端口。
- providers 插件实现进程内、每个绝对状态路径/服务地址摘要/模型的固定 FIFO 上限，默认 4；`XUENESS_MODEL_MAX_CONCURRENT=0` 关闭、1–64 指定上限。Windows 状态目录键不区分大小写；空组及时移除。配置首次按状态目录读取，重启生效。
- 排队同时遵守用户停止、宿主终止、回合截止时间和 providers 禁用；取消不产生持久供应商故障。慢路径 queued → admitted → started，`queuedMs` 单独记录，尝试 duration 从 started 计算；快路径没有虚构的排队时间。
- 主会话、子代理和工作流接入 `providerModelExecutionExtension()`。实时选择模型的 facade 在排队前取得实际绑定方法，排队与调用保持同一模型身份，排队中的新选择留到下一次尝试/请求。
- 媒体获得名额后才物化，传输只用临时 messages/options，不再把已物化消息写回请求对象；每次重试重新绑定并在退避前释放。原始会话消息不变。

**诊断与界面**

- `model-diagnostics.ts` 只投影计数、耗时、固定分类和白名单用量；字符长度是 UTF-16 `.length`，流次数统计适配器观察回调，隐藏思考只计数。没有报告用量时不推算 Token。
- `ModelDebugStore` 默认关闭，`XUENESS_MODEL_DEBUG=1` 启用；本状态目录 `model-debug/` 最多 100 份每次尝试记录，私有原子写入。没有 prompt/回复/思考正文、签名、媒体、工具内容、请求头、服务 URL、凭据或异常堆栈；写失败仅统计，不使请求失败。
- providers 新增 `model_admission`、`model_debug` 两项稳定功能 ID，catalog/manifest 同步登记四个模块。`GET /api/providers/execution` 返回本进程状态目录的准入和诊断快照，providers 禁用返回 403，不触发模型。
- Web、CLI、TUI 显示等待并发名额。Web 请求详情/历史表只显示真实 queuedMs（包括已报告 0），未知不补值；终止主状态覆盖旧活动阶段。TUI 同一逻辑请求更新一张排队卡，取消后结束等待显示。

**验证与交付**

- Windows / Node v24.19.0：55 项相关后端回归通过，1 项依赖已移除 Python 后端的历史对照跳过；新增 21 项聚合回归。覆盖 FIFO、取消边界、providers 禁用、宿主终止、截止时间、503 退避释放、媒体重绑、隐藏思考诊断、状态投影及既有重试/子代理/工作流。
- 前端相关回归 73 项通过；类型、插件门禁（30 插件 / 372 源文件）、行数门禁（902 TS 文件 / 最大 400 行）、后端构建（635 JS 模块）、搬迁后运行验证均通过。
- Web 构建 166 个文件，设计与 bundle 门禁通过；第一次构建遇到系统临时目录权限错误，切换本轮独立 TEMP/TMP 后成功。`tools/verify-model-queue-ui.mjs` 用实际构建 chunk 和 CSS 在 Edge Chromium 检查中文/英文排队、未知时间省略、实测时间和停止状态，0 页面错误、无横向溢出。
- `tools/verify-model-admission.mjs` 源码/构建版各 4 场景、7 次本地 HTTP 请求通过，验证实际 FIFO、取消不发 HTTP、503 退避中先执行等待者、重新准入、隐藏思考计数、内容不落盘及真实执行快照 200/403。构建版使用与生产一致的 `dist/apps/server` 入口，不从重复 workspace alias 导入 server。
- 记录保存在 `../验收资料/验证记录/model-admission-windows-{source,built}-round19.json` 与 `model-queue-ui-windows-built-round19.json`。只做相关验证，没有重复完整套件；无真实/收费模型调用、提交、推送或发布。
- 完整包与相对第 18 轮的补丁包更新清单。补丁包含完整 webapp/dist 快照，需先清理旧构建目录再合并，避免旧哈希资产遗留；详见补丁 ZIP 内 PATCH-ROUND19.md。安装器、Docker、CI、其它平台终端和真实剪贴板未在本轮验证。

**有意适配及下一步**

固定 FIFO 没有移植 ZCode workflow governor 的 AIMD、前台优先和 observer bypass；诊断不保存原始 I/O，也不使用参考 debug 的正文/推理录制。当前只治理主/子/工作流 AgentRunner，独立标题、语义压缩辅助请求、连接测试及模型发现尚未统一准入或诊断；不同进程之间不共享额度。详细操作与范围见 `../docs/model-execution-round19.md`。

Z1 本轮规划适配完成，整个引擎尚未完成。下一轮进入 Z2 回合运行时，先核对 turn-machine / turn-state / history hydration 与现有驱动的差距；Z2–Z8 剩余约 18–22 轮，仅为当前范围估计。

## 43. Z2 回合运行时与工具执行器：阶段交付（2026-10-22）

基于第 19 轮完整包（SHA-256 `a5b425ac032a302f57685ec12c24bd1e7ff4f4690894e0659504832e35520683`），在独立 `_stage-z2` 目录完成本阶段的 Xueness 适配。按用户最新要求，以阶段连续推进和统一交付，不再把内部工作块逐轮汇报；主代理决定范围、实现和验收，GPT-6-Luna / max 子代理仅执行指定模块。参考仍为 ZCode v3.15.1（`aac4755666d09fdcd70272fcf063c077a639015f`），本节与 [Z2 使用说明](../docs/engine-z2.md) 为当前状态，早期轮次保留为历史记录。

**回合与恢复**

- 共享 agent 增加 TurnState/TurnMachine 与通用生命周期端口；sessions 插件持久化 `runtime_turn`、独立 trace、阶段、模型尝试/工具调用/字符计数和最近 24 份结算快照。主会话、子代理、workflow actor 都接入；同一人类回合恢复时使用新 trace，计数不冒充跨恢复累计。隐藏思考只计 UTF-16 长度，不额外留存正文。
- sessions 的 history-hydration 配对当前 assistant/tool 历史：从已保存结构化结果或成功 JSON tool 消息恢复缺失一侧；真正缺失结果写为固定 `tool_interrupted`，不重跑旧副作用。待审批占位保留。请求副本按调用顺序配对、去重和过滤孤立结果，原 journal 不因请求排序而重写。
- files 从成功 Read/Write/Edit 配对 tool 消息的私有 `_read_state` 恢复 tracker；数据为真实 mtime/size/hash/partial/range，不保存额外文件正文、不以当前磁盘倒推旧读取。显式范围读取清除同路径旧依据，外部更改仍触发 stale。普通结果、模型载荷及分页文本剔除该元数据；批准后重放同样处理。

**工具执行与回合收口**

- 正常回合的 bridge 在授权通过后、handler 执行前发出 execution-start；结果先成功保存，再发布 `tool_result`。审批等待有独立状态，延期占位不会被错误标成执行失败。批准后重放在 beforeRun 沿用原恢复路径并保存快照，不计入随后新 trace 的工具数。既有只读并行批次、写入屏障、取消、Gate 与 lease 保留。
- 主会话在模型边界最多接入一条指导；文字回复已经保存后再检查迟到指导，继续同一回合且避免下一边界重复接入。原有持久 FIFO/CAS、send-now 推广租约与进程 lease 继续提供命令调度。
- shell 每个运行环境有自己的 manager binding，保存最多 32 个 owner 对应任务事实；模型边界或文字收口时投递去重的终态通知，读取输出次数保持为零。仅 running 计数变化更新快照，不继续调用模型。服务重启后缺失的旧 running 任务记为 lost/runtime_unavailable、exitCode=null，通知结果未知、不自动重跑。
- 系统后台通知仍进入模型上下文，但 Web/TUI/旧事件投影不显示成人类气泡、不增加人类回合或清除工具证据。空闲会话不自动唤醒模型，后台进程不跨服务重启。
- providers 为字符串 tool 请求内容加 65536 字节 UTF-8 首尾预算，原始结果/journal 保留；真实 `tool_result_read` 按 Unicode 字符分页读取当前会话结果 JSON，默认 1200、最大 4000 字符。主、子、actor 的 currentSession 绑定各自会话，未知/跨会话 ID 不可读。媒体继续走既有调用级绑定。

**归属及有意适配**

sessions 登记 turn_runtime/history_hydration/steering_boundaries，files 登记 read_state_restore，shell 登记 background_notifications，providers 登记 tool_result_budget；catalog 与 manifest 中英文功能和模块同步。宿主只接线，通用 agent/bridge 保持执行与持久边界，没有新插件包或放宽 allowlist。

阶段完成指上述明确范围。合并保存的流式快照保持既有实现，逐帧持久事件与通用 reducer、SQLite/迁移、fork/rewind/压缩持久化归 Z3；外部 now/next/later 协议归 Z7。未照搬第二套进程内优先命令队列、暂停嵌套模型排队计时的通用工具 deadline governor、动态工作流及官方 CUA/品牌/账户策略。既有工具超时和回合上限继续生效。

**验证与交付**

- Windows / Node v24.19.0：112 项相关回归，108 通过、4 项依赖已退役 Python 后端的历史对照跳过、0 失败。收口修正后仅重跑受影响的 shell 6 项并通过，不把重复运行累计为新增测试。类型、插件门禁（30 插件 / 380 源文件）、行数门禁（918 TS 文件 / 最大 400 行）、后端构建（644 JS 模块）与搬迁后运行检查通过。
- `tools/verify-z2-runtime.mjs` 源码及 `--built` 各 4 场景、10 次 loopback 请求通过：真实服务重启后恢复读取依据并写入、旧中断调用不重放、延迟请求中的指导收口、真实后台子进程终态通知且不消费输出。原始 JSON 与回归日志位于 `../验收资料/验证记录/z2-*`；模型均为本地模拟服务，隔离状态目录。
- 无前端源码改动，沿用基线 166 个 Web dist 文件并逐项核验哈希；不重复前端构建或无关全套测试。无真实/收费模型调用、提交、推送或发布。安装器、Docker、CI、其它平台和真实剪贴板不在本阶段实测范围。
- 完整 ZIP 与相对第 19 轮的补丁 ZIP 更新清单；本阶段零删除，补丁直接覆盖合并、保留现有 Web dist。依赖更新后运行 `npm --prefix ts ci`，构建版需重新 build。说明见 `../PATCH-Z2.md`。

下一阶段为 Z3 会话事件与存储。Z3–Z8 仍为六个阶段；早期估算合计 15–19 个内部工作块，不再当作汇报轮数或固定工期。整个引擎尚未完成。

## 44. Z3 会话事件与存储：阶段交付（2026-10-23）

从 Z2 完整包继续（SHA-256 `f6c65f6f97a38bcef40e5c612ff726fa6abc82cda643baed58529d9845409402`）。主代理负责范围、实现与验收，GPT-6-Luna / max 执行指定模块；子代理额度暂不可用时由主代理接手，恢复后继续用于定向验证。按用户要求，本阶段完成后继续 Z4。参考仍为 ZCode v3.15.1 `aac4755666d09fdcd70272fcf063c077a639015f`。

**本阶段能力**

- sessions 持久 JSONL runtime ledger、schema/envelope、单调序号/epoch、进程文件锁/fsync、纯 reducer 与断点投影；主/子/workflow 和手动模型压缩接线。保留完整可见文本，不采集隐藏思考正文、工具输入/结果正文或文件私有元数据。新 `/events.runtime` 分页和有限 SSE 支持 Last-Event-ID，旧事件协议保留；完整损坏行报错，只修复未完成尾行。
- `XUENESS_SESSION_SQLITE=1` 启用插件拥有的完整会话快照辅助库；JSON journal/原修订链仍为权威。Node SQLite 的 WAL、带 checksum 的迁移、批量事务、无损数字 codec、root 授权查询、JSON reindex 和新空目录导出均有实际入口。库提交失败可发生在 JSON 已发布之后，错误返回后应查询 journal/reindex，不重跑旧副作用。导出只包含 journal/history，不是媒体/队列/配置等全状态克隆。
- 分叉 remap child-local message/turn/tool/result ID，媒体改绑精确 owner，指导与后台通知仍属原回合。稳定边界保留最近 64 份连续消息锚点。消息回退持有运行 lease、核验 revision，记录 branch cut/generation，保留目标 prompt 前缀、移除旧结果与活动状态并暂停；不自动启动模型或回放工具。
- files 在授权后、handler 前保存真实 before 字节和存在/mode，结果持久后保存 after hash。Write/Edit/ApplyPatch 含 move/delete 的多文件计划可预览和合并；核验当前 hash 后恢复，外部修改拒绝，失败补偿。文件回退与对话回退分离，不覆盖 shell/MCP/网络副作用。
- 模型/手动确定性压缩先保存独立 operation，再在同一快照发布摘要 boundary/checkpoint/completed；失败、重试、中断有明确状态。冷恢复仅匹配 operationId 证据，不凭旧摘要推断成功。
- 新 ledger、file-history artifact 与 SQLite 行进入永久删除；软归档保留，恢复更新库记录。新能力登记于 sessions/files 的中英文 features/modules；宿主只接线，没有扩大 allowlist。

**验证**

Windows / Node v24.19.0。19 个相关文件的 runner 汇总为 75 tests、74 pass、1 skipped、0 fail；另有 3 个整体跳过的历史 Python 对照 suite，均因已退役后端不存在，不算通过。一次组合日志在 `../验收资料/验证记录/z3-targeted-tests-windows.log`。类型、插件门禁（30/393）、行数（939 TS/最大400）、构建（659 JS）、搬迁空 PATH 检查通过。旧 auto-compaction fixture 因 Z2 工具结果预算不再触发，调低该测试的窗口保持原目标，没有改产品阈值。

`tools/verify-z3-runtime.mjs` 用实际 ApplicationApi/FrontDoor，source/built 各4场景、3次loopback模型请求通过：8页/36事件的冷恢复与SSE、SQLite无损导出后续写、指导/通知下的独立分叉身份、真实文件handler快照和文件/对话回退/零重放。Web源码未变，166个dist文件与Z2逐项hash相同。记录详见 `../验收资料/验证记录/z3-*` 与 `../docs/engine-z3.md`。

**交付与边界**

完整包与相对 Z2 的零删除补丁统一交付，应用见 `../PATCH-Z3.md`；无真实/收费模型调用、提交、推送或发布。SQLite采用Xueness辅助快照库而非参考全部多表产品迁移；JSON/媒体/归档协议与运行lease保留，未建立跨JSON/SQLite/artifact的通用事务。ledger当前完整保留，没有参考turn-window自动淘汰。外部客户端协议仍归Z7，安装器/Docker/CI/其它平台不在本阶段实测范围。

Z3 的上述适配完成，整个引擎尚未完成；下一阶段 Z4 执行适配与工具深度，按用户最新指令直接继续。

## 45. Z4 执行适配与工具深度：阶段交付（2026-10-23）

从 Z3 完整包继续（SHA-256 `2e3e67ba3fd0c82b76d356cb51c71d3d520e3cfddcc99ca9190730d2362c76c5`）。按用户要求，完成 Z3 后直接完成本阶段；主代理决定范围/取舍/验收，GPT-6-Luna / max 只执行指定模块。

**本阶段能力**

- shell 增加 Bash/Git Bash provider、授权后懒加载 .bashrc 快照、按内容 hash 的 startup script 和实际状态绑定配置 API。默认 Windows PowerShell 保持；argv 跳过初始化，Windows .cmd/.bat 通过平台调用参数桥接。主/子/workflow 使用实际 shell 权限分类；启用初始化/启动脚本时不免批。配置变更取消活动主运行，插件生命周期停止任务并清理自身临时脚本。
- files 拥有字节 API 与 Read/Write/Edit 策略，共享 NodeWorkspaceFileSystem 提供路径、流式 UTF-8 行范围、定位字节读取、完整 SHA/版本、取消和文件机械操作。UTF-16/GBK 保留有界整文件解码回退。范围私有快照不恢复完整编辑依据。Write/Edit 替换前校验 revision；create-only 使用硬链接，现有文件是乐观写前检查，不是跨进程事务 CAS。file-bytes 默认4096/最大65536字节，远程会话409。
- network WebFetch HTTP 输入升级 HTTPS，GET 最多五跳，每跳完整 DNS 检查并固定连接地址，统一超时/取消预算。保留严格私网/FakeIP/DoH规则、插件grant与批准，搜索POST/DoH不跟随跳转。首次预览16000字符、data存完整提取文本；15分钟/50MiB内容预算LRU按规范URL和DoH配置隔离。
- network活动通过ToolEnv绑定到主/子/workflow，由sessions持久为NetworkRequest；只保存origin/固定阶段/计数，不保存query、header或正文。providers补齐tool_result_read的manifest声明及宿主目录，实际PluginHost中的全文分页可用。

**验证与边界**

Windows/Node24.19，真实Git Bash与cmd桥接。宿主7文件32tests/31pass/1退役Python skip/0fail；文件分支39pass/1POSIX-only skip，受影响3文件随后11/11；shell/exec10/10；network10pass/1历史Python skip。双引号及batch路径引用收口后仅重跑受影响9项并通过。分批重复不累计为新测试。类型、插件30/399、行数953/400、后端构建669JS和搬迁空PATH检查通过。

另在最终构建上复用 Z3 的4场景验收，确认 SQLite 无损导出、分叉、真实 Write 快照及文件/对话回退继续通过（3次loopback请求，零副作用重放）。

实际ApplicationApi/FrontDoor source/built各4场景、3次loopback模型请求通过，覆盖保存配置不执行、获批初始化、范围Read、字节API/开关、逐跳请求、缓存、全文分页和5个持久活动；未访问公网或真实/收费模型。Web源码不变，166个dist文件与Z3逐项hash相同。Linux/macOS原生未实测，本机Docker daemon未运行，未为测试启动服务。

使用和明确适配见`../docs/engine-z4.md`，日志与JSON在`../验收资料/验证记录/z4-*`。无粘滞cwd、隐式后台提升、隐藏模型处理或跨宿主进程恢复；初始化签名不跟踪间接source文件。完整包及相对Z3的零删除补丁见`../PATCH-Z4.md`。

Z4上述适配完成；下一阶段为Z5 MCP/配置/hooks。Z5–Z8仍有四个阶段，早期内部规模约10–13块，不能当作固定工期；整个引擎尚未完成。

## 46. Z5 MCP、配置与 hooks：阶段交付（2026-10-23）

从 Z4 完整包继续（SHA-256 `da66d5f8bcdf240f1ca165691049d24e6f347eb7d5da68f8d74da883f80aceed`）。参考 ZCode v3.15.1 `aac4755666d09fdcd70272fcf063c077a639015f`。主代理负责范围、实现与验收，按用户最新设置，GPT-6-Luna / max 只执行指定模块和验证。早期章节保留为历史记录，当前行为以本节和 `../docs/engine-z5.md` 为准。

**本阶段能力**

- settings 拥有数据层加载、深合并/数组替换、叶子 provenance、脱敏候选/有效视图、用户层原子保存与项目配置摘要 trust。低到高为默认、旧 shell 配置、state/runtime-config.json、可信当前根 .xueness/config.json、XUENESS_RUNTIME_CONFIG JSON、显式宿主配置。实际域只支持 shell 和 MCP；原 MCP 有效资源条目在连接时作为基础层。GET/POST `/api/runtime-config` 和 POST `/api/runtime-config/trust` 接入实际 ApplicationApi，受 settings 与已授权根约束。
- 项目文件默认 pending，规范根+整文件 SHA 精确 allow/revoke，变更失效；不扫描父目录。GET 可先看 workspaceCandidate，所有 MCP env 值及敏感键脱敏，自由文本仍可见。查询/保存/信任不启动进程。hooks 从配置中剔除，原开关和独立信任不合并。原 shell/settings 写旧低优先级层；有效值以新视图 provenance 为准。
- hooks 新增 .xueness/config.json nested hooks 的 source index2，旧 index0/1 与摘要保持。每条派发前重读 feature/trust/文件摘要；additionalContext 有界标注为不可信输入，updatedInput 在 schema/subject/Gate 前应用，Stop 每run最多继续一次。取消不启动后续 hook；仍只执行 process/argv，不自动执行 command shell字符串，权限 hook 不越权。
- MCP 插件激活内 connection pool/port/binding，key包含owner/cwd/配置指纹，lease引用计数与初始化去重；运行结束/卸载关闭。tools/list_changed实际刷新注册/模式，资源订阅按声明能力提供并继续经过Gate；通知只计元数据，不读资源内容或唤醒模型。请求/工具/资源接受signal，取消清等待、尽力通知，不自动重放；HTTP新明确调用可以重连。stdio cwd/env实际生效，Windows batch沿用Z4执行适配。
- GET `/api/sessions/:id/mcp-runtime` 只读活动元数据，要求 sessions/mcp有效及会话根授权；空闲不建立连接。McpActivity 经 contracts schema/reducer 与 sessions durable sink 保存，排除配置、凭据、URI和正文；异步队列最多100，模型/工具结果/结算边界发布，durable失败在这些边界传播。catalog/manifest同步实际features/modules/routes，没有新插件或allowlist扩大。
- 修复 Z4 同样可重现的授权计划草稿被 filesHistoryExtension 阻断问题：工作区外已授权文件不记录工作区 rewind，其他快照错误仍传播；bridge/Gate/roots不放宽，现有草稿用例检查实际写入且无file_history记录。

**验证**

Windows / Node24.19。最终用例去重67 tests/64pass/3skip/0未解决失败：宿主6文件21/19/2（首次草稿失败已在Z4重现并修复，仅重跑该项；新增1项旧MCP资源与新配置层合并）；MCP5文件25/24/1；hooks2文件13/13；配置4/4；文件回退4/4。整体跳过的POSIX hooks和退役Python suite不计通过。原失败日志、修复及最终分支日志保留于 `../验收资料/验证记录/z5-*`，不把重复执行累计为新测试。

类型、行数964TS/最大400、插件30/406、构建677JS和搬迁空PATH检查通过。真实ApplicationApi/FrontDoor source/built各4场景、4次loopback请求，包含真实Node MCP/hooks与Git Bash：候选审阅零连接、摘要信任、独立hook信任、真实项目shell、重写参数、上下文、运行中撤销、一次Stop继续、订阅/持久脱敏活动、取消零重放及插件门禁。最终构建另跑Z3四场景、3次loopback请求，SQLite无损导出、分叉和文件/对话回退通过。Web源码未变，166个dist文件与Z4 hash相同，不重复前端构建或无关全套。

**适配范围与交付**

连接池不跨run/workspace/session常驻。原手动OAuth PKCE/finish/refresh/revoke和elicitation保留，没有官方身份、自动DCR、遥测或新OAuth发现。HTTP stop向工具传播仍需原 `general.sessionsCancelPropagateEnabled`，默认未改；直接signal取消有实际测试。主会话接入MCP运行端口与hook输出；workflow actor读取shell配置，动态工作流完整工具编排归Z6。

完整包及相对Z4的零删除补丁见 `../PATCH-Z5.md`。没有真实/收费模型调用、提交、推送或发布；Linux/macOS原生、安装器/Docker/CI未实测。Z5上述适配完成，下一阶段Z6动态工作流；Z6–Z8剩三个阶段、早期约8–11内部工作块，不是固定工期，整个引擎尚未完成。

## 47. Z6 原生 TypeScript 动态工作流：阶段适配交付（2026-10-23）

从 Z5 ZIP `Xueness-0.1.8-Z5-20261023.zip` 继续，基线 SHA-256 `0d221c0c3c404e54cb3af84aaef30bcb480007329c30c4d210af49b2e0a895c9`。当前范围和用户文档见 [Z6 使用说明](../docs/engine-z6.md)，阶段摘要见 [Z6 工作总结](../WORK-SUMMARY-20261023-Z6.md)。Z6 有意适配范围完成；不是完整 ZCode 上游兼容。按用户指令下一阶段直接进入 Z7。

**编译器与脚本语言**

- 在旧 JSON DAG/Python 式 DSL 旁新增原生 TypeScript AST 子集，源上限 32,000 字符。共享纯 compiler/schema/interpreter 位于 `ts/packages/agent/src/script/`，由 `@xueness/agent` 拥有；TypeScript 5.9.3 生产运行依赖登记在 agent 包。`workflows` 插件没有外部依赖，构建 allowlist 不变。
- compiler 负责 AST parse 与受限静态子集检查，不是完整 `ts.Program` 类型检查，不使用 `eval`、`vm` 或任意 JavaScript。支持变量、if、for/for-of/while、break/continue、纯 JSON 数组和对象/属性、模板、白名单值方法、Promise.all、`agent(name, persona).ask<T>`，以及 `files.read/glob`、phase、log、report、hole。
- schema 支持 interface 继承/alias、object optional、array、union、Record；通用 validator 补 `anyOf` 与 schema `additionalProperties`。不支持 import、Node globals、任意函数/类、完整 TS 生态、`world.run`、引用库全部图形/流式 artifact/dashboard 能力或 VM harness，不能描述为逐项照搬。

**运行、工具与权限**

- workflow 插件拥有 `dynamic-store`、engine、service、HTTP、tools 及 actor 调度和 JSON 日志。按 site-kind ordinal/input hash 缓存；同 actor FIFO，跨 actor 并发 1–8 即时调节。节点结果/report 唯一存储，holes 与 actor 问题可显式 resolve；recover/resume 由用户显式触发。解释器默认最多 100,000 operations 并定期 yield，以支持取消。
- compile/create 只解析和建草稿，不执行。start 要求确认当前 digest，绑定 root/sourceHash/writable/maxConcurrency；parent plan ceiling 不能被覆盖，默认只读。真实模型调用还需 `allowReal` 与原宿主开关。owner 精确绑定 parent session/root，拒绝 remote session。
- Typed actor 经实际 AgentRunner 生成 JSON final 并最多 repair 两次，不调用 `submit_result`。同 run 的多次 ask 保留 actor transcript。已保存的 provider、文件、shell、planning、office、network 工具继续走其既有权限；没有 MCP/hooks actor 授权旁路。
- 普通 resume 沿用同 actor session。只读 amend 创建新 run ID，仅 workspace fingerprint 和 node input hash 均相同时导入 ask/read cache；需要 live ask 时用新 run 的新 session，不复制旧 transcript。显式 resume 可继续未完成 actor journal，但不承诺外部副作用 exactly-once。HTTP host.close 取消并 drain 当前运行；没有 script detached worker 或跨宿主后台恢复保证。旧 DAG detached 行为保留。
- 显式文本 log 上限 2,000 字符，events 最近 1,000 条并用单调 seq；report/results 单独保存，不是原始模型 I/O 遥测。

**入口与 TUI**

HTTP 入口为 `GET/POST /api/sessions/:sid/workflow-scripts`、`POST .../compile`、`GET .../:runId`、`GET .../:runId/events?afterSeq` 和 `POST .../:runId/{start,resume,cancel,concurrency,resolve,amend,recover}`。八个工具为 `workflow_script_create/run/status/list/cancel/concurrency/resolve/amend`。CLI `workflow-script` 提供 `check/create/list/show/start/resume/cancel/recover/concurrency/resolve/amend`；start/resume 等待 settlement。完整 flags 与请求体见 Z6 说明。

TUI 已将 script run 合入已有 workflow 卡片/侧栏，state watcher 识别 `dynamic-workflows`，composer data 增加八个工具。Web 源码及 166 个 `webapp/dist` 文件未改。

**验证与边界**

Windows / Node 24.19。最终相关用例按身份去重 84 tests：83 pass、1 个退役 Python oracle 历史 skip、0 未解决失败。其中旧 script/runtime 79 项全部通过，TUI 两文件新增 5 项（4 pass、1 历史 Python skip）；重复重跑不累计。类型、行数门禁（988 TS/最大 400）、插件门禁（30/416）、构建（698 JS）和搬迁空 PATH 运行通过。

source 与 built 的 ApplicationApi/FrontDoor 各 4 场景、7 次 loopback 请求，均 0 失败：草稿 compile/create 零执行，digest/owner 校验，typed repair、loop、fanout、world read、hole/resume 零重放、唯一 report、amend cache zero dispatch、POST cancel 与 host.close 取消在途请求且不重放、插件 403。Linux/macOS 原生、安装器、Docker、CI 未验证；无真实/收费模型调用、提交、推送或 publication。验证日志在 `../验收资料/验证记录/z6-*`。

新完整包与相对 Z5 的零删除补丁说明见 `../PATCH-Z6.md`。Z7/Z8 剩余两个阶段，早期估算合计 5–7 个内部工作块；整个引擎尚未完成。

## 48. Z7 原生 app-server 与 headless：阶段范围记录（2026-10-23）

本节记录 Z6 完整工程之后的 Z7 原生适配。行为参考为 ZCode v3.15.1，commit `aac4755666d09fdcd70272fcf063c077a639015f`。本节及 [Z7 说明](../docs/engine-z7.md) 记录已实现接口和限制；source/built runtime、额外 shutdown drain、build 与搬迁 smoke 均已通过，包清单与哈希见外部 Z7 交接说明。

**协议与会话范围**

- `remote` 插件提供 stdio NDJSON JSON-RPC app-server。默认返回 `xueness.app-server.v1`，保留已有 remote manager 必需方法 `sessions/index`、`command/execute`、`command/query`、`conversation/snapshot`、`conversation/resume`、`session/read`、`response/read`。客户端明确请求 `protocolVersion: 2` 后返回 `xueness.app-server.v2`，增加 conversation/controller/workflow 投影订阅；`projectionVersion: 1` 与协议版本独立。当前 remote manager 的 hello validator 固定接受 v1，不声称自动协商 v2。
- 功能方法委派给 sessions、files、composer、workflows 等既有 HTTP owner。包含会话投影/分页与回退、durable command receipts/query、question receipts、withdrawal、guidance、媒体事务以及脚本 workflow 的读取/控制。command receipts 与请求 fingerprint 绑定、沿用 24 小时窗口及 owner CAS；不确定结果查询既有回执，不能重新提交未知副作用。旧 `turn/start` 保留 `legacyWritesIdempotent: false`。
- 身份取首个 `--workspace-root` 的 realpath；不传时使用当前目录 realpath。会话 ID 必须为 32 位小写十六进制，加载后会话 root realpath 必须精确匹配 workspace identity，remote session 拒绝。额外 workspace roots 只供 legacy host allowlist 使用，现代协议操作不跨身份 root。协议拒绝未声明字段及嵌套 routing 覆盖，不提供任意路由、秘密 provider 值或 raw tool execution。

**帧、订阅与生命周期**

- 输入 NDJSON 帧上限 1 MiB；最多 16 个普通并发请求，保留 8 个 control 名额；initialize/shutdown/exit 形成屏障。JSON-RPC reply 可乱序，stdout write callback 提供背压与顺序写入。大响应在 allowlist 方法上通过 `xueness.remote-fragment.v1` 传输：768 KiB 后按 256 KiB 分块，单响应 32 MiB、总量 64 MiB 或 8 个驻留传输，TTL 60 秒，按 workspace/session/hash 绑定；`controller/frame` 可无 session scope。
- v2 最多 16 个 subscriptions，每 200 ms 检查 conversation epoch/seq、workspace controller snapshot 与 workflow `afterSeq` events。subscribe ACK 先于 deferred initial/recovery frame；generation fencing 防止旧帧覆盖 resync。flow pause/resume 只管帧投递，不执行模型；projection 断点需显式 resync。
- app-server 只供父进程 stdio 信任，没有网络监听器或 Host/Origin/CSRF 层。EOF、shutdown/exit、remote 插件停用与宿主关闭会停止、关闭并 drain 本进程内活动；不提供 detached script worker 或跨宿主恢复保证。旧 JSON DAG detached 语义保留。browserTabs、interactiveTerminals 仍关闭。

**headless 入口**

CLI `headless` 复用 AgentRunner 和原权限/provider 配置：新任务用 `--prompt --root`，可用 `--resume ID` 与 `--prompt` 追加内容，或 `--continue --root DIR` 选择同 root 最近更新的非归档会话；`--attach PATH` 需与 prompt 同用。text 输出最终 assistant 正文，json 输出一个 `xueness.headless.v1` result，stream-json 输出 init/event/result NDJSON。完成/未完成（含等待用户）/运行错误退出码分别为 0/2/1。默认 mode 为 build，没有新后台 worker 或权限旁路。

**ZCode 对照及阶段验收状态**

ZCode V4 的协议载体复用 JSON-RPC；其独立 topic frame `wireVersion` 为 3，并有 `complete`/`fragment`、topic/subscription 身份及校验。Xueness 的 method、projection 和 fragment schema 是本产品原生适配，未实现该 V4 wire，也不声称完整上游兼容。未纳入账号、telemetry、官方 gateway、压缩 binary 或 network listener。

**当前验证**

Windows 相关回归按身份去重为 39 项：29 pass、10 项退役 Python oracle 历史 skip、0 fail、0 cancel；日志为 [`z7-targeted-windows.log`](../验收资料/验证记录/z7-targeted-windows.log) 与 [`z7-controller-flow-fix-windows.log`](../验收资料/验证记录/z7-controller-flow-fix-windows.log)。typecheck 通过；行数门禁为 1001 TS 文件 / 最大 400 行，插件门禁为 30 插件 / 422 source files。source runtime 真实子进程验收 7 场景全过，5 次 loopback provider 请求（app-server 挂起 run + control stop 1 次，headless 4 次），没有外网或付费模型调用；日志为 [`z7-runtime-source-windows.json`](../验收资料/验证记录/z7-runtime-source-windows.json)。

build 生成 706 JS modules，`test:built` 搬迁空 PATH smoke 通过（static UI、native session/history、plugin catalog、health、unowned-route 404），见 [`z7-build-windows.log`](../验收资料/验证记录/z7-build-windows.log) 与 [`z7-relocated-windows.log`](../验收资料/验证记录/z7-relocated-windows.log)。built runtime 真实子进程同样 7 场景、5 次 loopback provider 请求全过，0 fail，日志为 [`z7-runtime-built-windows.json`](../验收资料/验证记录/z7-runtime-built-windows.json)。EOF 与 remote 插件禁用时挂起 run drain 两个额外场景也已通过 source/built 单独验证，不计入 runtime 七场景：EOF 后自然 code 0 收口，重启 query 为 accepted/stopped 且零重放；禁用 remote 后 watchdog 自然退出 code 0 并 drain 在途 run，source/built 分别约 526/545 ms。每种模式两场景合计 2 次 loopback provider 请求，source/built 总计 4 次，成功路径未强杀进程且无残留进程。记录见 [`z7-shutdown-source-windows.json`](../验收资料/验证记录/z7-shutdown-source-windows.json)、[`z7-shutdown-built-windows.json`](../验收资料/验证记录/z7-shutdown-built-windows.json)，验证脚本为 [`verify-z7-shutdown.mjs`](../tools/verify-z7-shutdown.mjs)。Z6 基线 Web 审计通过：166 个 dist 文件哈希一致、Web 源码零改动、零删除，见 [`z7-baseline-web-audit.json`](../验收资料/验证记录/z7-baseline-web-audit.json)。无新增 package 或第三方依赖。Linux/macOS 原生、安装器、Docker、CI 未验证；没有真实/收费模型调用、提交、推送或 publication。

阶段说明及适配边界见 [Z7 使用说明](../docs/engine-z7.md)；当前摘要见 [Z7 工作摘要](../WORK-SUMMARY-20261023-Z7.md)。阶段之后的推进按主代理与用户的最终验收顺序记录，Z8 仍为路线图最后阶段之一。
