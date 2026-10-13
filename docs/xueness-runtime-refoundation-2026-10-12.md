# Xueness 运行时重构基线

日期：2026-10-12

Xueness 的产品骨架改为“ZCode 工作台与会话协议 + DeepSeek Harness 式 profile/plugin 组合 + Pi 风格本地轻量运行档”。这是一项分阶段迁移，不把现有 Python Agent 循环一次性替换掉，也不让旧内核继续成为所有新能力的唯一实现位置。

## 目标

- `zcode-full` 是完整工作台档位。它以 ZCode 的 app-server、会话投影、命令信封和前后端交互为兼容目标，Web、桌面和 CLI 使用同一条事件通道。
- `pi-lite` 是本地模型档位。它只保留低上下文开销所需的 Agent loop、少量核心工具、流式响应和可恢复会话；Pi 的 `pi-agent-core` 与 `pi-ai` 是参考实现和适配来源，不把 Pi 当作模型服务。
- DSH/Cordis 负责 profile、插件生命周期、工具注册、hooks、skills、subagent 和运行时组合。插件的业务实现不再要求全部编译进宿主 Agent loop。
- Xueness 自己负责桌面壳、设置、品牌、本地模型配置、跨平台数据目录和迁移兼容。用户看到的是 Xueness，不暴露 ZCode、DeepSeek、Claude 或 Codex 的产品商标。

## 分层

```text
Xueness Desktop / Web / CLI
          │
          ▼
Xueness Runtime Host
          │  JSONL / NDJSON
          ▼
Profile Layer (DSH-style)
   ├── zcode-full  → ZCode app-server + v4 session/projection
   └── pi-lite     → Pi agent-core + pi-ai + local model
          │
          ▼
Provider / Tool / Session plugins
```

共享边界只保留状态、事件日志、租约、审批、工作区边界、传输和插件生命周期。运行时插件通过 `runtimes` manifest 声明 profile 与协议能力；状态目录只能选择已经构建进发行包的 profile，不能注入任意模块路径或命令。

## 协议基线

运行时边界使用严格的换行 JSON：每行一个对象，stdout 只允许协议帧，诊断写 stderr。第一阶段定义以下 provider-neutral 对象：

- `RuntimeRequest` / `RuntimeResponse`：带 `requestId`、`sessionId`、`method` 和结构化 payload。
- `StreamChunk`：文本、思考、工具调用增量、用量和结束原因使用稳定的 `type` 字段。
- `ToolCall`：工具名、参数、调用 ID 和完成状态始终成对保存。
- `ReplayEnvelope`：保存 provider-native 元数据的版本化外壳；无法重放时降级到 provider-neutral 内容，不伪造工具结果。

ZCode v4 的 transcript、projection、subscription 和 command inbox 是完整档位的目标读写语义。旧 Xueness journal 会通过适配层映射到该协议，迁移期间保留旧会话读取能力。

当前运行时插件提供 `/api/runtimes/v4` 的受限 v4 seam：它从 sessions journal 派生只读 projection，持久化有界 topic log 与命令回执，支持 hello、conversation snapshot/resume、command ACK/query、logEpoch/revision CAS，以及 create/send/stop/fork 的最小命令集合。它不会把旧 `events.v1` 重命名为 v4。新会话会把所选运行时写入会话日志；`pi-lite` 使用本地轻量模型循环与真实 sidecar，完整档位保留默认供应商行为。

2026-10-13，Pi-lite 已完成 sessions runner 接线：HTTP 与 CLI 使用 `runtimes/provider_transport.py` 装饰模型 adapter，每次推理调用 bundled sidecar，接收文本/思考增量与完整工具调用/用量结果。上下文预算、Store、工具、精确审批、journal 和流重放仍由现有宿主循环负责；sidecar 不建立第二份 transcript。等待期间每 0.1 秒检查停止及插件开关，完成、错误、超时与取消均回收子进程。配置限定 loopback IP endpoint，凭据不进入协议帧；会话明确保存的 `pi-lite` 可以独立于新会话默认档位运行。真实子进程验证与限制见 [Pi-lite 会话接线](runtime-pi-session-transport-2026-10-13.md)。

## 外部插件边界

内置且经过审计的模块可以进程内加载。第三方插件默认使用独立进程、MCP 或 JSON-RPC；manifest 只描述身份、版本、能力、入口协议和权限声明，不能直接成为 Python/Node import 路径。安装、版本兼容、来源摘要、权限确认、回滚和卸载在进入运行时前完成。

这保留 Xueness 现有 Gate 和工作区边界，同时把“插件可组合”从固定布尔开关推进到可替换运行时。未来的 `unlocked` profile 也必须是用户明确选择的运行策略，不能由普通插件开关隐式授予系统访问。

2026-10-13，MCP 已补配置摘要与状态目录绑定、变更回收、旧工具发现结果拒绝重定向、plugin scope 回收及协议资源限制。源码 ZIP 另经 extensions 的精确摘要/签名导入、不可变版本/回滚和默认禁用机制进入外部进程，ACP v1 单次调用由可信 MCP facade 适配；市场仍保留 data-only 格式。见 [外部插件边界](runtime-external-process-boundary-2026-10-13.md) 与 [源码包说明](runtime-source-packages-2026-10-13.md)。

## 迁移顺序

1. 完成 `runtimes` 插件和协议对象的纯本地校验，旧 Python loop 保持默认兼容。
2. 将 runtimes 的 v4 seam 接到真实 sessions journal 和执行器，闭合 create/send/stream/stop/fork/resume 的最小链路。
3. **已完成会话接线**：Pi-lite sidecar 接入本地 loopback provider route；HTTP/CLI 共用宿主工具、审批、流式 journal 和停止流程。
4. **已完成本阶段核心链路**：MCP/ACP 外部进程边界、来源签名、源码包安装/版本回滚/批准及 scope 回收；真实 DSH 运行效果与跨平台发行留在相应原生验收中。
5. **已完成本阶段核心链路**：Web/桌面主会话使用同一实时 projection、连续水位恢复、真实推理/工具/审批事实与有界历史分页；旧事件拼接只保留明确的兼容回退。见 [统一实时投影](runtime-live-projection-2026-10-13.md)。
6. **实现与 Windows 本机验收完成**：冻结 worker、签名依赖与许可证、真实 Electron/资源路径、NSIS/便携包、隔离安装更新和退出回收已验证；macOS Intel 与 Apple Silicon 已接入强制原生报告门禁，但本机尚未执行，发布仍需两平台实际成功。见 [原生运行时验收](runtime-native-release-2026-10-13.md)。

## 来源与许可

ZCode 代码和适配材料按其 Apache-2.0 许可及 NOTICE 保留归属；DeepSeek Harness 按 MIT 许可保留第三方声明。Claude/Codex 桌面逆向材料只用于交互、IPC、生命周期和窗口行为研究；不把产物级 Electron/webview bundle、商标、图标或服务凭据打进 Xueness。Xueness 的应用名称、图标、界面文字和发布包只使用自己的品牌。
