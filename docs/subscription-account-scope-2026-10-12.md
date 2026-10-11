# 订阅中心的账号范围修正

订阅中心使用用户的账号授权、CLI 登录或订阅登录凭证，不要求用户开通 API 或填写 API Key。插件仍由用户在插件市场选择安装，默认未安装、未启用。

## 接入范围

保留 Codex、Claude、Grok、Google Antigravity、Qwen Code、Agnes AI、Command Code Go 与 Qoder，共 8 个入口。实际模型权限、套餐与可查询额度由对应账号和上游服务决定。

- 浏览器授权或设备码登录：Codex、Grok、Antigravity、Qwen、Agnes。
- 导入 CLI 登录：Claude Code 与 Command Code。Command Code 只读取固定的 `~/.commandcode/auth.json`，不再使用 API Key 环境变量或手动 Key 输入。
- Qoder 账号凭证：使用订阅账号 Access Token 和 User ID，或显式导入 `QODER_ACCESS_TOKEN` 与 `QODER_USER_ID`；不再读取 9Router 数据库。

原目录中的 40 个 API、套餐 Key、代理网关或应用 API 凭据入口已移除，包含 CLIProxyAPI、9Router、兼容网关、ZCode 本机代理、OpenRouter API 余额授权、Spark 与 ERNIE 应用凭据。订阅中心没有服务地址或 API Key 输入栏，也没有 API／编码套餐／网关筛选分类。

## 既有配置与会话

移除的账号 ID 在后端返回不存在，无法登录、导入、保存或调用，也不再贡献会话模型。已有本机凭据和缓存文件不自动删除，但不会重新激活移除的入口。普通模型设置中的独立 API 配置、会话历史和插件开关保持不变。

此前保存的 Command Code Key 未区分手动填写和 CLI 导入，因此需要重新点击「导入本机登录」。新导入记录带有 CLI 来源标记，手动 Key 不会被继续当成订阅登录使用。Qoder 必须同时具有账号 Token 与 User ID；更新凭证保留已选型号。

## 验证

按用户要求仅运行相关前后端回归、原生协议检查、插件结构门禁、类型检查、生产构建和构建后界面检查，不运行全量测试。账号与网络协议验证使用隔离状态和模拟响应，不使用用户账号发起模型调用；不能据此宣称真实上游账号全部已验证。

归属继续为 `xueness/bundled_plugins/subscriptions/` 与 `webapp/src/plugins/subscriptions/`。既有功能 ID 保持稳定，可信目录仍为 30 个插件、192 项登记功能。
