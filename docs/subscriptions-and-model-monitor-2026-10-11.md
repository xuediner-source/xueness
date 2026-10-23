> Historical reference from 2026-10-12, before the TypeScript/Z8 migration; current behavior is defined by [README.md](../README.md) and [ts/docs/z8-guarded-goal-memory.md](../ts/docs/z8-guarded-goal-memory.md).

# 订阅中心与返回模型监测

2026-10-11：功能目录现为 **30 个可信插件、192 项登记功能**。新增两个可选插件，默认未安装、未启用；更新客户端不会自动接入账号或启用监测。后续已加入会话主页入口与按会话隔离的监测卡，详见[会话主页与模型导航](https://github.com/xuediner-source/xueness/blob/25ba9dbae4838ba6a84ae64ff9d089a1bdd50833/docs/conversation-home-and-model-navigation-2026-10-11.md)。

## 安装与使用

在插件市场搜索「订阅中心」或「返回模型监测」，查看详情并安装，再点击「启用并打开」。也可以在设置的完整功能插件目录中管理开关。安装标记只激活随客户端构建的可信实现，市场清单不加载外部可执行代码。两者分别依赖模型插件，可独立安装。

订阅中心选择供应商后，可按页面提示浏览器授权、导入本机 CLI 登录，或使用订阅账号的登录 Token。模型来自上游发现、明确标注的预设或用户手动填写；点击「用于会话」选中该型号。它们作为受订阅中心管理的模型进入会话目录，原有模型设置保持独立编辑入口。

## 供应商覆盖

2026-10-12 已按订阅凭证范围收窄为 **8 个账号接入条目**，详见[订阅账号范围修正](subscription-account-scope-2026-10-12.md)。目录条目不代表所有账号已验证；账号权限与实际可用型号由上游决定。

| 接入方式 | 覆盖与限制 |
| --- | --- |
| 浏览器或设备码授权 | Codex、Grok、Antigravity、Qwen Code、Agnes AI，使用账号登录凭证。 |
| 本机 CLI 登录 | Claude 导入已登录的 Claude Code 凭据。Command Code Go 仅导入 `~/.commandcode/auth.json` 的 CLI 登录；会话使用 `/alpha/generate` 自有流协议。 |
| 订阅账号凭证 | Qoder 使用账号 Access Token 与 User ID，或从对应环境变量导入，使用 COSY 签名直连。 |

API 密钥服务、使用专用 Key 的编码套餐、OpenRouter API 余额授权、Spark／ERNIE 应用凭据、ZCode 本机代理和 CLIProxyAPI／9Router／兼容网关均已移出订阅中心。原有普通模型设置继续独立管理 API 配置。

Codex、Claude、Grok、Antigravity、Command Code 有额度查询适配。只显示接口实际返回且通过字段校验的数据；未提供、查询失败或不支持的额度显示不可查询，**不会把未知显示为剩余 0 或 100%**。刷新额度或发现型号由用户明确触发，连接时不会自动发起付费对话。

授权与模型请求由插件拥有的 Node worker 执行；未启用不创建进程。禁用、依赖关闭、卸载、取消及应用退出会停止相关工作。凭据仅存于本机私有目录，不返回到浏览器；导入只读已知来源，不改写其它客户端的凭据。

## 返回模型监测

监测随新会话请求被动记录响应封装中的 `model` 或对应协议的返回型号元数据，显示请求型号、返回型号、时间与供应商，并区分「一致」「不同」「未报告」。它不额外调用模型、不用回答中的自称判断身份、不回填旧会话，也不把别名差异推断成已经灰度到某一模型。上游返回字段是报告证据，无法证明服务背后的真实权重。

记录仅保留最近 200 条，不含对话正文或密钥，可筛选与清理。流式响应同样记录元数据；监测写入失败不会重发模型请求或丢弃回答。关闭监测后不再记录，已有记录留在本机。

## 验证与源码参考

相关前后端回归、插件结构门禁、类型检查及生产构建已验证。协议检查使用隔离凭据与模拟响应，覆盖文本、思考、工具增量、结束标记、型号、用量与额度未知值；未使用用户账号发起收费请求。账号授权、实际额度与实际可用型号仍需使用对应账号验证，不把模拟结果当成真实账号证据。本轮按用户要求未跑全量测试。

授权与原生协议适配参考用户给出的 [DSH Subs Hub 示例](https://github.com/xuediner-source/dsh-plugin-suite/tree/main/packages/dsh-subs-hub)，版本 `3e70973ecd390d93e5b092e14f09026c1bef9df2`。移植部分保留 MIT 许可与版权声明，并替换存储、生命周期与错误边界。参考官方 [Codex 账号与额度接口](https://learn.chatgpt.com/docs/app-server)、[Claude Code CLI](https://code.claude.com/docs/en/headless)、[Command Code 设置](https://commandcode.ai/docs/settings)及对应账号服务文档。

后端：`xueness/bundled_plugins/subscriptions/`、`xueness/bundled_plugins/model_monitor/`。前端：`webapp/src/plugins/subscriptions/`、`webapp/src/plugins/model_monitor/`。新增功能均列入对应 manifest 与固定注册表。
