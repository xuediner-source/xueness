# Pi-lite 会话执行接线

选择 `pi-lite` 后，HTTP 和 CLI 的模型请求由 `runtimes/provider_transport.py` 转发到内置 Python sidecar。配置使用已保存的本地 provider；endpoint 必须是 loopback IP（如 `127.0.0.1` 或 `::1`）。不从会话或资源读取 executable/import path，也不在 JSONL 帧里传 API key。

宿主仍使用原来的轻量上下文预算和 Agent loop。sidecar 只收到本次预算后的 messages/tool schemas 和已验证的运行参数，返回文本/思考增量及完整 provider result。工具调用和用量沿用该完整结果进入宿主；工具实际执行、精确审批、工具消息成对保存、Store/journal、stream_history 与后续 v4 投影均走原有路径。

每次模型推理拥有独立子进程，正常结束、回调失败、协议错误、超时或取消均回收；等待期间以 0.1 秒间隔检查用户停止、runtimes/sessions/providers 的实际开关。stdout 队列有上限；每一响应同时匹配 requestId/sessionId/method。诊断不回显密钥、提示词或 provider 原始错误内容。请求被 provider 拒绝时保留安全的状态码、分类及 context-overflow 标志，供现有恢复逻辑使用。

新建/单次 CLI 会话持久化 runtime_mode/runtime_profile；明确保存的 Pi-lite 会话可以独立于新会话默认档位运行。运行中模型切换在下次推理前应用，新选择重新校验本地 endpoint，并使用新的子进程。冻结 backend 使用插件自有 `pi-lite-worker` CLI 入口，原生发布包检查仍在后续打包阶段。

`tests/test_pi_session_transport.py` 的四项检查使用隔离状态、真实 bundled 子进程及一次性 loopback SSE fixture：HTTP read 成对落盘及流重放、write 拒绝后精确审批消费一次、停止阻塞请求且不伪造消息、CLI read 通过 sidecar。它们只验证接线与权限，不作为真实模型能力或性能数据。

本实现是 Xueness 的 Pi 风格本地运行档，没有引入或宣称兼容 `pi-agent-core`/`pi-ai`。上游 ZCode v4 的持续推送与专用审批 topic 仍属于统一投影阶段。
