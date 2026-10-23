# Z5 MCP、分层配置与 hooks

本阶段基于 Z4，参考 ZCode v3.15.1 `aac4755666d09fdcd70272fcf063c077a639015f` 的 MCP、配置适配和 hooks 接口。实现使用 Xueness 现有插件、状态目录、工具批准与会话事件，不引入新插件。

## 分层运行配置

目前实际接线的配置域为 `plugins.shell` 和 `mcp.servers`。优先级由低到高：默认值 → 原 `shell-config.json` → 状态目录 `runtime-config.json` → 已信任的当前根 `.xueness/config.json` → JSON 环境变量 `XUENESS_RUNTIME_CONFIG` → 宿主显式配置。对象深合并，数组整体替换，`false` 保留；不支持的配置域、字段或无效层返回诊断，不执行文件代码。原 MCP 资源中的有效服务器在连接时作为 MCP 条目的基础层，再叠加上述配置；GET 配置视图不枚举整个旧资源库。

例如，在已授权工作区的 `.xueness/config.json` 中配置：

```json
{
  "plugins": {
    "shell": { "shellMode": "bash", "captureInit": false, "startupScript": "export PROJECT_MODE=development\n" }
  },
  "mcp": {
    "servers": {
      "local-tools": { "transport": "stdio", "command": "node", "args": ["tools/server.mjs"], "cwd": ".", "env": { "PROJECT_MODE": "development" } }
    }
  }
}
```

MCP 可按同名条目部分覆盖，`enabled:false` 移除本次运行的服务器；新 stdio 条目需 command，新 HTTP/SSE 条目需 url。相对 cwd 按会话工作区根解析。沿用现有 stdio、Streamable HTTP、SSE、协议版本、超时及网络 grant 约束；`isolation` 仅接受 `session`。headersEnv 继续只接受受支持的请求头与环境变量名引用。启用条目需要相应插件和原批准规则，配置不授予额外执行权限。

- `GET /api/runtime-config?root=<编码后的绝对根>`：返回有效 config、叶子 JSON pointer 的 provenance、sources、diagnostics 和 workspace 状态。待确认时另有 `workspaceCandidate`，便于先审阅候选值。
- `POST /api/runtime-config`，正文 `{"config":{"plugins":{"shell":{"captureInit":false}}}}`：部分合并并原子保存状态目录用户层。若更高层覆盖，查询 provenance 判断来源。原 `/api/shell/settings` 仍可用，写入的是较低的旧 shell 层。
- `POST /api/runtime-config/trust`，正文 `{"root":"绝对根","digest":"GET返回的64位摘要","decision":"allow","confirmed":true}`：信任当前根的精确文件摘要。撤销用 `decision:"revoke"`。陈旧摘要返回409，未授权根403；文件变化后重新变成 pending。

只读取当前已授权根，不扫描父目录。信任保存在状态目录 `runtime-config-trust.json`，绑定规范根和整个文件 SHA-256。候选与有效 HTTP 视图都会遮蔽敏感键及所有 MCP env 值；这是字段级脱敏，普通 args、startupScript 等自由文本仍可见，凭据宜使用现有环境引用。保存、查询、信任均不启动脚本或连接 MCP。主会话在下一次运行装配时重新读取配置；若通过宿主重装配活动环境，有效配置变化会先取消旧运行。workflow actor 在运行开始时读取 shell 配置。

## hooks 信任与输出

`.xueness/config.json` 可同时包含原嵌套 `hooks.events`。配置加载器剔除 hooks，它们仍需原工作区 hook 功能开关及独立摘要信任。配置 allow 不授予 hook 信任。原 `.xueness/hooks.json`、`.zcode/config.json` 的 source index/摘要语义保持，新原生 config 使用独立 index 2。继续只执行 argv/process hook；shell 字符串 command 类型仅报诊断。

每次事件和每条实际 hook 启动前重新核验开关、文件、摘要及信任。运行中撤销或修改后，尚未启动的工作区 hook 不再执行；已启动的进程通过原取消/超时机制结束。用户状态 hook 继续走原资源配置。没有合并两套信任，也没有新增自动授权。

SessionStart、UserPromptSubmit 和工具事件的 additionalContext 作为有界、不可信上下文进入模型请求；支持普通和 lightweight 请求。PreToolUse 的对象 updatedInput 在工具 schema、权限 subject 与 Gate 之前生效，拒绝优先；字段使用 Xueness 的内部工具参数。权限 hook 不能越过原批准流程。Stop 的继续请求每次运行最多接受一次，防止持续 Stop 循环；取消后的派发不再启动新 hook。审计只存元数据，不保存 stdout。

## MCP 运行端口

插件激活内以 session owner、cwd 和完整配置指纹隔离连接，引用计数管理 lease、共享初始化和释放；运行结束或插件卸载关闭连接。池不跨会话、工作区或运行常驻。服务器 tools/list_changed 会实际更新工具注册和 schema，名称碰撞按先到项保留；卸载清理所属注册。通知处理不会阻塞 JSON-RPC 响应读取。

请求、工具调用、资源读取/订阅接受 AbortSignal；取消清理等待项，并尽力发送 `notifications/cancelled`。中断 HTTP 传输不自动重放原调用，后续明确调用可重新连接。通过 HTTP Stop 传播到在途工具仍遵守现有 `general.sessionsCancelPropagateEnabled` 设置，本阶段未改变其默认值。资源订阅仅在服务器声明能力时提供，工具继续经过 MCP Gate；资源通知只更新计数，不自动读取内容或唤醒模型。

`GET /api/sessions/:id/mcp-runtime` 是 sessions/mcp 开关与会话工作区授权约束下的只读端口。活动时返回 connectionId、serverId、状态、工具数量和资源变化计数；空闲为 `{"active":false,"servers":[]}`。查询不建立连接、不调用工具。McpActivity 经 sessions 持久事件/reducer 保存固定 phase、服务器/连接 ID 和数量；不保存配置、凭据、资源 URI 或正文。异步元数据最多排队100条，在模型、工具结果和结算边界发布，持久化失败在这些边界传播。

现有手动 OAuth PKCE/finish/refresh/revoke 和 elicitation 保留，没有移植官方身份、遥测、自动 DCR 或新的 OAuth 发现流程。主会话接入运行端口和 hook 消费，动态 workflow 的完整工具编排仍在 Z6。

## 验证和交付

Windows / Node24.19 实测真实 Node MCP/hook 子进程、Git Bash 和 loopback 模型 fixture。`node tools/verify-z5-runtime.mjs` 及 `--built` 各4场景、4次本地模型请求：配置审阅零连接、独立信任、真实 shell 配置、hook 参数与上下文、运行中撤销、一次 Stop 继续、资源订阅和持久脱敏活动、取消零重放及插件门禁。

定向回归、结构门禁、构建和搬迁验证见 [工作总结](../WORK-SUMMARY-20261023-Z5.md)。另修复 Z4 已存在的宿主计划草稿被工作区快照阻断问题：仅记录工作区文件，已由 Gate 授权的工作区外文件不进入文件回退。没有放宽工具授权。最终构建复用 Z3 文件/会话回退验收通过。

Linux/macOS 原生、安装器、Docker 和 CI 未在本阶段验证。Web 源码不变，166个 dist 文件与 Z4 hash 相同；未重复前端构建或无关全套。完整包包含 Z1–Z4，相对 Z4 的补丁应用见 [PATCH-Z5.md](../PATCH-Z5.md)。下一阶段 Z6 动态工作流，整个引擎尚未完成。
