# Web 与桌面的统一实时会话投影

第 5 阶段核心链路已完成。Web 与 Electron 共用的工作台现在优先消费 runtimes 插件的 journal 派生投影。旧 SSE、events/journal 水合及 `withAssistantStream` 只在 runtimes 关闭或接口明确不可用时进入兼容路径；同一会话的主显示不会同时拼接两套实时数据。

## 读通道与恢复

`POST /api/runtimes/v4` 的 `subscribe` 请求使用 `conversation/<sessionId>` topic。第一次立即返回 snapshot；后续携带 `base: {logEpoch, seq}` 和 `waitMs: 25000`，真实 Store 变化返回连续 deltas，等待到期返回空 deltas。有效水位严格续传；日志缺口、无效水位或窗口移除/重排返回新的 snapshot。结构变化切换 logEpoch，不把上游具有截断语义的 `row.removed` 当作任意单行删除。

订阅没有常驻后台任务。等待期间每 0.2 秒复查 sessions/runtimes 开关，通过文件签名变化或两秒的服务状态复查触发投影读取，不在等待期间持有 journal 写锁。前端只保留一个进行中的请求，切换会话、关闭插件和卸载组件会 abort；临时网络失败保留最后已接受内容，继续按原水位恢复，非法帧重新请求快照。

持久缓存只保留行身份与内容摘要，不复制第二份完整 transcript。重放日志同时限制条数和总计 8 MiB 字节；长回复导致的日志淘汰使用既有缺口快照恢复，避免每次 full-text upsert 无限制扩大状态文件。

所有内容来自同一次 Store 读取：用户输入、推理、工具参数与真实输出、审批状态、已保存消息、活动流和中断记录。完成流仅在真实 `final_message_index` 与正文匹配时关联已保存助手消息，使用相同 stream row identity；不追加第二条答案。没有来源的时间字段保持缺失或既有协议的零值，不生成耗时或成功证据。

本地展示扩展放在 `snapshot.meta`：`session` 复用 sessions 的公开序列化器，`outcomes`、`pendingQuestion` 提供已记录的完成/提问事实，`rowOrder` 提供源顺序，`window` 提供分页边界与源版本。rowId 是稳定身份，`createdAtSeq` 是展示顺序，前端不会按哈希 ID 排列正文。编辑/反馈仍指向真实 active messageIndex 和同一源版本；归档或流式行不生成可编辑索引。

## 历史分页

实时窗口和 `conversationPage` 都由同一个 projector 生成，每页最多 60 行。分页请求带 `sessionId`、`before` 和 `messageRevision`；会话变化拒绝旧页面，前端可以重试。更早记录保持虚拟化展示。前缀摘要变化或新 epoch 清除已缓存旧前缀；保留的历史消息使用当前 source revision 执行消息动作，避免加载新流后留下过期的修改目标。

## 归属与验证

后端在 `runtimes/projection.py`、`zcode_v4.py`、`plugin.py`；前端订阅/reducer 在 `plugins/runtimes/RuntimeConversation.ts`，既有视图适配与分页在 `plugins/sessions/runtimeConversationProjection.ts`。容器只协调状态与挂载。登记功能为 `runtimes.live_projection`，插件面板可见；Host/Origin/CSRF、Gate 与既有动作权限不变。

已通过 13 项相关后端测试、23 项相关前端测试、26 项架构单测、插件结构脚本、TypeScript 检查、生产构建与包体门禁。`verify-runtime-projection.mjs` 使用真实隔离后端和真实 dist，验证流式保存无重复、瞬态失败保留内容、切换会话、统一历史分页和关闭 runtimes 后的兼容回退；核验 1280/420 宽度与截图，页面错误、外网请求、模型调用均为零。报告在 `artifacts/runtime-projection-20261013/report.json`。

测试入口支持文件名过滤，默认无参数仍运行全部前端测试：

```text
python3 -m unittest tests.test_runtimes_projection tests.test_zcode_v4_adapter tests.test_runtime_live_projection -q
npm --prefix webapp test -- RuntimeConversation SessionPolling ZCodeConversation
npm --prefix webapp run typecheck
npm --prefix webapp run build
node webapp/verify-runtime-projection.mjs
```

此阶段提供有界 HTTP long poll 和 Xueness 展示扩展，不声称已实现全部上游 v4 topic、审批 command、workflow resume、附件或物理帧分片。Electron 原生安装包、Windows/macOS Intel/Apple Silicon 与外部真实 Agent 验收属于剩余第 6 阶段；当前 UI fixture 不代表真实模型效果。
