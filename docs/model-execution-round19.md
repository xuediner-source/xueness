# 模型排队与本地诊断（第 19 轮）

本轮接入 providers 插件，作用于主会话、子代理和工作流的 AgentRunner 请求。模型调用按尝试获取名额，退出尝试或进入重试退避前释放；媒体只在取得名额后物化，每次重试重新绑定和释放。

## 并发与状态

同一进程内，状态目录的绝对路径、模型服务地址摘要、模型 ID 共同确定名额组；Windows 状态路径不区分大小写，服务地址忽略末尾斜杠。不同模型、服务或状态目录独立。每组默认最多 4 个同时执行的尝试，等待者按进入队列顺序获得名额。不同进程各自计数，没有跨进程总额度。

启动前设置 `XUENESS_MODEL_MAX_CONCURRENT`：`1`–`64` 指定每组上限，`0` 关闭准入控制；未设置或无效时取 `4`。每个状态目录首次访问时读取，修改后重启服务或 CLI。

用户取消、宿主关闭、回合截止时间和 providers 禁用会结束排队；普通取消不记录供应商故障。排队发布 `model_request_queued`，取得名额后发布 `model_request_admitted`，随后才发布 `model_request_started`。队列等待计入 `queuedMs`，模型尝试 `durationMs` 从 started 计算，两者分开。快路径没有排队事件，也没有虚构的 `queuedMs: 0`。

Web 会话状态显示“等待模型并发名额…”，请求详情和历史表显示已测得的排队时间；未知时不显示数值。CLI 输出等待提示，TUI 同一逻辑请求更新一张排队卡，取消后结束等待显示。停止后的主状态优先于残留活动阶段。

`GET /api/providers/execution` 返回当前进程、本状态目录的 `{ admission, debug }` 快照。admission 含启用状态及上限、执行数、等待数和活动组数；不暴露模型服务地址、模型分组和请求内容。providers 关闭时返回 403。此路由只读取快照，不触发模型请求。

## 本地诊断

默认关闭。启动前设置 `XUENESS_MODEL_DEBUG=1`，每个完成或失败的尝试在状态目录 `model-debug/` 写入一份 `xueness.model-debug.v1` JSON，最多保留最近 100 份托管记录。其它取值关闭；设置同样在本状态目录首次使用时缓存。

记录包括会话/逻辑请求/尝试 ID、模型 ID、协议、尝试预算、时间戳、排队与模型耗时、固定失败分类和状态码、结束原因、实际报告的白名单用量，以及以下计数：

- 输入消息数、工具数和各角色文本长度、历史工具调用数。
- 正文/思考 delta 回调次数和字符数、工具快照次数、首次正文/思考回调相对观察器建立的耗时。
- 最终回复字符数和工具调用数。

字符长度采用 JavaScript UTF-16 `.length`；delta 统计的是适配器观察回调，不是全部原始 SSE 帧。隐藏思考只增加计数。记录不包含提示词、正文、思考内容、签名、媒体、工具名称/参数/结果、请求头、URL、密钥或异常堆栈；没有 Token 时不估造。写入使用已有私有目录/文件保护与原子替换，写失败只增加快照里的 `writeFailures`，不改变模型执行结果。

## 对齐范围

参考 ZCode v3.15.1 `aac4755666d09fdcd70272fcf063c077a639015f` 的 `adapters/src/model/request-admission.ts`、runner 调用点及 diagnostics/debug 行为。Xueness 采用固定 FIFO 上限和无正文诊断；没有移植 AIMD 自适应调度、前台优先/观察者绕行或原始请求/响应录制。独立的标题生成、语义压缩辅助模型、连接测试与模型发现直接调用适配器，不经过本轮 AgentRunner 准入和诊断。跨进程限额、这些直接调用入口的统一治理属于后续工作。

本轮只做相关回归、结构/类型门禁、构建、本地 HTTP 与真实构建页面检查。复现：

```sh
node tools/verify-model-admission.mjs
npm --prefix ts run build
node tools/verify-model-admission.mjs --built
npm --prefix webapp run build
node tools/verify-model-queue-ui.mjs
```

UI 脚本在 Windows 默认使用已安装的 Edge，其他平台使用 Playwright Chromium；可通过 `XUENESS_BROWSER_CHANNEL` 指定已安装渠道。
