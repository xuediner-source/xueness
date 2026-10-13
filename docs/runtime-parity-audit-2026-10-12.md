# Xueness 运行时/架构对齐静态审计（2026-10-12）

范围：`E:/models/apps/xueness-audit-20261010`；对照官方 ZCode `aac4755` 与 DeepSeek Harness 本地源。更新至 2026-10-13；六阶段实现与 Windows 原生验收已落地，源码全量发现的问题已复现修复并通过定向回归，最终 Windows backend 已重建、成品复核正在收尾。macOS Intel/Apple Silicon 两个 runner 未执行，仍阻挡三平台发行。

## 已经实际完成

- `runtimes` 已作为可信 bundled plugin 落地：后端 `xueness/bundled_plugins/runtimes/{manifest.json,plugin.py,runtime.py}`，前端 `webapp/src/plugins/runtimes/index.tsx`，可持久化选择 `zcode-full`/`pi-lite`，并校验版本化 JSONL request/response、stream chunk、tool call、replay envelope。
- 会话创建、CLI 和 HTTP 已接受并保存 `runtime_mode`；runtimes 插件还提供了独立的 `/api/runtimes/v4` 入口，承载受限的 v4 hello、conversation snapshot/resume、command ACK/query 和 CAS。
- 插件生命周期的 scope/inject/dispose 已有通用实现（`xueness/plugin_scope.py`），与 DSH/Cordis 的作用域思想相似；现有 sessions、subagents 等功能仍由插件目录承载。
- 历史/实时基础设施仍可用：旧 `events.v1`、journal/cursor、SSE 和会话持久化路径保留，运行时选择不会让状态目录注入任意 import/command。
- Pi-lite 的 HTTP/CLI 推理现由真实 bundled sidecar 承担，宿主继续处理文本/思考流持久化、工具调用与结果成对保存、精确审批和阻塞时停止；四项真实子进程/loopback fixture 集成已验证。
- MCP 的配置摘要、状态目录身份、变更回收、旧工具发现结果拒绝重定向、开关复查和 scope 清理已经接入现有外部传输；不授予新权限或动态 import 能力。
- 外部源码 ZIP 已有本地摘要确认、签名 HTTPS 导入、版本历史/回滚与默认禁用；批准后通过 MCP/ACP 独立进程调用，原始 ZIP/每文件摘要/发布者信任在执行边界复查。ACP v1 的 initialize/new/prompt、权限拒绝和取消已用真实 fixture 验证。
- Web 与 Electron 共用的工作台已优先使用真实 journal 派生的统一实时投影，连续水位 long poll、有界同源历史分页、推理/工具结果/审批状态及流式保存去重已完成；旧 SSE/journal 拼接仅在运行时不可用时回退。隔离真实后端与 dist 已验证切会话、瞬态失败恢复和插件关闭。
- 第 6 阶段已打通冻结 Pi-lite/ACP worker、签名依赖及外部解释器接线、平台/架构 manifest 和原生报告门禁；Windows 冻结 backend、Electron、NSIS 与便携包均有真实本地验收证据。相同 updater 代码的前一轮隔离 NSIS fixture 已验证数据保留；最终 HTTP 修改后重打成品与复核，未重复安装/卸载。

## 全量发现与修复收尾

本轮各套源码全量只运行一次：前端 1000/1000 通过，desktop Node 104 通过/6 跳过，backend Node 24 通过，desktop Python 13 通过。backend Python 执行 2918 项、91 跳过，原始全套有 1 个 Win10053 连接收尾 ERROR，保留在 `artifacts/native-stage6-20261013/windows/backend-unit.log`；不能把此日志表述为全套通过。

拒绝上传时的 Win10053 已由真实 socket 分段发送复现；共享 HTTP 边界在拒绝响应发出后采用 200ms/64KiB 有界丢弃，保留 CSRF、插件、Expect/TE/长度门禁与关闭连接要求。Goal HTTP fixture 的 LIFO 清理顺序改为先 shutdown 后 close；浏览器历史轨道断言等待两帧并核对焦点可见，再开始鼠标滚动。修后 HTTP/questions 23 项和 Goal HTTP 8 项定向回归全部通过，四个标准浏览器入口重跑全通过。没有重新运行修后源码全套，也没有宣称修后全套全绿。详细日志与原生结果见 [原生运行时验收](runtime-native-release-2026-10-13.md)。

## 仍是命名、投影或未执行的部分

1. **两个 profile 尚未成为两个上游原生运行时。** `provider_profile()` 保留宿主 standard/lightweight 的预算语义，Pi-lite 推理已通过 runtime factory/transport 转发到真实本地子进程，工具和持久化仍由宿主执行。未引入 `pi-agent-core`/`pi-ai`；ZCode profile 也没有独立的上游执行器。
2. **仍是受限 v4 适配器。** 适配器通过 `runtimes/bridge.py` 调用 sessions 的真实 Store/运行器，并由 `runtimes/projection.py` 从 journal 投影用户、助手、推理和工具 rows。Web/桌面已使用连续水位 long poll，旧事件不会被重命名为 v4。专用审批 topic/command、完整 workspace topic、workflow resume、物理帧分片仍未覆盖。
3. **stdio app-server 是自定义协议和 HTTP 转发器。** 入口常量为 `xueness.app-server.v1`（`xueness/bundled_plugins/remote/app_server.py:31`），`_session_create`/`_turn_start` 直接调用 Xueness `/api/sessions`、`/messages`（同文件 `369-445`）。它没有闭合上游 ZCode app-server 的 transcript hydration、command admission 和 v4 command envelope；上游对应实现见 `ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts:1`、`projection-state.ts:22`。
4. **真实上游 Agent 与完整跨平台发行仍待验收。** 源码 ZIP 安装/来源签名/版本回滚和 ACP v1 专用适配均已落地，市场原有 data-only 格式不变。尚未启动真实 DSH、安装 npm/pip 依赖、验证收费模型或打包上游 Agent；fixture 只证明协议和生命周期，不代表模型效果。
5. **Windows 已实测，Mac 仍需原生结果。** 冻结 backend worker 入口已修复，Windows x64 的真实 Pi-lite/签名/ACP、Electron 成品、ConPTY/工作流退出、NSIS/便携包均通过；最终 HTTP 修复后的 backend 和成品已重建并完成复核，汇总与安装包 SHA 清单已保存。隔离安装更新证据来自相同 updater 代码的前一轮 fixture，本次最后改动后未再次装卸。macOS Intel/Apple Silicon 具备原生 CI 与报告门禁，两个 runner 尚未执行，不能称三平台完成。该 fixture 验证不代表真实模型性能或能力。

## 最多五项下一步（按实施顺序）

1. 完成第 6 阶段剩余的两个 Mac 原生 runner 验收，保留真实平台报告；Windows 实测记录见 [原生运行时验收](runtime-native-release-2026-10-13.md)。
2. 在原生平台验证外部 Python/Node 运行时、签名库、ACP 生命周期及已有共享进程清理的后代回收。
3. 如继续扩大上游兼容范围，补专用审批交互 topic/command、workspace topic、workflow resume 与物理帧分片。
4. 完整档位独立上游执行器与真实 DSH/Pi 模型效果仍需单独运行验收；不以既有 fixture 代替。

## 结论

六阶段实现、一次源码全量和发现问题的定向修复已完成，Windows 最终 backend 与成品复核通过，证据汇总与安装包 SHA 清单已保存。backend Python 全套原有 1 个 ERROR，修后定向回归通过，未再跑全套；发布前仍需两个 Mac 原生 runner 的实际成功记录。fixture 验证不能替代上游真实模型、完整 v4 兼容或三平台发行验证。
