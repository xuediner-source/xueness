# ZCode UI parity audit — 2026-10-01

本次对照基线为 ZCode **v3.14.3**，提交 [`29628c9acdb81b703bbd4080c207a0e7ce5e276e`](https://github.com/zai-org/ZCode/commit/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，源码来自审计快照 `zai-org/ZCode/packages/ui/src`。检查了 Xueness 当前 Web 设置界面、对应 API 与运行时，并参考 `docs/screenshots/batch25-native`、`docs/screenshots/batch25-reference`。这是选定界面和模块的实现对照，不是完整平台认证；品牌、服务架构和数据语义仍属于 Xueness。

整体上，设置导航和若干模块已形成真实可操作的对应界面，部分视觉层级也与上游接近。Xueness 使用自己的 Web 服务和能力边界，缺少上游桌面端、账号计划、完整插件商店和自动化工作流产品面，因此不能称为百分之百对齐。

| 范围 | 当前实现与真实数据 | 与上游的主要差异 |
|---|---|---|
| 布局与设置 | `webapp/src/XuenessSettingsView.tsx` 将常用设置、Agent 能力、数据统计分组显示；`xuenessSettingsNavigation.ts` 按上游顺序保留 13 个主要目的地，并把工作区、功能模块、访问策略、扩展市场、远程、自动化、诊断 7 个 Xueness 页面收进“扩展与维护”。通用设置、快捷键、模型、浏览器和工作区都连接真实保存或后端 API。 | 上游 `SettingsPage.tsx` 服务于完整 ZCode 桌面/工作区应用，平台专有功能与服务更多。Xueness 的 7 个额外页面及 Web 服务行为是本地产品扩展；导航分组与组件实现不等同于上游原生页面。设置截图见[本地常规设置](screenshots/batch25-native/general-dark.png)、[上游常规设置](screenshots/batch25-reference/general-dark.png)和[本地外观设置](screenshots/batch25-native/appearance-dark.png)。 |
| 用量 | `XuenessUsageSettings.tsx` 从 `/api/usage` 显示本地会话/步骤统计、7/30 日区间、终身摘要、日趋势和模型/费用数据。后端从会话仓库读取时间与状态；token 和费用只累计 provider 实际报告的值，缺失价格不估算。 | 上游 `UsageStatsSection.tsx` 同时有本地 App Usage 与 Coding Plan 使用量/账号额度面板。Xueness 当前没有订阅 entitlement、云端计划余额或配额重置数据；空数据不代表额度为零。两张 `usage-dark.png` 截图的模型数据也不同；有实际用量的本地画面见[用量数据示例](screenshots/batch25-native/usage-with-data-dark.png)。 |
| 记忆 | `MemorySettings.tsx` 使用后端工作区目录与三个配置轨道（`memory`、`user`、`key`），支持范围选择、文件搜索、刷新和显式编辑。`memory/editor.py` 对确认写入做 digest 冲突检查、大小限制和路径/软链约束；`catalog.py` 只暴露获准工作区内的记忆文件。 | 上游 `MemorySettingsSection.tsx` / `MemorySettingsViewer.tsx` 从 `IMemoryService` 读取项目记忆目录，并交给工作区文件编辑器处理。两边都有开关、工作区选择、搜索、刷新和文件操作，但存储根、目录投影与编辑器路径不同。截图状态不一致：本地记忆已开启，[上游截图](screenshots/batch25-reference/memory-dark.png)关闭了记忆；请勿据此解读为功能缺失。 |
| 子智能体 | `SubagentSettings.tsx` 保存实际子代理资源、精确工具白名单，以及 `providerId`、模型和推理强度。`subagents.py` 将这些配置用于工具 schema 过滤和 provider 解析；没有覆盖时继承父 provider，不向前端回传密钥。子运行有 4000 字符提示上限、单层深度与独立空会话存储；`core.py` 的调用分发再次检查白名单，plan Gate 拒绝写文件、编辑、执行和需要执行权限的工具。 | 上游 `SubagentsSection.tsx` 还管理内置、用户、工作区和插件代理等作用域，并支持更丰富的模型与资源视图。Xueness 当前是用户自定义资源表单和单层只读委派，不包含同等的多作用域代理目录与会话侧栏。安全核对中发现子代理可借 `workflow_create` / `workflow_amend` 修改持久计划；本轮在子代理 schema 与精确名称分发两层加入拒绝，并用强制工具调用 fixture 验证 workflow 文件未变、未新增记录。另有界面边界：工具配置仍列出部分会被只读 Gate 拒绝的操作（如 `write`、`edit`、`exec`、`workflow_run`）；它们执行时会被拒绝，不构成当前绕过，但可让配置选择与可用能力不一致。 |
| 自动化 | `plugins/automation/index.tsx` 提供定时计划列表、编辑、详情、手动运行、批准和删除。`scheduler.py` 使用本地五字段 Cron 与时区，保存真实工作流计划，按 digest 绑定审批；计划未经批准时创建待审批运行记录而不启动工作流，真实 provider 还受主机开关限制。 | 上游 `AutomationsSection.tsx` 有 scheduled 与 idle 视图、模板、动态工作流及更丰富的运行和会话导航。Xueness 当前只支持本地 Cron 定时；后台 scheduler 没有 idle 触发或模板推荐，也没有上游完整的运行侧栏、产物浏览与运行中工作流控制。界面明确提示 idle trigger 未接入。 |
| 扩展市场 | `plugins/extensions/index.tsx` 以 API 返回的 `MarketplaceItem` 实现搜索、全部/已安装筛选、卡片、来源、详情与 digest 绑定的安装/更新确认。确认框支持焦点约束、Escape、遮罩关闭和焦点恢复。后端 `extensions/marketplace.py` 读取随包目录或配置的 HTTPS 清单源，校验 manifest 与 SHA-256，安装时只写入默认停用的数据清单，不导入清单下载的可执行代码；启用仍受主机策略控制。 | 上游 `PluginStorePage.tsx`、`PluginStoreListView.tsx` 与 `PluginStoreDetailView.tsx` 提供公开/个人市场分段、市场源管理、精选与分类、插件 listing 素材/示例提示词，以及安装、更新、卸载和已安装管理。当前 MarketplaceItem 没有这些服务数据，Xueness 不显示假分类、推荐榜或社区内容，也不提供外部可执行插件安装。 |

## 子代理运行边界复核

工具白名单与 provider profile 不只是表单字段：`provider_with_agent_tools()` 过滤发给模型的 schema；`core.run()` 在执行工具前按允许列表检查调用；`provider_for_agent()` 根据保存的 provider、模型和推理强度解析子代理 provider。最近增加的精确拒绝规则排除了持久写入型 workflow 创建/修改工具，同时保留状态读取工具。父会话原有 plan Gate 行为不变。

复核运行：`python3 -m unittest tests.test_subagents -v`，**50 项通过**。其中 `test_subagent_workflow_mutators_are_not_advertised_or_persisted` 真实调用 `_run_subagent`，让 fixture provider 强制发出创建与修改调用，并核对模型未收到这些 schema、调用被拒绝、已有 WorkflowStore 文件内容和记录集合保持不变。子代理实现代理另报告 `tests.test_subagents`、`tests.test_workflows`、`tests.test_plugin_runtime` 合计 82 项通过及 `git diff --check` 通过。

## 验收证据与限制

最终回归完成 **1,073 项 Python 测试（22 项跳过）**、**330 项前端测试**，TypeScript 类型检查、Vite 构建及 events v1 golden 验证均通过。旧外壳依赖检查通过；随包第三方声明覆盖 197 个生产依赖。Vite 仍提示部分代码块超过 500 KB；本轮未把此提示当成性能验收通过。

浏览器验收使用隔离的临时工作区、本机 HTTP 模型协议 fixture 和真实 Xueness 服务，不调用用户的外部模型或扩展清单源。共记录 12 项基础检查、10 项扩展交互检查、4 项最终检查，涵盖工作区选择/创建、设置持久化、快捷键、模型配置与密钥不回显、实际读文件和 Markdown、复制、报告用量、缓存/资料清理与确认焦点、记忆编辑、子智能体创建与搜索、Cron/DAG 创建、清单安装、中英/明暗/320px 布局、界面字号生效及真实 PTY 使用保存的 Shell。全部完成，未出现 JavaScript 页面异常；不把本机协议 fixture 结果表述为外部模型兼容性认证。

默认字号下，实测常规、外观、浏览器、记忆、子智能体、使用统计六个导航按钮的 x/y/宽/高与参考相同（1440×900）。截图仍不能证明所有状态逐像素一致。本报告采用的截图均位于 `docs/screenshots/batch25-native` 和 `docs/screenshots/batch25-reference`。新增本地证据包括[浏览器清理](screenshots/batch25-native/browser-verified-dark.png)、[记忆编辑](screenshots/batch25-native/memory-editor-verified-dark.png)、[子智能体配置](screenshots/batch25-native/subagents-configured-dark.png)、[工作流编辑](screenshots/batch25-native/automation-editor-dark.png)、[市场详情](screenshots/batch25-native/marketplace-detail-dark.png)及[英文窄屏子智能体](screenshots/batch25-native/subagents-mobile-320.png)。自动化和市场目前没有与上游运行态配对的截图，比较还依赖源码和 API。

若部署配置 `XUENESS_MARKETPLACE_URL`，运行中的后端会按配置读取该 HTTPS 清单，这是服务支持的源类型，不是本次 fixture 测试的结果。浏览器资料清理只作用于当前服务进程管理的 profile；Chrome 个人资料导入仍是桌面能力，网页入口保持不可用。

正常启动命令也单独验证：`python3 -m xueness.web --port 8138`。原先 `__main__` 与插件重新导入的 `xueness.web` 各自创建不同的响应标记，导致已处理请求被再次解包并记录 TypeError。本轮把标记提到共享的 `http_contract.py`。新增真实子进程回归覆盖 sessions、files/file、events 与 completed deltas SSE；临时旧代码负对照可以复现该异常。实际 8138 构建通过 13 个设置入口的只读浏览器检查，未调用模型或改写用户设置，服务日志无对应异常。

上游重点源码：[`SettingsPage.tsx`](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/SettingsPage.tsx)、[`UsageStatsSection.tsx`](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/UsageStatsSection.tsx)、[`MemorySettingsSection.tsx`](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/MemorySettingsSection.tsx)、[`SubagentsSection.tsx`](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/SubagentsSection.tsx)、[`AutomationsSection.tsx`](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/AutomationsSection.tsx)、[`PluginStoreListView.tsx`](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/PluginStoreListView.tsx)、[`PluginStoreDetailView.tsx`](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/PluginStoreDetailView.tsx)。
