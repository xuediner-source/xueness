# Xueness 工作台设计与验收

## 2026-11-26 第四轮：关键组件延后加载与清零超行基线

继续收紧首屏启动图与剩余大文件行数；行为、键盘焦点与全部既有导出契约保持不变，未扩大 `SHARED_FRONTEND`。

- **组件延后加载**（随需求触发挂载，独立打包）：
  - `CommandPalette`（`CommandPalette-Cq6e57G-.js`，10.19 kB / 4.30 kB gzip）：状态与格式函数迁入 `plugins/sessions/commandPaletteState.ts`，`useModalFocusScope` 随组件迁入实现内部激活与关闭回焦，容器挂载点收进 `WorkbenchDialogs.tsx`（`WorkbenchCommandPalette`）。
  - `ComposerModelMenu`（`ComposerModelMenu-BzPkK6hH.js`，11.76 kB / 4.09 kB gzip）：工具栏动态加载，菜单内部通过 `initialFocusKey` 保持挂载后首项或搜索框聚焦，并去除 `XuenessComposerToolbar.tsx` 对菜单的静态全量再导出。
  - `ReasoningEffortSlider`（`ReasoningEffortSlider-b_XkR4Kq.js`，9.16 kB / 3.78 kB gzip）：推理档位纯逻辑迁至 `plugins/sessions/reasoningLevels.ts`，工具栏按模型能力懒加载滑块。
  - `XuenessPluginManager`（`XuenessPluginManager-B_SRDKJD.js`，8.70 kB / 3.36 kB gzip）：共用的 `FeatureUnavailable` 与 `usePluginCatalog` 迁入既有的 `plugins/shared.tsx` 并由原文件转出；插件管理页经 `workbenchSettingsViews` 懒加载。
  - `FullAccessConfirmationDialog`（`FullAccessConfirmationDialog-VSKUrfTJ.js`，3.11 kB / 1.46 kB gzip）：`requiresYoloConfirmation` 保留在 `permissionModes.ts`，确认框按需加载；`LightweightWorkbench` 的全局快捷键纯判断迁至 `lightweightGlobalKeys.ts`、`useLightweightWorkbench.ts` 持有布局判定，均由原入口保留转出。
  - `WorkbenchConversation`（`WorkbenchConversation-BvAu2o8B.js`，19.74 kB / 7.20 kB gzip）：起始页拆为 `WorkbenchStartView.tsx`，仅有活动会话或切换过去时才加载对话视图，并在有 `activeId` 时被动预取。
- **全部 8 个基线文件拆到 400 有效行以内**（`ts/scripts/frontend-lines-baseline.json` 清零为 `{}`；新插件模块全部同步登记在 `ts/plugins/<id>/manifest.json` 与 `ts/catalog/<id>.json`）：
  - `xuenessApi.ts` 593 → 127 行：核心传输留作 `xuenessBridge.ts`，6 个插件领域接口拆回 `providers/providerApi.ts`、`automation/automationApi.ts`、`extensions/extensionsApi.ts`、`usage/usageApi.ts`、`subagents/subagentsApi.ts`、`files/directoryApi.ts`，原入口全量转出兼容既有导入。
  - `plugins/mcp/ElicitationForm.tsx` 537 → 208 行（逻辑与校验迁至 `elicitationSchema.ts`）。
  - `plugins/onboarding/DesktopPermissionOnboarding.tsx` 535 → 342 行（状态机与观察器迁至 `permissionOnboardingModel.ts`）。
  - `XuenessWorkbenchContainer.tsx` 532 → 377 行（次级面板 `WorkbenchSecondaryPanels.tsx` 与 `usePanelHistory`、弹窗与命令面板 `WorkbenchDialogs.tsx`、`WorkbenchComposerControls.tsx`）。
  - `plugins/sessions/secondaryPaneComposer.tsx` 489 → 299 行（提交与草案恢复状态机迁至 `secondaryPaneComposerModel.ts`）。
  - `plugins/sessions/SidebarNav.tsx` 477 → 237 行（列表项组件与比较逻辑迁至 `SidebarNavItem.tsx`）。
  - `plugins/extensions/index.tsx` 450 → 224 行（卡片、详情与焦点辅助迁至 `MarketplaceCard.tsx`）。
  - `plugins/sessions/commandClient.ts` 443 → 368 行（协议类型、回执解析与共用 `raceAbortTimeout` 迁至 `commandClientProtocol.ts`）。

**测量**（`tools/check_frontend_bundle.mjs`，gzip 估算）：

| 启动图 | 第三轮之后 | 第四轮之后 | 相对第一轮前 |
|---|---|---|---|
| JS（gzip） | 279,578 B | 229,191 B（−18.0%） | 361,556 → 229,191（−36.6%） |
| CSS（gzip） | 53,547 B | 53,023 B（xueness 53,023 / claudex 52,485） | 53,535 → 53,023 |
| 合计 | 333,125 B | 282,214 B（−15.3%） | 415,091 → 282,214（−32.0%） |
| 启动文件 | 7 个 | 7 个 | 11 → 7 |
| `App` 块 | 656,849 B / 206,563 B gzip | 498,986 B / 156,234 B gzip（低于 500 kB 警告线） | |

**验收**：`ts run check`（1,262 个产品文件全员 ≤ 400 有效行、`check:plugins` 38 个插件 / 554 个源码文件、`check:version`、`ts typecheck`）、`ts run build`（864 个后端 JS 模块）、`webapp typecheck`、`webapp build`（含 `check:design` 与 `check:bundle`）全部通过，构建无混合动静导入警告；私有测试 overlay `f6-lazy-split.test.ts` 校验基线清零、启动图排除上述 6 个延后加载块、全部 12 处公开导出契约与提取的纯函数行为。

## 2026-11-22 第三轮：Magpie 模型网关取代订阅中心与 WorkBuddy 号池，继续拆分大文件

- **插件替换（项目所有者 2026-11-22 决定）。** 订阅中心（`subscriptions`）与 WorkBuddy 号池（`workbuddy`）从核心与插件仓库中删除，由可下载的官方插件「Magpie 模型网关」（`magpie`）取代。插件包里是 [yetone/magpie](https://github.com/yetone/magpie)（MIT）发布的原版命令行程序，按平台各一个包；Xueness 侧只做进程管理、模型接入与界面。详见 [插件按需下载](optional-plugins-and-folder-skills.md#magpie-模型网关)。
  - 核心：`OPTIONAL_IDS` 改为 `model_monitor`、`tavern`、`magpie`；内核支持按平台固定包（`<id>@<系统>-<架构>`），安装器的下载与解压上限提高到 96 MiB / 192 MiB；服务端的可选账号槽位只剩 magpie，禁用即关闭 magpie 进程；`execution-capabilities` 的 WorkBuddy 分支改为 magpie 网关；工作台注册表、设置导航、面板挂载与扩展市场条目随之更换，英文词条同步。
  - 界面：设置 → 扩展与维护 → Magpie 模型网关（也可作为面板打开）。状态条（启动、停止、重启、网关地址、打开完整 magpie 控制台、发现本机登录开关）与六个页面：概览、供应商与密钥、登录账号、路由组、模型、用量。未运行时各页只显示启动入口，不会自己启动 magpie。
  - magpie 的模型 ID 含 `/`，而 Xueness 的配置 ID 只允许 `[A-Za-z0-9._-]{1,64}`，所以会话里的 ID 是 `magpie.<可读片段>.<SHA-256 前 8 位>`，请求仍发 magpie 的真实 ID。
- **大文件拆分。** 做法同第二轮：原路径保留原有的全部导出（转出），导入方无需改动；新文件登记在所属插件的 `manifest.json` 与 `ts/catalog/<id>.json`；拆分后比对原文件与新模块引用的浏览器全局，次数一致、没有新出现的全局名。
  - `plugins/sessions/ZCodeConversation.tsx` 698 → 195 行：`conversationTypes.ts`、`conversationDisclosure.ts`、`conversationRows.ts`（轮次分组）、`ConversationUserRows.tsx`、`ConversationToolRow.tsx`、`ConversationAnswerRows.tsx`、`ConversationTurnView.tsx`。
  - `plugins/sessions/XuenessTaskList.tsx` 635 → 393 行：`taskListModel.ts`（分组、工作区、用途、项目分桶与归档计划）、`taskListHelpers.ts`、`XuenessTaskListToolbar.tsx`（视图与排序）、`XuenessTaskListMenus.tsx`（任务右键菜单与延后加载的项目菜单）。
  - `plugins/subagents/SubagentSidePane.tsx` 647 → 350 行：`SubagentTaskTypes.ts`、`SubagentTaskFormat.ts`、`SubagentTaskCard.tsx`。
  - `plugins/automation/index.tsx` 646 → 262 行：`automationFormat.ts`、`AutomationCard.tsx`、`AutomationDetail.tsx`、`AutomationForm.tsx`。
- **行数门禁。** 移除以上四个文件的基线，基线从 12 项减到 8 项；最大的前端文件现为 `xuenessApi.ts`（593 行）。

**测量**（同上，gzip 估算）：启动 JS 279,311 → 279,578 B（+267 B），CSS 53,547 B，合计 332,858 → 333,125 B，启动文件仍为 7 个；`App` 块 655,875 B / 206,295 B gzip → 656,849 B / 206,563 B gzip。增加的部分是拆分后多出的组件边界与 props 传递。Magpie 的界面在插件包里，启动包不含它。相对最初：启动 JS 361,556 → 279,578 B（−22.7%），合计 415,091 → 333,125 B（−19.7%）。

插件包（`xueness-marketplace/packages/`，每个包含原版程序、适配层与界面，gzip 后）：Windows x64 52.1 MB、Windows arm64 48.3 MB、Linux x64 50.9 MB、Linux arm64 47.6 MB、macOS x64 51.5 MB、macOS arm64 48.9 MB。

**验收**：`check:plugins`（38 个插件）、`npm --prefix ts run check`、`webapp typecheck`、`webapp build`、启动包预算通过；私有测试 overlay 的前端测试 15 项通过；新增 `marketplace/plugins/magpie/adapter.test.ts`，用真实的 magpie 程序与本机模拟上游跑 14 项（停止状态不启动、关闭本机登录发现、启动、添加自定义供应商、模型列表与会话配置 ID、核心的会话模型列表里出现 magpie 模型且为已配置、一次会话请求经 magpie 到达上游、路由组增改删、供应商启停/测试/密钥、账号/登录/额度/用量/概览/控制台、第二个适配器接管运行中的进程、重启与关闭、禁用时 403 且不启动），全部通过。

真实构建在隔离状态目录下检查：
- Magpie：经真实安装流程（与安装接口相同的 `storeOfficialArtifact` + `installAll`）安装 `win32-x64` 包并启用；关闭本机登录发现后启动；添加指向本机模拟模型的自定义供应商，界面只显示打码后的密钥；会话模型菜单出现「Magpie · fake-md」且为已配置；选中后发送消息会自动启动 magpie，Markdown 回答正常渲染，用量页记下这次请求；禁用插件后接口返回 403、模型从列表消失、magpie 进程退出、端口关闭。
- 拆分后的界面：会话（Markdown、表格、编辑消息与反馈按钮）；任务列表在分组、项目、工作区、用途、时间线视图间切换，任务右键菜单（置顶、重命名、归档），项目右键菜单延后加载后显示六项操作；子代理面板的空状态；自动化面板新建计划（自定义 Cron 与每周两种频率、校验「需要 1 到 64 个执行步骤」、添加命令步骤）、计划卡片、详情、编辑时回填全部字段、删除确认对话框。没有控制台错误。本次状态里没有子代理任务和工具调用，所以 `SubagentTaskCard` 与 `ConversationToolRow` 只经过了类型检查、全局比对与构建，没有在界面上渲染过。桌面应用（此前未运行）由 `Start-Xueness-Desktop.cmd` 启动，V8 代码缓存记下第三轮构建的入口、`App` 与 `markdownRenderer` 块（与 `webapp/dist` 同一哈希），随后是起始页的延后加载块。

## 2026-11-19 前端优化第二轮：Radix 选择器延后加载与大文件拆分

- **选择器延后加载。** `ui/Select.tsx` 是 `@radix-ui/react-select` 的唯一使用者，原先 Radix（`radix-vendor`）与其依赖块（`Combination`）都在启动包里。现在 Radix 在首次挂载选择器时才导入；加载完成前选择器渲染同样结构的触发按钮（`button > span + svg`，同样的类名、`role="combobox"`、`data-state="closed"`，有 `name` 时附隐藏输入），所以界面不移动。这段时间内的点击或回车、空格、方向键会在 Radix 就绪后直接打开菜单；若焦点在占位按钮上，换成 Radix 触发器后焦点保留。未新增共享文件。
- **大文件拆分。** 原路径都保留原有的全部导出（转出），导入方无需改动；新文件登记在所属插件的 `manifest.json` 与 `ts/catalog/<id>.json`。
  - `plugins/providers/index.tsx` 1,330 → 370 行：`providerDraft.ts`（常量、草稿与校验）、`ProviderPanels.tsx`、`ProviderEditor.tsx`，以及从编辑器中分出的 `ProviderCompatibilitySettings.tsx`（API 兼容设置与诊断）和 `ProviderLightweightAdvanced.tsx`（轻量高级选项）。这两块原是编辑器内联 JSX，现在是接收显式 props 的组件，`advancedOpen` 状态仍在编辑器里。
  - `plugins/sessions/XuenessWorkbenchView.tsx` 1,175 → 358 行（`Composer`）：事件处理拆成工厂函数（发送、按键、编辑、附件、草稿操作），副作用拆成自定义 hook（加号菜单、上传同步、窗口 Esc、输入框自适应高度），界面片段拆成无状态组件（建议列表、上下文标签、状态提示、输入面、加号菜单、发送按钮），共 17 个模块，函数体按原样移动。
  - `plugins/sessions/XuenessComposerToolbar.tsx` 861 → 270 行：`composerModelCatalog.ts`、`ComposerModelDetailCard.tsx`、`ComposerModelMenu.tsx`、`ComposerModeControls.tsx`。
  - 拆分后用 TypeScript 检查器比对了原文件与新模块引用的浏览器全局（`document`、`window`、`requestAnimationFrame` 等）：次数一致，没有新出现的全局名，即没有被搬走的闭包变量意外落到同名全局上。
- **行数门禁。** 移除 `providers/index.tsx`、`XuenessWorkbenchView.tsx`、`XuenessComposerToolbar.tsx` 的基线，以及早已过时的 `LightweightWorkbench.tsx`（基线 1,255，实际 252）；`XuenessTaskList` 635、`ZCodeConversation` 698、`SubagentSidePane` 647、`xuenessApi` 593 按实际下调。基线从 16 项减到 12 项，最大的前端文件现为 `ZCodeConversation.tsx`（698 行）。

**测量**（同上，gzip 估算）：

| 启动图 | 第一轮之后 | 第二轮之后 | 相对最初 |
|---|---|---|---|
| JS（gzip） | 302,717 B | 279,311 B（−7.7%） | 361,556 → 279,311（−22.7%） |
| 合计 | 356,264 B | 332,858 B | 415,091 → 332,858（−19.8%） |
| 启动文件 | 9 个 | 7 个（`radix-vendor` 21,162 B 与 `Combination` 4,899 B 移出） | 11 → 7 |
| `App` 块 | 646,353 B / 203,604 B gzip | 655,875 B / 206,295 B gzip | |

`App` 块变大约 9.5 KB（gzip 2.7 KB）：`Composer` 拆成组件后多了 props 传递和组件边界，这是拆分的代价，已计入上面的净值。

**验收**：`check:plugins`、`npm --prefix ts run check`、`webapp typecheck`、`webapp build` 通过；私有测试 overlay 新增 `webapp/src/ui/select-deferred.test.ts`（占位触发器与 Radix 触发器结构一致、隐藏表单值、构建后的启动图不含 `markdown-vendor`、`markdownRenderer`、`radix-vendor`、`WorkbenchSettingsPanel`；最后一项在改动前的构建上按预期失败），连同第一轮共 15 项全部通过。真实构建在隔离状态目录、本机模拟模型下检查：Radix 在 `App` 之后约 110–145ms 加载，选择器随后变为 Radix 实现；视图切换选择器打开 12 个选项，选择后切换视图、菜单关闭、焦点回到触发器；输入框 `/` 建议、方向键高亮与 `aria-activedescendant`、Esc 关闭；接受 `/workflow` 打开工作流面板；加号菜单与模型菜单打开后焦点在菜单内、Esc 关闭并回到按钮；发送后 Markdown 回答正常渲染；供应商编辑器的 API 兼容设置与轻量高级选项正常渲染，编辑字段后草稿更新、保存与恢复按钮变为可用。没有控制台错误。轻量高级选项的 `<details>` 展开没能在 1024×768 视口里用鼠标点到（外层面板裁切，与本轮改动无关），只验证了内容和编辑。桌面应用用 `--quit` 正常退出后由 `Start-Xueness-Desktop.cmd` 重新启动，应用缓存中出现第二轮构建的入口与 `App` 块，随后才是 `radix-vendor`。

## 2026-11-19 前端优化：数据层拆分与启动包瘦身

接着 11-06（层叠层）与 11-07（工作台容器拆分）继续：拆开剩下最大的前端模块，并把首屏用不到的代码移出启动包。界面、功能、权限与插件开关不变。

- **会话数据层拆分。** `xuenessWorkbench.ts`（1,585 行有效代码，前端最大的文件）拆成 sessions 插件内的 11 个模块：`workbenchTypes`（类型）、`sessionPayloadParsers`（严格解析）、`timelineRowSharing`（轮询结构共享）、`sessionHttp`（同源请求与 CSRF）、`startupCommandHandle`（命令客户端懒加载替身）、`sessionReadApi`、`sessionWriteApi`、`sessionForkApi`、`conversationShareApi`、`timelineProjection`（事件与日志投影）、`fileChanges`。`xuenessWorkbench.ts` 保留为 29 行的转出口，导出的名称与签名不变（冻结契约），现有 70 多处导入无需改动。分享接口只被懒加载的分享视图使用，现在随这些视图加载。`queueApi.ts` 与 `sessionsIndex.ts` 改为直接导入具体模块，不再绕回转出口形成循环。`cancelQueuedTurn` 对 `queueApi` 的动态导入改为静态导入：该模块本来就在启动包里，动态导入不起作用，构建因此一直提示混合导入。
- **Markdown 解析器移出启动包。** react-markdown + GFM（`markdown-vendor` 与其依赖块）原先随 `XuenessShell.tsx` 进入启动包。解析与渲染（组件映射、代码块、URL 白名单、内容缓存）移到 `plugins/sessions/markdownRenderer.tsx`；`SimpleMarkdown` 在解析器就绪前用同一容器显示纯文本（`data-md-pending`，保留换行），就绪后渲染 Markdown。外壳在首次绘制之后（首个 passive effect）即开始加载该模块，与首批会话读取并行，所以打开会话时通常已经就绪。最初用 `requestIdleCallback` 预取，实测启动繁忙时空闲回调约 500ms 才触发，直接打开会话链接时对话数据（580ms）先于解析器（612ms）到达，因此改为首次绘制后立即加载。`cachedMarkdownElements` 与 `MARKDOWN_ELEMENT_CACHE_LIMIT` 现在从 `markdownRenderer.tsx` 导出；同步渲染 `SimpleMarkdown` 的测试需先 `await loadMarkdownRenderer()`。
- **设置面板懒加载。** `WorkbenchSettingsPanel` 与其它面板视图一样在面板的 Suspense 内懒加载；它不导入样式表，层叠顺序不受影响。
- **行数门禁。** `xuenessWorkbench.ts` 与 `XuenessShell.tsx`（现 368 行）都已低于 400 行，从基线中移除；容器上限按实际降为 532。新模块全部登记在 sessions 插件的 `manifest.json` 与 `ts/catalog/sessions.json`，未扩大 `SHARED_FRONTEND`。

**测量**（`tools/check_frontend_bundle.mjs`，gzip 估算，不是网络或运行时测量；前后两次构建都来自同一份源码树，只差本轮改动）：

| 启动图 | 之前 | 之后 |
|---|---|---|
| JS（gzip） | 361,556 B | 302,717 B（−58,839，−16.3%） |
| CSS（gzip，含较大的外观） | 53,535 B | 53,547 B（+12，挂起态的一条规则） |
| 合计 | 415,091 B | 356,264 B（−14.2%） |
| 启动 JS/CSS 文件 | 11 个 | 9 个（`markdown-vendor` 45,804 B 与其依赖块 7,928 B 移到首次绘制之后） |
| `App` 块 | 663,858 B / 208,676 B gzip | 646,353 B / 203,604 B gzip |

全部 JS 的总量基本不变（代码是挪后加载，不是删除）。构建警告从两条减为一条：混合静态/动态导入的提示消失；超过 500 kB 的提示仍在（PPTX 渲染器、wasm、shiki 的 cpp 语法和 `App` 块）。

**验收**：`npm --prefix ts run check:plugins`、`npm --prefix ts run check`、`webapp typecheck`、`webapp build`（设计门禁与启动包预算）通过；私有测试 overlay 新增 `webapp/src/plugins/sessions/workbench-data-layer.test.ts`（12 项：转出口导出集合与拆分前一致、投影/结构共享/文件变更/命令行格式化、CSRF 变更请求、Markdown 挂起态与就绪后的 GFM 表格、代码块、URL 白名单），全部通过。真实构建在隔离状态目录中用本机模拟模型（只回答 Markdown，不调用工具）检查：起始页无控制台错误；设置面板在打开时才请求自己的块；流式回答渲染出标题、列表、表格、高亮代码块，`javascript:` 链接降为纯文本；直接打开会话链接时解析器块约 160ms 到达、对话数据约 920ms 到达，没有残留的纯文本挂起态；分享对话框通过新的分享接口模块读取预览。之后用工作区的 `Start-Xueness-Desktop.cmd` 启动桌面应用，其后端以 `--assets xueness\webapp\dist` 运行，应用自己的 Chromium 缓存中出现新构建的入口与 `App` 块，没有旧构建的文件名。

## 2026-11-13 记忆之海

- 记忆面板换成「记忆之海」（`webapp/src/plugins/memory/MemoryOcean.tsx`）：一张全幅 Canvas 星图。说明见 [记忆之海](xueness-memory-ocean.md)。
- 画布始终是夜色的海，只有气氛随外观变化（经典：冷色深海；纸感：暖色墨蓝，`oceanPalette.ts`）。直接画在海面上的文字用固定浅色；卡片、抽屉、对话框和按钮用应用 token，跟随浅色/深色主题。浮在海面上的按钮按下时用实色表面加强调色描边，不用主题里半透明的 active 底色（在浅色主题中它会在深色海面上消失）。
- 渲染分层：`oceanAmbient.ts`（海水背景、焦散光网、光柱、失焦光斑、浮游微粒、海雪、气泡、水面、提灯）、`oceanCharts.ts`（星云、星图边界、星座名称、互不重叠的标签）、`oceanLinks.ts`（按颜色对、关系笔触和强度分批的连线，彗星光流）、`oceanDraw.ts`（星光）、`oceanBloom.ts`（辉光），`oceanScene.ts` 只负责调度、相机和交互。布局（`oceanLayout.ts`）是网格分桶的力导向模拟，起始位置由 id 哈希决定，刷新时保留已有位置，静止后（若用户未操作）重新取景，取景避开顶部工具栏。动画时钟按真实时间推进（单帧最多 0.25 秒），页面隐藏时停止；帧开销持续超过 18ms 时降级。
- 2026-11-13 星光重做（用户反馈「光晕廉价」）：原来每颗星是一张饱和的径向渐变贴图叠加，像彩灯。现在星体按光学点扩散函数逐像素生成（高斯核心 + Moffat 内晕 + 极淡外晕，中心近白），辉光改为四分之一分辨率光缓冲经三档模糊后以 screen 混合叠回；辉光强度随重要程度变化，低重要度只是清晰的小点；星芒改为发丝细线，光环改为模糊后的光晕；配色改为更柔和的星光色调。
- 动效：开场下潜、光点摆动与轻微闪烁、选中时连线上的彗星光流与邻居标签、搜索命中与选中的声呐光环、召回光环与沿线光点、新记忆升起绽放、点击涟漪、气泡上浮破开、相机缓动与拖动惯性。减少动效时布局直接静止，只在操作时重绘；CSS 入场动画由全局 reduced-motion 层停止。
- 纸感外观的侧栏原来没有记忆入口（只有经典外观的图标栏有），现在侧栏有「记忆之海」。
- 验收：构建产物中以 1440×900 视口检查了纸感浅色与经典深色、搜索与列表、详情卡、新增对话框、减少动效（画面 2.5 秒内不变，关闭后恢复动画）。

## 2026-11-08 插件界面共用基础

逐个打磨原生插件之前，先统一它们共用的部分。插件的功能、开关和权限不变。

- 设置页只有一个标题。插件面板放进已经显示标题的设置页时传入 `embedded`，只保留说明和操作按钮：自动化、扩展市场、应用更新、诊断与维护、插件管理（功能模块与插件页）。工作区设置的「工作区设置」小标题只在选择工作区对话框中显示；在设置页中「默认工作区」按分组标题的字号显示。功能模块与插件页展示同一份目录，共用宽版目录布局。
- 资源列表（技能、命令、MCP、钩子）：行样式按现在的类名 `xn-resource-item` 编写，开关、状态与删除按钮回到行的右侧。原先的样式仍写给旧类名 `xn-cap-item`，导致开关落到图标下方（上游即如此）。
- 技能列表：随 Xueness 提供的内置技能（`source: "bundled"`）折叠为「官方内置技能」一组，默认收起，只占一行，显示数量与已启用数；展开后每项显示完整说明，可逐个启用或停用。搜索时该组自动展开，匹配项不会被藏起来；用户自己的技能仍排在前面。分组归技能插件所有（`SkillsSection`），共用资源区块只提供 `footer` 插槽和 `totalCount`，并导出行组件 `CapabilityItemRow`。
- 浏览器面板（`plugins/browser/BrowserPanel.tsx`、`BrowserInspector.tsx`、`browserPaneModel.ts`、`browser-pane.css`）重做为浏览器窗口的形态：标签栏（最多 8 个，显示加载与待批准状态）、带锁形图标的地址栏（输入 `example.com` 自动补全 `https://`，Ctrl+L 聚焦）、重新加载、截图和检查器开关；截图显示在点阵画布上，可在适应宽度与实际大小之间切换，加载时有进度条，页面变化后提示重新截图。批准模型不变：每个操作（包括截图）仍逐次批准，但批准条用文字说明要做的事（点击时写出所选元素的角色和名称）、区分只读与会向网站发送请求的操作，确切批准内容可展开查看，Enter 批准、Esc 取消。开启「页面变化后请求截图」时，导航、点击、填写成功后会自动发起一次截图请求，仍需批准。检查器有三页：元素（把无障碍快照解析成可筛选的元素列表，点选即填入目标，再点击或填写；点击或填写后提示元素可能失效）、文字（页面文字与链接，HTTPS 链接可直接打开）、记录（本标签页请求、批准、完成、失败和取消的操作）。worker 返回的英文错误改为说明原因和下一步的中文提示。`bridge.mjs` 只放行自己的固定拒绝原因（非公网 HTTPS、页面不可用、截图超限等），新增 `fakeip DNS answer blocked`：代理处于 FakeIP 模式、系统 DNS 只返回 198.18.0.0/15 时，仍按安全规则拒绝，但会说明原因，不再显示笼统的失败；Playwright 超时报告为 `page load timed out`；驱动或页面抛出的其他错误仍统一为 `browser action failed`，以免带出页面内容或路径。地址栏在导航被拒绝、失败或取消批准后恢复为当前页面地址。端到端验收使用 Playwright 1.65（安装在临时目录，通过 `XUENESS_DESKTOP_PLAYWRIGHT` 指向）和本机 Edge，覆盖新建标签页、导航、截图、读取元素、点击、文字、记录、私网与 FakeIP 拒绝以及关闭标签页。会话时间线中的浏览器工具结果仍不内联截图。
- DeepSeek Harness 扩展包库（设置 → 扩展与维护 → DeepSeek Harness，插件生效时显示）：可以选择一个文件夹，也可以只选清单文件，导入其他作者制作的声明式 DSH 扩展包。支持两种格式：`deepseek-harness.json`，或带 `xuenessHarness` 块的 `package.json`；同时有两者时与加载器一样优先使用后者。浏览器读取所选文件，只把清单和清单 `skills[].path` 引用的文本文件发给服务器。服务器用加载器现有的校验规则检查（`ts/plugins/deepseek_harness/src/library.ts`），先给出预览：声明的工具、钩子、校验命令、技能、提示模板，以及缺少的技能文件、会替换的旧版本和与已导入扩展的冲突。确认后把清单与技能文件复制到状态目录的 `deepseek-harness/library/<id>/` 并挂载；失败时不留下任何改动。库中每个扩展包显示检查结果（SDK 版本、本地副本、清单是否变化、技能文件是否齐全），可以移除。安全边界不变：不运行包内任何代码，声明的校验命令和钩子只列出、不执行；没有 `xuenessHarness` 块、需要运行自身代码的 `package.json` 会被拒绝并说明原因；路径不能跳出包目录。服务器不会主动下载扩展包，来自 GitHub 的扩展需要先下载到本机再选择。接口为 `/api/deepseek_harness`（列表、预览、导入、移除），校验结果包括拒绝都以 200 和 `ok` 字段返回，以便页面显示原因和逐条问题。导入的扩展目前只登记、展示和检查，还没有接入运行。（2026-11-12 补记：这个页面和接口已由通用的「扩展包导入」取代，这种声明式格式也已停止导入，见 `docs/DEEPSEEK-HARNESS-GUIDE.md`。）
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
