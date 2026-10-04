# Xueness 本地小模型轻量模式

本轮参考源码固定在 2026-10-01 的 DeepSeek Harness `639ed015397290b3745d163aafe02ffee4aa3f84` 和 Pi Agent `8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d`。功能取舍见 [Harness 对照审查](xueness-harness-feature-audit-2026-10-01.md)。

## 启用

Web：设置 → 模型设置 → 添加或编辑配置 → 运行配置选择「本地轻量」。选择 Ollama、LM Studio、llama.cpp 或 vLLM 地址模板，填写实际已部署的模型 ID。上下文窗口必须与服务启动配置一致；这里不会下载模型、调整显存分配或改变模型权重。

会话输入框的模型菜单也可切换「标准 / 本地轻量」，重新打开会话恢复上次档位。预算提示是输入估算，真实服务返回的 usage 独立显示。

选中轻量档时，工作台切到极简布局：会话为单栏，侧栏默认收起（可用切换按钮重新展开），会话头部的视图切换、分叉与交付检查面板隐藏，输入框只保留发送、停止、模型名和上下文用量；本机运行监视器保持一行状态、可展开查看详情。模型菜单内的「标准 / 本地轻量」切换仍然可用，切回标准档后恢复原布局。该布局由 providers 插件提供，providers 关闭时不生效。上下文用量来自会话运行预算的输入估算，不是服务商实际用量。

编辑配置中的「轻量配置高级选项」可调整下表参数。轻量设置按「常用 → 高级」分组：运行档位、上下文窗口、最大输出和工具调用在常用区，API 兼容设置、本地接口兼容诊断和轻量高级选项折叠在「高级」区，展开后字段、取值和保存行为不变。留空使用宿主默认值；显式保存才生效，改变模型目录中的选择只更新编辑草稿。可恢复默认设置并保存。标准档位不使用这些轻量参数。

CLI 示例，把 `YOUR_INSTALLED_MODEL` 换成实际已安装的模型名：

```sh
python3 -m xueness providers save local --name 'Ollama 本地模型' \
  --base-url http://127.0.0.1:11434/v1 --model YOUR_INSTALLED_MODEL \
  --runtime-profile lightweight --context-window 8192 --max-output-tokens 1024
python3 -m xueness run --provider-id local --lightweight \
  --prompt '先查看 README，说明项目如何运行' --root /path/to/project
python3 -m xueness chat --provider-id local --lightweight --root /path/to/project
python3 -m xueness providers discover local
```

`--runtime-profile standard` 明确恢复标准档位；`--lightweight` 是 `--runtime-profile lightweight` 的简写。写入、编辑、命令仍需现有授权参数或逐次审批。

对 OpenAI-compatible 配置，明确选择轻量配置或现有 loopback opt-in 后，`127.0.0.1` / `::1` 字面 IP 服务可留空 API key，不发送空 Bearer 头。Anthropic Messages 仍要求 API key。HTTP 不接受任意远端地址或可变 DNS 别名。远程部署使用 HTTPS 和相应凭据。仅 loopback 请求绕过环境代理，其他请求保留原有代理行为；重定向仍被拒绝。

「发现模型」仅在显式点击时，对已保存的 OpenAI-compatible 配置发 `GET /models`；不调用聊天生成。它受服务真实请求开关、8 秒预算、512 KiB 响应和 500 个 ID 上限限制，不从模型名称猜测上下文长度或硬件能力。Anthropic Messages 配置没有这个入口。

## 详细参数

配置 API 的 `lightweightOptions` 使用完整对象替换：省略该字段保留已有选项，传 `{}` 恢复默认值。不能包含未知键；布尔值不能充当整数，非有限数值和超范围值会被拒绝。

| 参数 | 范围 / 默认值 | 实际用途 |
|---|---|---|
| `reserveTokens` | 0–8192；自动为 512，窗口小于 4096 时为 128 | 输入额外安全预留；窗口减输出和预留必须至少剩 256 tokens |
| `optionalContextChars` | 0–6000 / 1800 | 可选记忆、技能和工作区指导总字符预算；0 跳过这些可选上下文，仍保留用户任务 |
| `toolResultChars` | 400–12000 / 1400 | 大工具结果进入模型请求时的简短视图；完整 journal 不变 |
| `initialTools` | `auto` / `minimal` / `core`；默认 `auto` | 自动按窗口选择初始工具集，或明确选择最小/核心集；不会扩大权限 |
| `maxDiscoveredTools` | 0–12 / 6 | 请求内保留的按需工具上限；0 隐藏并拒绝工具发现 |
| `toolSearchResults` | 1–6 / 3 | 每次发现工具的数量，还受发现总上限约束 |
| `resultPageChars` | 128–4000 / 1200 | 完整工具结果分页的默认页长度 |
| `fileReadChars` | 128–12000 / 4000 | 文件工具默认页长度；显式 `offset/limit` 仍受工具上限约束 |
| `overflowRetry` | 布尔 / `true` | 已确认上下文溢出、且未输出时，最多重试一次 |
| `overflowRetryRatio` | 0.25–0.85 / 0.6 | 溢出重试时的输入预算比例 |
| `jsonRepairAttempts` | 0–2 / 1 | JSON 协议错误后的额外修复请求数；0 立即暂停，默认最多一次修复 |
| `stepLimit` | 1–64 / 64 | 限制调用方已有步骤预算，不能提高 CLI/Web 的步骤上限 |
| `wallTimeSeconds` | 1–3600 / 沿用调用方预算 | 总运行预算；模型 HTTP 请求使用剩余期限，工具在边界协作式检查，不强杀已开始的工具 |
| `requestTimeoutSeconds` | 1–300 / 120 | 每次模型请求的总网络预算，覆盖响应头、响应体和重试等待；更短的运行预算优先 |
| `transportRetries` | 0–2 / 0 | 网络/限流等可重试失败的额外尝试数；文本或思考增量已输出后不重放 |
| `temperature` | 0–2 / 省略 | OpenAI-compatible 的温度参数；省略沿用模型服务默认值 |
| `topP` | 大于 0 且不大于 1 / 省略 | OpenAI-compatible 的核采样参数 |
| `seed` | 0–2147483647 / 省略 | OpenAI-compatible 的采样种子；服务未必支持，不能保证可复现 |

采样参数只用于实际轻量推理，不发给连接测试；Anthropic 配置拒绝这些采样选项。HTTP 网络预算由共享单调时钟期限和 socket watchdog 执行；远程域名的操作系统 DNS 解析仍受系统解析器控制，字面 loopback IP 不经过域名解析。超时和重试不下载模型或改变服务的线程、KV cache、量化、显存层数等启动参数。

CLI 可一次保存完整轻量选项对象：

```sh
python3 -m xueness providers save local --name '本地轻量' \
  --base-url http://127.0.0.1:11434/v1 --model YOUR_INSTALLED_MODEL \
  --runtime-profile lightweight --context-window 8192 --max-output-tokens 1024 \
  --lightweight-options '{"initialTools":"minimal","fileReadChars":2400,"requestTimeoutSeconds":120,"transportRetries":0,"temperature":0.2}'
```

## 实际变化

- 初始工具为 `read`、`write`、`edit`、`exec`、`ask_user`、`tool_search`、`tool_result_read`；小于 4096 tokens 时先展示 `read`、`exec`、`ask_user`、`tool_search`。远程会话保留远程工具边界。
- `tool_search` 查找当前启用且符合工具范围的能力，每次最多三个匹配项，下一次请求带上相应 schema；最多保留最近六个发现的工具。发现不启用插件或授予权限。
- `read` 支持字符 `offset` / `limit`，轻量默认 4000、最多 12000 字符，分块扫描降低宿主内存分配。`tool_result_read` 分页读取当前会话的完整结果，默认 1200、每页最多 4000 字符，不跨会话。
- 预算计入提示、消息、可选记忆/技能/仓库指导及工具 schema。默认窗口 8192、输出 1024；较小窗口默认输出为 `min(1024, window / 4)`。另预留 512 tokens；小于 4096 时预留 128。输出上限通过真实 API 参数发送。
- 输入估算以 UTF-8 字节数 / 2 为基线，不是 tokenizer 测量。服务报告实际输入用量时，用当前会话最近八次请求校准低估，修正倍率不低于 1；不同路由、模型、协议、工具模式或窗口不共用校准。缓存命中的输入仍占上下文容量，不从预算扣除。没有 usage 时保持估算，不编造计数。
- 所有用户任务与中途补充要求逐字保留；旧交换按完整调用/结果单元移出请求。移出的工具记录生成有界、可追溯的摘录，包含调用 ID、参数片段、成功/失败状态和证据引用；助手的旧结论明确标为未验证。此摘录不调用额外模型，不是语义总结，不替代完整 journal，也不授权重复动作。用户要求本身过大时暂停，不静默丢弃约束。系统提示不会因历史裁剪而重写。
- 大结果显示简短视图与完整结果 ID。搜索结果优先保留 URL、标题和相关摘录，预览内相同 URL 去重，继续保留来源是否已核验的标志；完整结果可分页读取。不自动打开来源或改变网络权限。
- 必需输入本身过大时暂停并说明原因。确认的上下文超限最多缩小请求重试一次；已输出的流式文本不重放，执行过的工具不重做。
- 工具串行执行，保留单点精确 `edit`、重复调用停止、墙钟预算和停止/恢复。轻量子代理沿用预算及只读边界，并保留角色指令。
- 根与成功触及文件的子目录 `AGENTS.md` 按根到深目录读取；不越过工作区或跟随符号链接，整体有上限。指导是低优先级上下文，不能覆盖用户/宿主权限规则，正文不自动写入会话。

## API 兼容和完成状态

原生 function calling 可用时选择 `native`。兼容配置支持 `streamUsage`、`parallelToolCalls`、`maxTokensField`（`max_tokens` / `max_completion_tokens`）、`toolChoice`（`auto` / `required`）和可省略的 `think` 布尔参数。未配置 `parallelToolCalls` 时省略 `parallel_tool_calls`；轻量档位默认也省略 `stream_options`。选择 `think` 时会发 `think`，并省略 `reasoning_effort`，避免对同一请求发送两种思考控制字段。

### 本地接口兼容诊断

「设置 → 模型配置 → 本地接口兼容诊断」每次只执行用户选中的检查：普通对话、原生工具调用、JSON 工具调用、SSE 流式 delta 与 `[DONE]` 标记，或原生工具结果续轮。原生工具检查要求模型只返回一个 `xueness_fixture_add` 调用，且服务端严格验证函数名和 `{a: 3, b: 4}` 参数；工具续轮会通过 SSE 接收工具调用增量，回传真实 `tool` 消息，再要求服务商基于固定的算术回执回答，最多发两次模型请求。诊断 fixture 仅在进程内计算 `3+4`，不会读取/写入工作区、运行命令或调用产品工具。

每个普通检查最多请求一次，续轮最多请求两次；每个请求输出上限为 128 tokens，总期限为 8 秒。诊断无自动回退和重试，400 结果会列出已发送字段供用户手动省略参数后重新选择运行。测试只读取已保存的地址、模型和密钥，兼容候选来自编辑草稿；检查历史按参数哈希和当前配置版本保存，不记录 prompt、response 或凭据，也不会自动改运行参数或活动模型。只有普通对话、SSE 流式和适用的工具检查全部通过后，才可显式点击「采用已验证兼容参数」保存候选；原生模式要求工具结果续轮通过，JSON 模式要求 JSON 工具调用通过。重新保存连接或运行选项会使历史验证失效。服务商可能按请求收费；普通对话成功不能作为工具支持证据。

不支持原生工具时，OpenAI-compatible 轻量配置可以选择 `json`：

```json
{"tool":"read","arguments":{"path":"README.md","offset":0,"limit":1200}}
```

宿主只解析整个明确对象，不从任意段落提取 JSON 执行。调用仍经 journal 意图、参数、插件范围与 Gate 审批，结果用普通文本角色回传。格式默认额外修正一次，可配置为 0–2 次。这不是训练或解码 grammar，模型仍可能无法遵循协议。

JSON 模式下，普通问候与最终说明同样使用 `answer` 对象，自然语言和 Markdown 放在该字段内；普通聊天的 `evidence` 为空数组。工具任务的证据必须是对象，例如 `{"evidence_id":"E1","observation":"实际读取结果确认了修改后的内容"}`，不能写成 `["E1","E2"]`。提示词提供两种完成示例，并在工具清单及宿主指导之后再次明确对象格式；后端仍只接受实际成功工具结果的引用，不因提示词修正而放宽验证。

普通文字可以结束回答，但不能自动标成“已验证”。验证仍需引用实际成功结果；失败、拒绝或虚构 ID 不算证据。

### 生成限制与续写

OpenAI-compatible 的 `finish_reason` 和 Anthropic 的 `stop_reason` 会传到运行层，非流式、SSE 与流式 JSON 回退使用相同规则。`length` 不直接等同于输出上限：报告的输出达到请求上限时记为输出上限；输入加输出接近配置窗口、输出低于上限且预留输出无法容纳时记为上下文容量不足；其余保留为无法进一步区分的生成限制。过滤、服务暂停与未知结束原因也不能标为正常完成。旧适配器不提供结束元数据时保留兼容行为，不虚构原因。

受限响应保存已有正文，以 `completion.status=incomplete`、`session.status=paused` 结束；界面显示“回答尚未完成 / 已暂停”。JSON 工具片段和原生工具调用即使参数看似完整也不执行，不用协议修复请求反复重放截断输出。用户发送“继续”后仍使用正常输入预算；若上一轮上下文容量不足，恢复请求先采用现有 `overflowRetryRatio` 缩小预算，收到正常响应后解除恢复标志。宿主不自动重复搜索或已经执行的副作用，也不自动重启模型服务。

64K 是输入、思考和输出共享的容量，不是 64K 输入外另加输出。这里保留服务的完整窗口，只控制请求信息量。思考消耗的输出 Token 由实际 usage 记录，缺少细分计数时保持未知，不按思考字符伪造 Token。需要更长正文时显式调整 `maxOutputTokens`，同时保留足够输入和安全预算；不会为了续写自动扩大上限。

## 本机资源与模型输出可视化

轻量配置的高级设置区，以及轻量会话，显示本机资源面板：逻辑 CPU 核心、系统 1/5/15 分钟负载、Xueness 进程 CPU、物理内存总量/可用估算、进程常驻内存，以及状态目录所在文件系统的磁盘空间。数据来自运行 Xueness 后端的设备；远程模型服务器的资源不在这份数据中。进程 CPU 的 100% 表示一个核心，首次采样尚无增量基线时显示不可用。

资源大约每 2 秒刷新，支持暂停/恢复和手动刷新。页面隐藏、退出轻量模式或卸载面板时停止轮询。后端按服务上下文锁定并缓存 2 秒，macOS 使用固定绝对路径的 `sysctl`、`vm_stat`、本进程 `ps`（单条命令最多 0.5 秒）；Linux 读取有界 `/proc` 数据。失败的字段为 `null`，不伪装成 0。macOS 可用内存包括可回收页估算，Linux 优先使用内核 `MemAvailable`。没有 GPU/模型显存探针时明确显示不可用；统一内存总量不等于模型显存占用。

`GET /api/diagnostics/runtime` 属于 diagnostics 插件，遵守宿主 HTTP 与插件开关边界；只返回 `xueness.runtime-metrics.v1` 的数值和采样时间，不返回用户名、目录、进程列表或凭据。诊断采样不会连接模型服务。

模型面板展示等待模型、思考、生成、工具调用、修复与最终状态。它记录实际流式回调的首个文本/思考延迟、字符数、请求耗时、平均字符速率、服务实际报告的输出 Token 数与平均 Token 速率，最多保留 24 次请求的字符速率趋势。速率的分母为整个请求耗时，包含等待时间，**不是解码阶段吞吐基准**。没有流式首片段、未观察到思考增量或没有服务 usage 时，相应指标显示不可用，不把字符折算为真实 Token。输入预算条仍使用明确标注的 UTF-8 估算，完成状态继续区分“需要审核”和“已验证”。

## 验证和边界

2026-10-05 的预算校准、结束原因和恢复改进已完成针对性回归与三组实际 Bonsai 本机模型检查，详见 [本轮验证记录](lightweight-recovery-2026-10-05.md)。以下全套数量及 Ollama 环境描述是 2026-10-01 的历史检查记录，不代表本轮执行了全套或仅使用 fixture。

测试覆盖本地请求/流式兼容、空 key/代理/重定向、CLI/Web 档位与高级选项保存恢复、工具范围、JSON 审批、分页、中文预算、历史配对、溢出重试、未验证回答、请求期限和资源探针失败。第二十八批后端全套 1181 项（1159 通过、22 跳过），前端 367 项通过，类型与生产构建通过；最后补充的缺失思考统计与流式/轻量回归 18 项通过。

上一轮检查本机 Ollama 时只有 `nomic-embed-text:latest` 嵌入模型，没有 Agent 对话生成模型。接口用临时 loopback 服务验收，测试 fixture 没有成为产品模型；没有下载模型或调用收费服务。本轮不能据此报告真实小模型的任务成功率、速度或显存改善。

Pi 的 [核心工具](https://github.com/earendil-works/pi/blob/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d/packages/coding-agent/src/core/tools/index.ts) 和 [请求预算](https://github.com/earendil-works/pi/blob/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d/packages/ai/src/api/simple-options.ts) 支持少工具与明确预算的设计；没有证据显示 Pi 会自动提升小模型能力。另参考 DeepSeek Harness 的 [模型预算](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/compaction/compaction-basic/src/config.ts) 和 [指令发现](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/context/agent-instructions/src/files.ts)。Xueness 保持自己的 Python 运行时及可信插件边界。
