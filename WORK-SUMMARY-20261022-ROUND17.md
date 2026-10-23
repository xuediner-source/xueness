# Xueness 0.1.8 第 17 轮：模型执行层 Z1 第 2 块

基于下载目录中的 `Xueness-round16.zip`，完成空补全重试、流重试边界、事件空闲超时、请求生命周期统计，以及最终失败的中文提示和持久化。主代理决定范围并审核；子代理均为 GPT-6-Luna / max，仅执行指定任务。详细实现与后续方向见 [ts/HANDOVER.md 第 40 节](ts/HANDOVER.md)。

## 使用变化

- 异常结束且无正文、无工具、零用量的空补全，最多额外尝试一次，占用已有重试预算。正常 stop 不触发；连续异常空回复会显示模型服务错误。
- 失败尝试的半截工具输入暂存后丢弃；正文或思考文字产生后不再重放，部分输出得到保留，工具不重复执行。
- OpenAI/Anthropic SSE 默认 10 分钟没有完整 data 事件则超时，每次重试增加 30 秒；注释心跳不刷新计时，用户停止会立即结束等待。调用方可用 `modelRetry.streamIdleTimeoutMs` 调整，非正数关闭事件计时器。
- 每次尝试有 started/completed/failed 状态、唯一 attemptId 和实际耗时，逻辑 requestId 跨重试保持稳定；用量仅取供应商实际报告的白名单字段。
- 最终错误保存到会话的 model_failure，按认证、额度、网络、超时等分类给出中文提示。CLI/TUI 直接显示，Web 复用已有暂停原因提示；下次请求清除旧错误，取消不显示为供应商失败。

## 验证（Windows，Node v24.19.0）

- 相关回归累计 73 项：72 通过、1 项旧 Python 活动对照跳过、0 失败；其中新增 17 项聚合测试。按用户要求没有重复运行后端/前端全套。
- 类型检查、插件门禁（30 插件 / 367 源文件）、行数门禁（881 个 TS 文件 / 最大 400 行）通过。
- 后端构建通过（623 个 JS 模块），`npm --prefix ts run test:built` 的搬迁后运行验证通过。
- 本地 HTTP 验收：源码版和构建版各 7 场景通过，各 11 次 loopback 请求；覆盖空补全、失败工具前奏、正文后失败、401 中文持久化、空闲超时重试、取消，以及 Anthropic data 刷新计时。取消耗时分别约 116 / 114 ms，临时状态已清理。
- 验收使用实际 provider adapter、AgentRunner 和 SessionStore。构建版从 dist 的包入口加载，避免绝对路径与复制后的 workspace 包同时加载产生重复类型；无需修改产品模块解析。
- JSON 记录在 `验收资料/验证记录/model-execution-windows-{source,built}-round17.json`。复现：`node tools/verify-model-execution.mjs`；先 `npm --prefix ts run build` 后再加 `--built`。

## 交付与边界

完整包保留第 16 轮的 166 个 Web 构建文件；本轮没有改前端源码。补丁包相对输入的第 16 轮完整包，覆盖同名工程目录即可；文件清单更新为本轮内容，不含 node_modules 或 ts/dist。

没有调用真实或收费模型，没有提交、推送或发布。安装器、Docker、CI、macOS 与真实剪贴板未在本轮验证。下一轮是 Z1 第 3 块请求整形；整个 Z1 和其它引擎阶段仍未完成。
