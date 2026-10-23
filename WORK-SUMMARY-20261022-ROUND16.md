# Xueness 0.1.8 工作汇总：第 16 轮（引擎 Z1-1，2026-10-22）

引擎深化改为 ZCode 优先（`ts/docs/engine-roadmap.md`：Z1–Z8，Codex 放到之后）。本轮做 Z1 模型执行层的第 1 块：照 ZCode v3.15.1 的模型适配层补上失败分类、供应商业务码、重试策略和运行时自动重试，详见 [ts/HANDOVER.md 第 39 节](ts/HANDOVER.md)。没有调用真实或收费模型。

## 使用

- 安装依赖：`npm --prefix ts ci`（Node 24.11 以上）。
- Web：`bin/xueness-web`（默认端口 8137）。
- 命令行：`bin/xueness`；全屏聊天：`node ts/apps/server/src/cli/main.ts chat --root . --tui`，说明见 `docs/xueness-terminal-chat.md`。
- 桌面：见 `docs/xueness-desktop.md`。
- 验收：在 `ts/` 下运行 `npm run check`。

## 本轮

- **失败分类**（`packages/providers/src/failure.ts`、`failure-codes.ts`）：ZCode 的错误码、失败原因、重试原因和分类顺序；Z.AI/BigModel 业务码表（1302/1303/1305 可重试限流，1113/1304/1308 等直接失败，1261 超窗，1312 过载）、额度码、网络/TLS/代理错误码。只看状态码、错误类别、业务码和 Retry-After，上游原文不进入结果。
- **重试策略**（`retry-policy.ts`）：默认最多 11 次尝试，2 秒起按 2 倍增长、上限 60 秒、带抖动；5 分钟以内的 Retry-After 优先；可用 `XUENESS_MODEL_RETRY_*` 环境变量调整。
- **错误信息**：`ProviderRequestError` 新增业务码、Retry-After 和 TLS/代理提示；所有 4xx/5xx 都读取响应体里的业务码。`toJSON()` 不变。
- **运行时自动重试**（`packages/agent/src/model-retry.ts`、`driver.ts`）：每次模型请求按策略重试，发出 `model_request_failed` / `model_retry_scheduled` 事件；已经输出内容的请求不重试；等待可被停止打断，也不会超过运行时间上限；传输层不再叠加重试。
- **界面**：会话活动新增 `retrying` 阶段，网页端显示“模型请求失败，正在自动重试…”，本地运行监视器显示“自动重试”；`webapp/dist` 已重新构建。
- **文档**：重写引擎路线图；HANDOVER 第 39 节；`NOTICE.md` 补充 ZCode 参考说明。

## 验证（Linux x64，Node v24.14.1）

- `npm run check`：893 项测试，837 项通过，0 项失败，56 项跳过（Python 对照测试，本机没有 Python 后端）；`check:lines` 872 个文件；`check:plugins` 30 个插件、366 个源文件。
- 新增测试：失败分类与策略 12 项、驱动重试 5 项、活动记录 1 项。
- webapp：`typecheck` 通过，`npm test` 1714 项全部通过，构建成功（166 个文件）。

## 下一轮（Z1 第 2 块）

- 空回复重试、流式输出开始后的重试边界、请求开始/完成事件、最终失败分类写进会话并给中文提示。
- 之后是请求整形：工具输入归一化、工具调用校验、严格 schema、system 消息兼容、思考历史归一化。

## 还没做的

- 安装包、Docker 镜像和 CI 没有实际构建；macOS 终端和各平台真实剪贴板没有实机验证。
