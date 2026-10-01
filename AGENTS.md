# Xueness 开发约束

本文件根据项目所有者在 2026-10-01 的明确要求建立：**现有及之后新增的每一项产品功能都必须由插件提供，并能在功能插件面板中找到其归属。**

## 新增功能必须作为插件

1. 开始实现前确定功能所属插件。已有领域内的功能扩展放入现有插件；新的独立领域建立新的可信 bundled plugin，不能把业务逻辑直接加进主 CLI、Web 服务器、Agent 内核或工作台容器。
2. 后端实现放在 `xueness/bundled_plugins/<id>/`；在 `manifest.json` 登记实际 `modules`、依赖、工具、CLI 命令、面板和资源。每项用户能力必须登记在 `features`，使用稳定的 `<plugin>.<feature>` ID、中文 `name` 和英文 `nameEn`。
3. 新增前端实现放在 `webapp/src/plugins/<id>/`，登记 `frontendModules` 和静态 `xuenessPluginRegistry.ts`。容器只协调状态、布局和挂载，不能成为新功能的实现位置；既有跨插件纯展示组件可按导出符号声明归属。
4. 插件只能从构建 allowlist 加载。增加新包时必须同时更新 `PLUGIN_IDS` 和前端注册表。状态文件、资源 manifest 和目录数据均不能引入可执行代码。
5. 功能只能在所属插件及其依赖 `effective=true` 时工作。工具执行、CLI、HTTP、前端按钮、挂载和后台 effect 均检查归属；禁用后不再启动请求、轮询、子进程或新任务。实际权限仍由 Gate、批准、Host/Origin/CSRF 和工作区边界决定，启用插件不代表授权执行。
6. `设置 → 插件 → 已安装功能插件` 默认显示完整后端 catalog，包括禁用、依赖阻塞、只有 CLI/工具而没有独立面板的插件；卡片中显示子功能。不能用扩展资源清单代替功能插件目录，也不能把新增插件藏到其它设置页。
7. 新功能必须同步更新归属清单、使用说明，以及有实际价值的开关/依赖/权限/生命周期回归；完成结构校验与适当验证后再交付。具体步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 共享内核边界

Store、journal/事件协议、lease/写锁、Gate/审批、通用预算及完成验证、HTTP 安全防护、插件注册/配置/管理、通用资源存储、API 客户端和基础 UI 属于共享基础设施。插件管理必须在其它插件关闭后仍可访问；settings 关闭时使用账户菜单中的「插件管理」恢复入口。**不能以“通用组件”或“内核能力”为理由绕过产品功能插件化。** 新增共享例外需要说明具体原因并更新架构审查，不能仅扩大检查脚本的白名单来让校验通过。

生产入口须绑定所用状态目录；直接调用工具时使用 `bind_execution(state_dir=..., store=...)`，或 `core.execute(..., state_dir=...)`。无状态的历史底层调用仅用于兼容，不承担产品的持久插件开关语义。

## 本项目协作要求

- 子代理只能使用 **GPT-6 Luna，推理等级 MAX**，不得自行改用其它模型。
- 保留用户已有未提交改动、会话、工作区、模型配置及插件开关；验收使用隔离状态目录。
- 不把 fixture 统计当作真实模型性能测量，不编造缺失的 Token、显存或成功证据。
- 未获明确授权，不提交、推送、对外发布、发送消息或使用收费模型。

## 必须检查

```sh
python3 tools/check_plugin_architecture.py
python3 -m unittest tests.test_plugin_architecture -q
```

有后端行为改动时运行相关回归及后端全套；有前端行为改动时运行 `npm --prefix webapp test`、`npm --prefix webapp run typecheck` 和 `npm --prefix webapp run build`，并核验真实构建的界面。发布包准备也执行插件结构门禁。
