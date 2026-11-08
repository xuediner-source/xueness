# Xueness 工作台设计与验收

## 2026-11-08 插件界面共用基础

逐个打磨原生插件之前，先统一它们共用的部分。插件的功能、开关和权限不变。

- 设置页只有一个标题。插件面板放进已经显示标题的设置页时传入 `embedded`，只保留说明和操作按钮：自动化、扩展市场、应用更新、诊断与维护、插件管理（功能模块与插件页）。工作区设置的「工作区设置」小标题只在选择工作区对话框中显示；在设置页中「默认工作区」按分组标题的字号显示。功能模块与插件页展示同一份目录，共用宽版目录布局。
- 资源列表（技能、命令、MCP、钩子）：行样式按现在的类名 `xn-resource-item` 编写，开关、状态与删除按钮回到行的右侧。原先的样式仍写给旧类名 `xn-cap-item`，导致开关落到图标下方（上游即如此）。
- 技能列表：随 Xueness 提供的内置技能（`source: "bundled"`）折叠为「官方内置技能」一组，默认收起，只占一行，显示数量与已启用数；展开后每项显示完整说明，可逐个启用或停用。搜索时该组自动展开，匹配项不会被藏起来；用户自己的技能仍排在前面。分组归技能插件所有（`SkillsSection`），共用资源区块只提供 `footer` 插槽和 `totalCount`，并导出行组件 `CapabilityItemRow`。
- 空态：`ui/primitives` 的 `EmptyState` 增加可选的 `icon`、`action`、`tone="error"` 与 `compact`，原有调用不变。资源列表的空态改用它，并说明这类资源的用途，不再只显示「暂无配置」。
- 控件：网络搜索的两个下拉框改用共用的 `ui/Select`；未单独设置样式的原生复选框、单选框和滑块使用外观的主色（`accent-color`）。
- 图表颜色：`tokens.css` 为经典 / 纸感 × 浅色 / 深色各定义 `--xn-chart-1…8`（第 8 个为中性的「其他」）和热力色 `--xn-chart-heat`（经典为前景色，纸感为品牌赭色）。用量的热力图、柱状图和模型颜色，以及上下文透镜的各个分类都改用这些变量。模型颜色仍按模型名哈希保持稳定，但只在调色板内取色；上下文透镜保留上游的分类配对。经典外观原来单独覆盖热力图的四条规则已删除，效果由变量提供。

**验收**：`npm --prefix ts run check`、`webapp typecheck`、`webapp build`（设计门禁与启动包预算）通过；启动 CSS 为 52,967 B gzip（此前 52,703 B）。在隔离状态目录、本机模拟模型下，对改动涉及的设置页与上下文透镜做了离屏截图检查，覆盖纸感浅色、经典浅色和纸感深色。逐个插件的打磨（诊断仍显示原始 JSON、子代理的错误信息、Git 与文件面板的空态等）留到后续按插件进行。

## 2026-11-07 工作台容器拆分

`XuenessWorkbenchContainer.tsx` 从 3,012 行有效代码拆成各插件自己的 hook 与视图组件；容器只保留面板 / 会话导航与前进后退历史、插件视图挂载表和外壳布局（539 行）。行为与界面不变。

- sessions：`useWorkbenchSessionData`（侧栏列表、当前会话快照、更早分页、推送 / 轮询，effect 顺序不变）、`useSessionRunActions`、`useSessionSend`、`useSessionQueueActions`、`useSessionListActions`、`useComposerCatalog`（运行选项、工作区目录、斜杠命令）、`useWorkspaceSelection`、`usePrimaryPaneSelection`、`workbenchSessionState`、`workbenchDrafts`；视图 `WorkbenchConversation`（对话与起始页）、`WorkbenchComposerControls`、`WorkbenchSessionHeader`、`WorkbenchSidebar`。命令面板、分叉和侧面板绑定的状态放在 `CommandPalette.tsx`、`primaryForkCommand.ts`、`paneSidePanelBinding.ts` 中。
- settings：`useWorkbenchSettings`（设置读写队列与文档级外观效果）、`WorkbenchSettingsPanel`、`workbenchSettingsViews`（设置分区与工作台面板共用的懒加载视图，只声明一次，避免同一视图第二次挂起）；全局快捷键 `useWorkbenchGlobalShortcuts` 在 `workbenchShortcutActions.ts`。
- files：`useWorkbenchFiles`；providers：`useDefaultModelSelection`、`useLightweightWorkbench`。
- 共享内核（未扩大 `SHARED_FRONTEND`）：插件目录 `usePluginCatalog` 在 `XuenessPluginManager.tsx`，能力面板 `useCapabilitySections` 与 `WorkbenchPanel` 在 `xuenessPluginRegistry.ts`，面板数据加载 `usePanelResource` 在 `plugins/shared.tsx`。
- 同一层叠层内后出现的样式表在同等权重下获胜，因此容器顶部按原顺序显式导入它所挂载组件的样式表，打包后的 CSS 与拆分前逐字节相同。
- 新文件均登记在所属插件的 `manifest.json` 与 `ts/catalog/<id>.json` 的 `frontendModules`；容器行数上限从 3018 降到 539。

**验收**：`npm --prefix ts run check`、`webapp typecheck`、`webapp build`（设计门禁与启动包预算）通过。在隔离状态目录、本机模拟模型下，起始页、展开工作记录的对话、Ctrl+K 面板与设置 → 外观在经典 / 纸感 × 浅色 / 深色、1440×900 离屏截图，拆分前后各三轮：除标题栏「分屏组」数量（3 或 4，取决于启动时序，拆分前后的构建交替运行时两种结果都会出现）外，截图逐像素一致，全部元素的计算样式一致。

## 2026-11-06 样式层叠层（cascade layers）

样式表之间的优先级改由显式层叠层决定，不再依赖加载顺序或选择器权重；界面表现不变。

- 层序在 `webapp/src/styles/layers.css` 中声明一次：`reduced-motion, tokens, base, components, plugins, motion, appearance`。`vite.config.ts` 把它作为 `index.html` 与 `tray.html` 的第一个 `<style>` 内联，先于外观 `<link>` 与各个 chunk，因此懒加载的样式无法再覆盖后面的层，`main.tsx` 也不再需要把 `#xn-appearance` 挪到最后。
- 归属：`tokens.css` → tokens；`styles.css`（及 `index.html`、`App.tsx` 的内联样式）→ base；`styles/*.css`、`ui/*.css` → components；`plugins/**` 下的样式 → plugins；`motion.css` → motion；两套外观 → appearance。新样式表必须包在其中一层里，未分层的规则会压过所有层。
- 动效：减少动效的覆盖放在最前面的 `reduced-motion` 层——层与层之间 `!important` 的顺序相反，最早的层获胜，所以它压过任何组件自己的 `!important`；原先 `styles.css`、`workbench`、资源面板里重复的减少动效块已合并进来。`motion` 在 `appearance` 之前，因为两套外观会调整自己的过渡。
- 历史补丁文件已并入所补的组件：`parity-final.css`、`batch10.css` 拆分并入 `styles.css`、`workbench.css`、`conversation.css`、`settings.css`、`browser.css` 等并删除；`workbench-refresh.css`、`conversation-refresh.css` 更名为组件文件 `workbench.css`、`conversation.css`；`task-list-parity.css`、`model-parity.css`、`resources-parity.css` 分别成为 `plugins/sessions/task-list.css`、`styles/provider-settings.css`、`styles/capabilities.css`。被同一文件中后续同名规则完全覆盖的声明已删除。
- 原本靠更高权重压过外观的少数组件规则，在外观层顶部用 `revert-layer` 保留原值；Claudex 审批卡片不再需要 `!important`。

## 2026-11-05 动效系统与外观深化

以 ZCode 式经典布局与 Codex 式纸感外观为基线，本轮补上两者都没有的“时间维度”：让状态变化可被看见，同时不增加任何能力或权限面。全部改动只影响表现；功能、权限、插件开关和请求均不变。

**动效系统**（`webapp/src/styles/motion.css`，`tokens.css` 新增 `--dur-*`、`--ease-*`、`--stagger`）

- 原则：动效解释状态而非装饰；入场 220–420ms、expo-out，退出更快；只动 opacity / translate / scale / clip-path，不触发重排。入场一律 `animation-fill-mode: backwards`——`both` 会让结束后的变换动画继续形成层叠上下文，把输入框菜单压到起始卡片下面。
- 浮层：菜单与弹出层从触发点展开（输入框菜单向上），对话框遮罩淡入、面板自下方落定。
- 会话：切换会话时时间线入场（视口按会话 id 重挂载）；只有最新一轮动画，历史滚动不抖动；工作记录逐步出现，展开已完成记录时有上限的级联；折叠内容从摘要处展开，箭头用弹簧曲线旋转。
- 进行中：当前活动（正在处理 / 工作中 / 思考中 / 正在执行的工具）文字微光扫过并带脉冲点；流式回答末尾有呼吸的墨点；运行中输入框边缘有一个沿圆周移动的光点（`--xn-aurora-color` 由外观决定）；侧栏运行中的会话显示轨道指示。
- 反馈：复制成功的对勾弹出、按钮按下回弹、发送 / 停止按钮形变、回到底部按钮在有新内容时带提示点；加载界面前 180ms 不显示，避免闪烁。
- 视图过渡：浅色 / 深色从刚点击的位置圆形展开；切换外观淡入淡出；收起 / 展开侧栏时侧栏与工作区在宽度间变形（`SessionMotion.runViewTransition`，`html[data-xn-vt]` 限定参与元素）。启动时应用主题不会播放。
- 滚动驱动：对话标题栏只有在内容滚到其下方时才出现分隔阴影（`animation-timeline`，不支持时保留原分隔线）。
- 可控：系统“减少动态效果”与设置 → 外观 →“减少动效”（`reduceMotion`，启动前即生效）都会停止全部装饰性动画。

**外观深化**

- 纸感：纸面与桌面共享极淡的纤维纹理；选中文字与查找命中呈荧光笔效果；输入框是落在纸上的卡片，聚焦时边缘变暖；工作记录变成笔记本页边线，每一步一个墨点（等待空心、完成实心、失败红圈、运行中脉冲）；当前会话左侧一道墨线；起始问候下方手写笔画从左到右画出。修正了宽窗口下纸感起始页输入框与快捷入口未居中的问题。
- 经典（Superposition）：工作步骤是“概率节点”——运行中虚线波纹、观测后坍缩为实心墨点；进行中的轨迹线加深；用户消息成为带阴影的纸条；当前会话边缘的墨色刻度；起始卡片由虚线邀请在悬停时变实。
- 两种外观共用：命令面板改为大号搜索行、列表式选项与强调边标记；设置中的外观选择改为按各自真实配色绘制的工作台缩略图。

**会话体验**：运行中的工作状态显示实时计时（`LiveElapsed`，`aria-hidden`，避免读屏每秒播报）。

**验收**：`check:plugins`、`check:lines`、`check:design`（对比度 ≥ 4.71:1）、`webapp typecheck`、`webapp build` 与启动包预算通过。使用本机 OpenAI 兼容模拟模型（不调用任何真实或收费模型）在隔离状态目录中走完整会话：推理、工具调用、批准、失败步骤、流式回答，并在经典 / 纸感 × 浅色 / 深色下离屏截图核对；视图过渡用生命周期计时核对（更新 39ms、结束约 670ms 后清除标记）。

> 当前目标已按用户最新要求调整为：除 Xueness 品牌外，详细对照 ZCode v3.14.3 的前端布局、设置和交互。最新实现、实测与剩余差异见 [2026-10-01 对照记录](https://github.com/xuediner-source/xueness-private-tests/blob/main/archive/project/docs/zcode-ui-parity-2026-10-01.md)。公开离线入口和旧外壳已经移除；下文仅保留第二十二批的历史设计和验证记录，其中 Codex 风格、252px 侧栏及离线演示均不是当前设计目标。

2026-09-30，第二十二批。功能继续参考 ZCode；界面按用户授权采用 Codex 式的简洁工作台方向。这里是 Xueness 自己的设计实现，不声称使用了 Codex 内部组件或官方设计 token。

## 设计方向

中性色作为画布、导航和主要操作的基础，颜色用于成功、警告与错误。文字、间距和轻边界区分层级；对话正文和输入区是视觉中心。辅助模块沿用统一工具栏和页面宽度。

- **主框架**：252px 侧栏、顶部轻量品牌与收起按钮、紧凑任务列表与底部常用入口。桌面可收起侧栏；窄屏使用遮罩抽屉，支持焦点约束、Escape、遮罩关闭、导航后关闭和焦点恢复。
- **空态与对话**：移除大水印，缩短空态说明，保留真实模型/离线模式的信息。空态同样可从视图选择器进入插件、自动化、市场和诊断。对话头保留视图切换与刷新，置顶、重命名和删除收进可键盘操作的更多菜单。
- **输入**：文本区随内容增高，输入辅助与运行选项分组，保留真实的 `/` 命令与 `@` 文件候选、Enter 发送、Shift+Enter 换行。发送仍调用原有处理器；没有新增装饰性假按钮。
- **时间线**：用户消息用轻量气泡，助手回答以正文呈现，工具调用采用紧凑步骤行；长参数与错误支持展开。持久模型文本、中断提示和逐调用批准流程继续保留。
- **插件**：26 个模块以紧凑列表呈现，支持名称/ID/依赖搜索，以及全部、生效、禁用、依赖阻塞筛选。开关区分 enabled 与 effective，配置错误与失败反馈继续来自后端。
- **一致性**：浅色、深色、中英与移动布局共用同一组本地 token。保留清晰的键盘焦点；遵循 reduced-motion。数据加载错误提供重新加载入口，成功加载清除对应错误。

## 实现入口

- `webapp/src/styles/tokens.css`：本地中性色与语义色。
- `webapp/src/styles/workbench.css`：框架、导航、工具栏、页面与窄屏布局。
- `webapp/src/styles/conversation.css`：输入区、文字和工具步骤。
- `webapp/src/XuenessShell.tsx`：桌面/移动侧栏与焦点生命周期。
- `webapp/src/XuenessWorkbenchContainer.tsx`：真实入口、加载恢复和插件受控视图；状态与动作在各插件的 hook 中（见 2026-11-07）。
- `webapp/src/XuenessPluginManager.tsx`：搜索、状态筛选与模块开关。

所有业务仍由可信插件注册表和服务器权限控制。视觉更改没有移除审批，也不会授权真实模型或外部连接。

## 验收

前端 239 项测试、TypeScript 类型检查、Vite 构建与两个 golden 协议校验通过。构建仍提示已有的大 chunk 和部分模块同时静态/动态引用。本轮不修改后端；此前的 961 项 Python 回归记录见 [插件架构说明](xueness-plugin-architecture.md)。

最终浏览器验收使用最新构建、独立临时工作区和本机后端，关闭真实模型并阻断外部请求。以下交互已通过：

- 空态进入自动化、插件市场和诊断；桌面侧栏收起/展开（252 → 0 → 252px）；中英与浅色/深色切换。
- 插件搜索与禁用筛选；开关关闭与恢复均得到 POST 200，并通过后续 GET 确认 enabled/effective 状态。
- 离线演示产生真实的工具审批时间线；批准后重试完成临时文件的写入、读取和完成事件。
- 长错误摘要在展开时仍可见，鼠标和键盘可重复开合；更多菜单 Escape 关闭并恢复焦点。
- Shift+Enter 换行与 Enter 发送；输入区随宽度重新计算高度（桌面 113px → 320px 窄屏 280px → 桌面 113px）。
- 移动抽屉初始焦点、12 次 Tab 焦点约束、Escape 回焦、遮罩关闭、选择任务后关闭并恢复主内容焦点；320/390px 会话与插件页面无水平溢出。
- 注入一次会话列表 503 后显示重新加载，重试成功后提示清除。除这次刻意注入的失败外，没有页面异常、后端异常或外部网络请求。

长错误用浏览器响应中的明确 QA fixture 验证，长参数只修改临时日志，不代表真实模型发生错误。手机头部的自动几何断言选中了已隐藏的图标，未将该测量作为验收依据；人工检查最终截图确认菜单按钮与标题没有重叠。本轮没有验证真实模型服务或外部连接。

最终截图：

- 桌面首页
- 浅色会话 · 深色会话与 QA 错误摘要
- 插件桌面列表 · 插件窄屏列表
- 移动会话 · 移动抽屉
- 长错误展开

临时后端、浏览器与隔离状态已清理。此次并行实现和审查的子代理使用 GPT-6Luna，推理等级 MAX。
