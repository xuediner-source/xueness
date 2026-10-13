# runtimes 插件的 ZCode v4 适配器

`xueness/bundled_plugins/runtimes/zcode_v4.py` 现在把第一条 v4 契约链路接到真实 Store 和 sessions 运行器：

- `clientHello`/`hello` 使用 ZCode wire protocol version 3，并按 client mode 选择 continuous/replayable delivery profile。
- `conversation/<sessionId>` 订阅返回 v4 topic frame；有效 `logEpoch` 与 `seq` 从快照续传符合闭合集合的 `state.updated` deltas，失效水位重新发 snapshot。
- command envelope 使用 v4 `commandId`、`clientId`、`sessionId`、`baseRevision`/`baseLogEpoch` 和结构化 `CommandAck`；持久命令桶绑定 client 与请求指纹，提供重试幂等与 commands/query。
- `createSession`、`sendText`、`stop`、`forkAssistant` 调用 sessions 插件的真实 Store/运行器；journal 中的用户输入、助手文本、工具调用和工具结果由 `projection.py` 投影成 rows。`resumeWorkflowRun`/`resumeGoal` 在尚未有对应 Xueness 工作流事实时明确拒绝。

适配器是 runtimes 插件的可信构建模块，已在 `manifest.json` 登记为 `zcode_v4`、`bridge`、`projection` 和 Pi-lite transport modules，并依赖 sessions。Pi-lite 的 sessions runner 已消费真实 sidecar 流并复用宿主工具/审批持久化。2026-10-13，conversation 的有界 long poll、真实推理/活动流/审批工具状态及 Web/桌面统一消费已完成，见 [实时投影与验证](runtime-live-projection-2026-10-13.md)。专用审批交互 topic/command、sessions-index/workspace-config topic、物理 wire 分片及附件仍未覆盖；未覆盖的 v4 命令和没有安全边界的 fork 会明确拒绝，不会静默写入伪造投影。

验证：

```text
python -m unittest tests.test_zcode_v4_adapter tests.test_runtimes_plugin -q
python -m unittest tests.test_runtime_bridge tests.test_runtimes_projection -q
python tools/check_plugin_architecture.py
```
