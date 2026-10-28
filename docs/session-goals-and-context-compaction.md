> Historical reference from 2026-10-12, before the TypeScript/Z8 migration; current behavior is defined by [README.md](../README.md) and [ts/docs/z8-guarded-goal-memory.md](xueness-plugin-architecture.md).

# 会话目标与历史整理

## 会话目标

在会话的目标编辑器中填写目标后，系统会在每轮请求中提醒模型。默认上限是 8 轮和 600 秒；编辑器也可以设置 token 上限。模型结束一轮后，planning 插件会调用当前配置的模型做一次不带工具的独立核验，并结合主机交付检查判断是否完成。完成措辞本身不构成证据。

目标可以暂停，也可以从暂停、受阻或预算已满状态继续。继续会开启一段新的预算分配；之前的目标记录仍保留在历史里。等待用户回答、等待工具批准或用户停止时，自动续作会停下。目标达到轮数、时间或 token 上限后，需要用户明确继续。

CLI 也能管理目标：`xueness goal --session <session-id> show`、`set <text>`、`replace <text>`、`pause`、`resume` 和 `clear`。替换现有目标必须使用 `replace`。

## 历史整理

当请求超过上下文预算时，providers 插件会把已结束的历史前缀整理成结构化交接摘要。当前用户轮次和未闭合的工具调用不会被移走；摘要会保留人类消息的覆盖 ID，并把原始消息存入会话检查点和归档。归档保留原文，供会话记录查看与恢复。

整理使用当前选中的模型配置，会产生该服务对应的 token 用量。摘要无效、超时或无法缩短请求时，系统记录失败并回退到原有确定性压缩；用户停止或外层请求时限到达时，会停止本轮，不会继续发起主模型请求。

两项功能都归各自插件管理：目标生命周期由 `planning` 插件提供，历史整理由 `providers` 插件提供。关闭所属插件后，该插件不会继续执行这些能力。
