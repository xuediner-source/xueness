# 批量调用

本机插件 `batch_calls` 是 `dsh-batch-tool-calls` 1.1.2 的 Xueness 原生适配。上游来源：<https://github.com/liancha22/dsh-batch-tool-calls>。

适配保留独立侦查调用同一步发出、依赖调用按序执行，以及上下文压缩后恢复提示的行为。规则通过 Agent `hostInstructions` 注入；扩展同时识别成功压缩事件和会话中已持久化的 ZCode/semantic 压缩记录，因此手动压缩没有活跃 AgentContext 时也能接上提醒。提醒只在后续模型请求实际开始后消费。插件不提供工具、不改调度上限、不写消息或会话日志，现有 Gate 与审批流程继续负责授权。

`LICENSE` 是原 npm 包 1.1.2 附带的 MIT 许可证副本。
