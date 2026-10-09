# Xueness 工具调用审查与修复（2026-10-09）

## 对照范围

Xueness 修复基线为 `5afa8a7`。ZCode 从官方仓库重新获取 HEAD，确认最新源码仍为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。本机 Codex CLI 为 `0.150.1`，通过它的 `app-server generate-json-schema` 生成当前版本的接口定义。没有运行收费云模型，也没有读取 Codex 的个人对话。

| 环节 | ZCode / Codex 公开实现或协议 | Xueness 原有本地配置 | 本轮处理 |
| --- | --- | --- | --- |
| 模型工具调用 | ZCode 用 AI SDK 的原生工具字段；OpenAI function calling 的调用与结果通过调用 ID 配对 | 当前本地配置为 JSON 正文工具对象；没有 API `tools` 字段或约束解码 | 保留 JSON 兼容路径；实测原生路径后选择本机配置。不会看到模型名字就自动切协议 |
| 桌面与 Agent 通信 | Codex app-server 是双向 JSON-RPC，`item/tool/call` 携带 `callId`、`tool`、`arguments`、`threadId`、`turnId` | Xueness 使用自己的 HTTP、journal、事件与 delta 协议 | 不把 JSON-RPC 误解为模型必须用 JSON 写整段回答。协议层不同，不能宣称实现完全相同 |
| 流式工具片段 | ZCode assembler 分离展示片段和可执行完整调用，按 ID 管理完成状态 | 按 index 拼接，但 ID 冲突、参数类型和完成后的新片段缺少保护 | 校验 index、ID、类型与完成边界；完整调用才进入 journal 和执行 |
| 输入错误 | ZCode 将参数异常记录为可诊断的输入事件，继续走工具验证 | JSON 工具格式失败只有泛化报错；工具参数错误常只有 `ValueError` | 重复键、非有限数、非法 Unicode、必填项、类型与已声明约束在副作用前返回明确工具错误 |
| 协议恢复 | 宿主保留独立失败诊断和有限恢复边界 | 修复计数整轮累积；插入英文助手假消息；失败流被丢弃 | 计数改为连续错误，成功恢复后归零；独立有界诊断；失败流以 interrupted 归档，重连能结束 |
| 最终回答 | 原生工具与自然语言输出分开；不普遍要求答案正文 JSON | JSON 兼容模式要求答案也在字符串里；原生轻量模式的证据格式说明不足 | 原生回答保留 Markdown，末尾 `Evidence: E1, E2` 由宿主核对当前轮真实成功引用并隐藏。JSON 证据封装继续兼容 |
| 兼容诊断 | 应验证调用、结果回传、最终回答 | JSON 诊断竟使用另一个 `tool_call/name` 格式；只验证第一步；推理请求限时沿用模型列表 GET 的 8 秒 | 与生产 decoder 共用 `tool/arguments` 格式，增加 JSON 流式完整回合；120 秒总限时、每次最多 1024 输出 token |
| 明确指定的可选工具 | 实际工具能力应可发现，不能混同权限 | 即使用户明确说 `web_search`，轻量模式仍藏起它；模型可能直接回答“没有该工具” | 仅从最新人类消息匹配实际工具名，按可选工具预算提前暴露 schema；不读取工具正文触发，不绕 Gate / 插件开关 |

## 实测与不能混淆的指标

最初使用本机 `qwen3.8-27b`、相同加法工具题、相同采样参数，分别测试 none / xhigh 与 native / json。原生两档均完成调用与结果回传；JSON none 成功，JSON xhigh 在第二步直接输出正确的收据字符串，违反 JSON 包装，复现了宿主的解析失败。四个回合、八次请求是小样本兼容证据，不是长期成功率或性能基准。

用户报错会话中，失败请求的结束原因为 `stop`，输入 25,437 token、输出 3,560 token，未到本机 64K 上下文或 6,144 输出上限；之后的 Tavily 请求能返回结果。因此该次失败不能归因于搜索接口或输出截断。旧代码没有保存原始失败响应，无法追溯具体哪个字符或字段不合规；本轮只报告可证实的边界和独立复现。

修复后的真实模型测试使用同一服务和采样参数（temperature 0.7 / top_p 0.95），上下文配置 65,536，任务测试输出上限统一为 2,048。none / xhigh 分别代表无思考 / 极高思考。每格一次，调用顺序和缓存不同，耗时仅是观察值，不能据此宣称性能提升比例。

| 测试 | JSON none | Native none | JSON xhigh | Native xhigh |
| --- | --- | --- | --- | --- |
| 两文件读取、求和 17+23 | 完成，答案正确；8.954s | 完成，答案正确；4.468s | 完成，答案正确；16.937s | 完成，答案正确；6.094s |
| 真实 Tavily 搜索 ZCode 仓库 | 完成；9.375s | 完成；8.890s | 完成；12.860s | 完成；10.906s |
| 三文件、144 行、多项汇总，最多 12 步 | 达步数上限，没有正确交付；57.859s | 达步数上限，没有正确交付；67.735s | 完成，全部合计正确；63.938s | 合计正确，但仍有此前失败命令，待审核；113.328s |

上述 12 个生产运行链路样本没有工具协议解析失败。8 个短任务 / 搜索均完成并通过当前轮工具引用核对；搜索各只实际调用一次 Tavily。多项汇总的四个样本只有 2 个答案正确、1 个完整交付，失败包括模型写错 PowerShell 5.1 命令及重复尝试，不能用“格式修复成功”掩盖。真实用户配置仍保持 64K / 6,144；测试的 2,048 输出限制与 12 步上限属于隔离实验。

工具证据通过，只证明引用指向真实成功工具结果，**不证明模型每一句话或算术答案正确**。另一个三文件求和试验中，JSON 模式曾给出错误数字却满足工具证据引用；原生模式也出现正确短答但证据缺失。保留这些失败，不能选择性只统计成功样本。

同一台本地模型在此前 ZCode 对照中也出现长任务重复、手动停止及错误答案，不能宣称“其它 Agent 永远不会失败”。Codex 官方协议审查也不能代替同模型实测。

## 执行与数据边界

- 无效或未完成的工具响应不持久化为可执行意图；不从任意正文挖出工具 JSON，不猜缺失参数，不把错误参数替换为空对象。
- 参数预检支持当前 bundled tool schema 所用的 type、required、properties、additionalProperties=false、enum、anyOf、items、长度、数值范围及 pattern；它不是完整 JSON Schema 实现。未知供应商扩展仍由工具处理器验证。
- Gate、单次审批、插件开关、工作区边界和写入锁继续执行；参数预检不授予权限。拒绝调用不会伪装成成功。
- 诊断仅保存固定错误码、长度、哈希、JSON 错误坐标、协议、步骤、尝试数和恢复状态，不保存原始失败正文、参数值、提示词或密钥。对外 API 再做字段白名单。
- 回归和模型任务使用隔离目录，不修改真实用户会话。未通过协议测试不会自动覆盖模型配置。

## 验证记录

- 本轮相关后端回归 147 项通过；前端 856 项通过，类型检查及生产构建通过。
- 生产构建的 8 个 Windows 工作台视图检查通过，没有页面异常或外部 / 模型请求。
- 冻结后端的真实 HTTP、插件目录、搜索设置、ConPTY 生命周期、工作流和退出清理检查通过。
- 全套回归最初卡在旧 app-server 测试 harness：Windows 的 `select()` 不接受匿名管道，随后清理阻塞。已改成专用管道读取线程和队列，25 项 app-server 回归通过；没有以放宽生产保护绕过测试。
- 原生 Windows / Intel Mac / Apple Silicon Mac 安装包检查入口增加本轮工具协议、证据和 app-server 回归，避免只在开发源码目录验证。

本机原始实验结果及日志存于 `E:\models\diagnostics\tool-protocol-audit-20261009`。这些是小样本功能证据，不是对 ZCode 或 Codex 模型能力的排名。完整回归、安装和原生跨平台构建的最终结果另记在交付记录中。

## 插件归属

解析、流式调用装配、参数预检、兼容诊断及恢复归属 providers 的 `providers.tool_recovery`，新增 `tool_protocol` 和 `tool_arguments` 均登记 modules。会话状态呈现归 sessions 既有能力；内核只协调 journal、验证、审批与运行生命周期，没有增加业务插件的共享例外。

原生回答的引用尾部归 sessions 的 `sessions.native_evidence`，`native_evidence` 模块独立登记。关闭 sessions 后不能借此通过完成验证。引用失败最多沿用当前轮一次证据修复，不重做工具；不会凭“工具曾经成功”就自动信任答案里的任意引用。

参考：[ZCode runner options](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-options.ts)、[ZCode streaming assembler](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/streaming-tool-call-assembler.ts)、[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)。
