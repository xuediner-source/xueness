# Xueness 插件架构

应用的用户能力由可信 bundled plugin 提供。后端代码在 `ts/plugins/<id>/`；功能目录在 `ts/catalog/<id>.json`，插件清单在各插件 `manifest.json`。功能 ID 使用稳定的 `<plugin>.<feature>`，提供中文名称和英文 nameEn。前端实现位于 `webapp/src/plugins/<id>/`，由前端注册表静态挂载。

每个工具、CLI、HTTP 路由族、后台 effect、面板和用户动作都必须有归属。仅在插件及依赖有效时开始新动作；禁用后清理生命周期资源。插件开关不授予操作权限。可选插件资源按固定摘要装载，配置数据不能变成动态代码入口。

主工作台只协调状态、布局、焦点和插件挂载。主 CLI、Web 宿主和 Agent 驱动负责协议与协调。存储/journal、租约、写锁、工具注册、批准协议、通用预算、HTTP 身份与 Origin/CSRF、插件管理和基础 UI 是共享基础设施；不能在这些位置加入独立领域业务。插件管理应在功能插件关闭后仍可用于恢复开关。

生产入口绑定状态目录：服务器/桌面使用 `createApplicationApi({ stateDir })`，CLI 使用 `--state`。会话运行与工作区权限边界保持一致。历史工具消息保存的是结果与回指，不能授权后续操作。

浏览器工作台归 `browser.side_tabs`。地址栏、截图、元素检查器和标签内操作记录复用现有逐次批准，截图自动请求也会先等待批准。

通用扩展包导入归 `extensions.package_import`，入口是 `/api/plugins/imports`。包类型由拥有该格式的插件登记：Xueness 自有的声明式清单（`xueness`）由 extensions 提供，DeepSeek Harness 包（`dsh`）由 deepseek_harness 提供，两者地位相同。类型只在所属插件有效时可用；未指定类型时由唯一识别该清单的导入器处理。导入只读取数据，不执行包内代码，新导入的 Xueness 清单默认关闭。导入器以与格式无关的包视图回答，所以「设置 → 扩展与维护 → 扩展包导入」和命令行 `xueness plugin imports`、`plugin import <路径> [--type] [--replace] [--dry-run]`、`plugin unimport <类型> <ID>` 对所有类型使用同一套界面与流程；文件夹内的清单按各类型登记的文件名查找，包内文件只在导入器要求时读取。

插件分三类。官方内置插件随应用一起发布，在功能模块页面标为「官方内置」。插件中心的可下载插件同样由 Xueness 官方制作，但不预装，由扩展市场按固定摘要下载后再启用，标为「插件中心」；目前是订阅中心、返回模型监测、WorkBuddy 号池和酒馆（`tavern`：导入 SillyTavern 兼容的角色卡与世界书并开始角色扮演对话）。哪些包属于这一类只由内核固定的包清单决定，扩展市场和导入器都从它判断，不各自维护名单。第三类是用户从本机导入的扩展包，在扩展包导入页面标为「导入」，其中包括从 DeepSeek Harness 导入的声明式扩展包。前两类的代码都来自构建时确定的清单；导入的扩展包只有数据，不带可执行代码。

DeepSeek Harness 生态中公开发布的插件（GitHub 主题 `dsh-plugin`）是代码插件：`package.json` 带有 `dsh` 块，由 `cordis.patch.yml` 把包的入口挂载到 DSH 的 Cordis 宿主，并调用 `@deepseek-ai/dsh-*` 运行时服务。Xueness 没有 Cordis 宿主，也不加载清单之外的代码，所以这类插件不能导入或运行。扩展包导入会识别它们，显示名称、版本、许可和所需的 DSH 运行时服务，并说明原因；包内的技能文件夹是纯文本，可以按「技能文件夹」类型单独导入。DSH 类型实际能导入的是声明式扩展包（`deepseek-harness.json`，或带 `xuenessHarness` 块的 `package.json`）。

目前登记的包类型及归属：`xueness`（extensions，Xueness 声明式清单）、`skill`（skills，含 `SKILL.md` 的技能文件夹，走技能插件既有的分阶段文件夹导入，导入后与在技能页面添加的技能相同；为 Claude Code 编写的技能文件夹布局一致，可直接导入）、`cursor-rules`（commands，`.cursorrules` 与 `.cursor/rules` 下的 `.mdc`/`.md` 规则，启用后每条规则是一个斜杠命令）、`mcp-servers`（mcp，`.mcp.json`/`mcp.json` 中的 `mcpServers`，导入的服务器一律关闭并带来源标记，由用户在 MCP 页面逐个检查后启用；请求头凭据不导入）和 `dsh`（deepseek_harness）。没有自有存储的类型把导入副本放在 extensions 提供的文本包存储 `<状态目录>/package-imports/<类型>/` 中。导入器可以在预览结果中用 `wants` 列出需要的包内文件路径模式，客户端从所选文件夹读取后以 base64 发送；一次导入连同清单须在单个请求内（最多 100 个文件、600 KB）。

已导入扩展包的启用归 `extensions.package_activation`。导入不等于启用：用户在扩展包导入页或用 `xueness plugin activate <类型> <ID>` 明确启用后，扩展包中的技能登记为技能插件的资源，提示模板登记为命令插件的资源（斜杠命令 `/<包ID>.<模板ID>`）。写入经过所属插件自己的资源接口，所以只在该插件有效时生效，并与用户手工创建的资源一样显示、编辑、关闭和受权限约束。写入的资源带有来源标记；启用不会覆盖没有该标记的同名资源，停用和移除扩展包只删除带标记的资源，替换已启用的扩展包会刷新它登记的内容。包类型通过导入器的 `contributions` 提供可启用的内容：DSH 类型提供技能和提示模板；Xueness 声明式清单提供带正文的技能和命令，以及带定义的钩子。钩子会运行命令，所以启用扩展包只把它登记到钩子插件并保持关闭，由用户在钩子页面逐个检查后打开；替换扩展包时，事件、命令或匹配条件有变化的钩子回到关闭。DSH 扩展包中声明的工具、钩子和校验命令仍然只供查看。

DSH 包类型归 `deepseek_harness.library`。启用该插件后，通用扩展包导入可以预览、导入、校验或移除声明式 DSH 清单与引用的技能文本。扩展库用状态目录内的私有暂存目录和既有写锁完成导入。工具、钩子与校验命令在库中只供查看。原先仅供 DSH 使用的设置页、`/api/deepseek_harness` 路由和 `harness` 命令已并入通用导入。

当前轻量模式的归属：

- providers：工具精简、协议适配、真实 usage 校准、预算与请求视图、稳定历史检查点、工具发现和结果分页。只选择请求视图，不改写完整 journal，不丢弃人类要求。
- files：读写、搜索、预览、修改与快照。分段追加写入复用编码、版本检查和原子写入；工具输入与数据完整性独立于审批模式。
- planning：任务清单、交付要求与实际内容检查、目标生命周期、工作指导和一次性预算收尾提醒。
- sessions：会话、队列、批准、历史和恢复；前端权限切换随当前会话生效。

工具分派区分未知/未注册工具与已知但禁用的插件。未知工具不执行，反馈使用当前 schema；这属于注册协议诊断，不是新增审批或文件业务。完全访问模式的边界见 [权限说明](xueness-permission-modes.md)。

OS Computer Use（`os_cua`）按平台选择适配器：macOS 使用原生辅助程序，Windows 使用随插件发布的 PowerShell 脚本；两者共用同一个辅助进程运行器（超时、取消、单次只运行一个）。

平台处理继续复用既有路径、文件系统和子进程基础设施。Windows 子进程的创建、编码、Job/进程树回收，POSIX 会话进程组回收，以及文件修改的版本与原子性不得由各插件复制出互不协调的第二套实现。

构建门禁检查插件归属、前端登记、模块边界和行数。验证套件、测试 CI 与历史审查证据在 [私有验证库](https://github.com/xuediner-source/xueness-private-tests)；公开仓库不包含这些材料。

独立 CLI 分发归属 `desktop.cli_distribution`：PowerShell 安装器和终端启动器在 `desktop/src/` 登记，发布数据契约在 desktop 插件。`install.ps1` 只引导到此实现；`ts/scripts/package-cli.ts` 是复用后端构建产物的打包工具。安装是用户主动执行、早于应用状态存在的引导过程，管理自己的用户级程序目录和 PATH，不读取或迁移模型凭据。安装后的 CLI 仍由现有状态绑定入口分派，各业务命令继续执行所属插件开关和权限；启动器不增加另一套 Agent 或授权逻辑。

planning 的独立交付验收由 `delivery_verify` 工具、请求扩展及独立 Node 探针提供。实际执行仍通过工具桥的 exec Gate、插件租约、运行取消和既有子进程基础设施。探针从真实 `.mjs` 消费者导入明确要求可导入的交付模块，检查导入返回与用户要求的静默行为；文件/JSON检查与导入检查分别报告，不代表完整行为正确。

共享驱动的本轮调整仅补齐既有 `afterModelResponse` 接缝的通用记账：有效插件追加的新工具调用ID，也必须在执行前进入持久 intent/settlement ledger。模型流未接纳的片段仍不接纳；工具注册、schema、Gate、批准与生命周期检查均复用原分派。这是日志一致性的共享基础设施修正，验收触发条件和所有领域判断仍归 planning 插件。
