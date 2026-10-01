# Xueness Agent CLI：功能补齐与后续插件拆分（进行中）

> 2026-09-29 用户确认：主产品是自用 Agent CLI，参考开源 ZCode 的设计与功能；先完成并验收功能，再拆成类似 DeepSeek Harness 的插件形式。已有内核/协议/插件接口保留。以下早期分层计划是历史过程，不再代表插件优先的实施顺序。最新上游审查与下一批顺序见 `zcode-upstream-2026-09-29.md`。

日期：2026-09-27。用户最新决定：Xueness 最终是**拥有自己的 Agent 运行时与插件接口**的产品；ZCode、DeepSeek Harness、其他 Harness、自制 Agent 只作为设计参考。本文取代 `reviews/dsh-zcode-workbench.md` 中「最终必须以 DSH 为内核」的旧目标；那份记录仍保存当时的研究过程，不代表当前方向。

## 参考来源与边界

- ZCode：`zai-org/ZCode@328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`。当前 `vendor/zcode/` 派生 UI 仍依赖 `@zcode/ui`、`@zcode/shared` 等包。Apache-2.0：保留 `LICENSE`/`NOTICE.md`、改动记录；不使用其商标冒充 Xueness。现有 UI 只能叫过渡界面，不等于自有 Agent。
- DeepSeek Harness：既有审查 pin `deepseek-ai/deepseek-harness@477b4f420553e8a52c2fbccc464d7561b239c443`（`reviews/dsh-zcode-workbench.md`）。借鉴可插拔的 host/client 面板、session controller、审批由 host 持有；不承诺兼容其插件 ABI，除非单独做经测试的 adapter。
- Apix：`JJJJSTIYYYY/Apix@e7d542c95b876df5391c9409ee502fc05670de53`（Version_2.2），GPL-3.0。**仅借鉴理念，不复制 GPL 源码**：子任务状态/进度镜像、路径冲突模型、消息分支。不要照搬它的 `--network host`、可写宿主挂载、对外端口与 Docker socket 模式。
- 「Harness」指代尚不明确。确认具体仓库/版本前，不把任意第三方代码或协议套进 Xueness。

## 现状与明确缺口

| 层 | 已实现（必须复验） | 下一步 | 验收 |
|---|---|---|---|
| Python 内核 | `xueness/core.py` 的 journal、tool execution、Gate、按 call id 单次审批、plan/build、Fake/兼容模型 | 把内建工具的声明与分派移至 Xueness 自有注册表；策略仍由 Gate 守住 | 同一注册表驱动模型工具清单与运行分派；未知工具失败；审批与 plan 回归测试 |
| 运行扩展 | `xueness/plugins.py` 已拆 skills/hooks/subagents/MCP 的激活/回收 | 明确插件接口版本、id/能力声明、加载失败的可观测错误；外部插件先不自动执行 | 默认关；MCP 子进程总回收；坏插件不增权；跨 CLI/Web 同一行为 |
| 前端 | `webapp/src/main.tsx` 用 ZCode `Root` + 大量惰性 stub；`xuenessBridge.ts` 接 Python API | 先抽自有 adapter/插件接缝，再逐块替换 UI 和协议投影；逐项移除假按钮和假能力 | 用真实 API 的任务输入→运行→审批→历史刷新闭环；断网/拒绝有可见错误 |
| 协议 | `xuenessSnapshot.ts` 投影 ZCode V4，`__zcodeSessionActivity` 等内部字段仍在 | 定义独立版本化的 Xueness wire schema + 转换器，旧协议只留在 legacy adapter | schema/兼容黄金测试；不得把 `ZCode Protocol` 简单替换而破坏消费者 || 品牌/许可 | 可见名称与图标已改；协议常量及代码标识仍保留 | 逐层迁出 `@zcode/*`，确认导入者后再删/改；记录每个派生包 | 前端 build + 全页浏览器无旧品牌；`NOTICE` 与实际打包内容一致 |
| 并发与隔离 | 会话级 busy 409，工作区路径围栏；`exec` 不是 OS 沙箱 | 在真正并行写入前设计同路径冲突和原子提交；沙箱单独威胁模型 | 两任务同路径可检测/拒绝或串行；命令不能绕过承诺的锁；网络和挂载受控 |

## 实施顺序

1. **第一批：真实的自有插件接缝**。不改变功能授权语义。Python 内建工具注册/分派与 Web 适配层解耦；测试 Gate 不变量。每批改动都保留旧入口兼容。
2. **第二批：自有会话/工具事件协议**。明确 JSON schema、版本、错误码、流式事件和恢复 cursor；服务端生成，前端 TypeScript 消费；不要把上游 V4 字段当真源。
   - ✅ 已完成（2026-09-27）。契约 `docs/xueness-event-protocol-v1.md`，黄金样例 `tools/protocol-v1-golden.json`。
   - 后端：`xueness/events.py`（derive_events / error_code / page_events / sse_body），新路由 `GET /api/sessions/{id}/events.v1`（JSON + SSE），legacy `/events` 原样保留。
   - 前端：`webapp/src/xuenessEvents.ts`（类型守卫 + 信封解析 + 本地分页对拍 + v1→legacy 降级投影），`tools/validate-events-v1.ts` + `webapp/run-validate-events.mjs`。
   - 验收：Python 592 OK（559 基线 + 33 新，另含前端 14 单测）；golden 逐字对拍全等；真实 HTTP JSON/SSE 端到端通过。
3. **第三批：原生工作台渐进替换**。任务列表、输入框、时间线、审批、文件/差异和设置逐项迁移；每个控件有实际往返，无占位承诺。ZCode 组件可以暂时留下有版权标注的隔离适配层。
   - 🚧 首片已完成（2026-09-27）。契约 `docs/xueness-workbench-contract.md`。
   - 数据层 `webapp/src/xuenessWorkbench.ts`（10 个导出 + `toTimelineRows`）+ 37 单测。
   - 视图层 `webapp/src/XuenessWorkbenchView.tsx`（TaskList/Timeline/Approvals/Composer/WorkbenchHeader）+ 7 SSR 测试。
   - 容器 `webapp/src/XuenessWorkbenchContainer.tsx` 接入 `main.tsx` 旁挂，ZCode 壳保留。
   - 验收：真实服务 + Playwright 闭环（新建→运行→v1 时间线→审批→重试→完成）0 页面错误。
   - 切片 2 已完成（2026-09-28）：契约 `docs/xueness-workbench-slice2.md`。文件浏览（`/files` + `/file`）、`DiffView`（journal 派生的会话记录改动，**明确标注非磁盘 diff**）、设置页（`agent` 能力开关 fail-closed）。数据层 `xuenessSettings.ts` + `xuenessWorkbench.ts` 新增 journal 派生；视图 `XuenessWorkbenchView2.tsx`（FileBrowser/DiffView/SettingsPanel）；容器加面板切换。真实 e2e 验证设置**真的落盘**。
   - 切片 3 已完成（2026-09-28）：**入口切换**。`main.tsx` 变为壳路由（默认原生）；新增 `App.tsx` 原生入口；旧 ZCode 壳整体移至 `webapp/src/legacy/ZcodeShell.tsx`，仅 `?shell=zcode` 时**动态加载**。
     - 验收：默认页 JS **1 个文件 / 270KB**（对照 `?shell=zcode` 的 **13 个 / 13.3MB**）；默认路径无任何 `@zcode/*` 真实 import；`?shell=zcode` 仍可达。
     - 仅剩两处 `@zcode` 依赖：`legacy/ZcodeShell.tsx`（隔离）与 `xuenessSnapshot.ts`（仅类型导入 `ConversationSnapshot`，待与 legacy 协议 adapter 一并处理）。
4. **第四批：可控插件 SDK 与隔离**。manifest/version/capabilities、显式启用、拒绝默认网络/命令权限、生命周期和卸载回滚。外部插件代码执行必须另行审计，不能把配置资源直接当可执行插件。
   - ✅ 已完成（2026-09-28）。契约 `docs/xueness-plugin-sdk.md`；模块 `xueness/plugin_sdk.py`（`validate_manifest` / `load_manifests` / `plan` / `install_all` / `uninstall`）。
   - 硬规则：`entrypoint`/`command` 一律拒（且**拒绝会阻塞它声称的 builtin**，不会绕开加载）；`enabled` 只认字面 `true`；`capabilities` 需 `grants` 显式授予；`load` 只含内置能力名（manifest 的 `id` 不是可请求别名）。
   - 接线：`web.py` 的 `POST /api/sessions/<id>/run`（新增 `grant_plugin_capability`，拒绝原因回在 `plugin_refused`）与 `cli.py`（新增 `--grant-plugin-capability`，拒绝打到 stderr）。
   - 验收：Python **638 OK**（592 基线 + 46 新）；真实 HTTP e2e 验证「无授予→拒、有授予→过、未启用→未触及」；前端 85 项与 golden 校验器零回归。
5. **第五批：多 Agent 协作和上下文/记忆**。任务 id、进度镜像、停止/恢复；工具级与命令级一致的写冲突约束；上下文压缩需要保留工具调用配对和用户原文，不先自动覆盖 journal。
   - ✅ 已完成（2026-09-28）。契约 `docs/xueness-batch5.md`。
   - `xueness/task_registry.py`：`task-<hex>` id、进度镜像（**只存元数据与截断摘要，不存提示原文**）、协作式取消（步边界检查，不撕开工具调用）。子运行 id 与子会话 id 分离，避免 `sub-` 泄露进父 journal。
   - `core.run` 新增 `should_stop` / `on_step` / `registry`；`stopped` 是可继续状态（再次 `run()` 即恢复）。新增 `POST /api/sessions/<id>/stop`（空闲会话如实回 `stopping: false`），run 响应带 `tasks` 镜像。
   - `xueness/write_lock.py`：按 **resolve 后的绝对路径**加锁，同一路径的所有写法（相对/绝对/软链）竞争同一把锁；`write`/`edit` 写入前取锁、`finally` 释放，冲突时不碰盘。明确：**仅进程内**，不覆盖另一进程或 agent 自己跑的 shell。
   - `core.compact` 修复：**保留全部 user 原文**（旧实现会静默丢弃后续用户轮次，已实证）、工具调用按整组裁剪不断配对、摘要归档且新增 `kept_user_turns`。
   - 验收：Python **674 OK**（638 基线 + 36 新）；前端 85 与 golden 校验器零回归；真实 HTTP 验证 stop 端点与 tasks 镜像；线上容器 healthy。

6. **第六批：剩余迁移 + 前端重构 + 后端 harness 改进**。
   - 🚧 进行中（2026-09-28）。契约 `docs/xueness-batch6.md`；调研与实施记录 `docs/xueness-harness-notes.md`。
   - 根因定位：原生前端**没有任何样式表**（101 处内联样式，Tailwind 已装未 import）。
   - ✅ **Lane B 工作区数据层（GLM 5.3-Flash）**：`webapp/src/xuenessWorkspace.ts`（目录/供应商/用量/记忆/设置）+ 20 测试全绿；零手拼 URL；正确判断后端目录条目无 `size` 字段而兜底 0 而非编造。
   - 🔄 **Lane A1 设计系统与视图重做**（gemini 3.8 flash high）、**Lane A2 新面板**（gemini 3.8 flash high）：已产出文件与自测（10/10、7/7、13/13、26/26），待集成。
   - ✅ **后端 harness 改进**（主模型并行完成，等待前端线期间）：
     - **分阶段压缩**：`compact` 先 mask 陈旧工具输出（**遮蔽前先归档原文**，标记诚实），遮蔽够用即早停；不够才丢弃+摘要。`compactions` 新增 `masked`。
     - **工具输出卸载**：超限输出写 `<root>/.xueness/artifacts/<id>.txt`，正文换「头+指针+尾」，可用现成 `read` 取回；**只读运行不写盘**（退化为截断）。
     - **护栏上锁**：`tests/test_harness_invariants.py` 断言每轮请求前跑过 compact、用户原文保留、工具配对、子代理隔离。
     - **草稿本约定**：系统提示加「长输出被缩短时会说明全文位置，需详情就 read 那个文件」与「跨轮工作写进 workspace 文件」。
     - 过程修掉 3 个真 bug（均已有测试）：无可丢弃消息时提前 return 导致单条超大输出击穿预算；遮蔽就地改写 journal 却未归档（数据丢失+谎报）；任务 id 复用子会话 id 泄露 `sub-`。
   - 验收：Python **687 OK**；前端 **143**（37+14+14+7+13+20+2+10+26）全绿。
   - ✅ 已完成（2026-09-28）。契约 `docs/xueness-batch5.md`。
   - `xueness/task_registry.py`：`task-<hex>` id、进度镜像（**只存元数据与截断摘要，不存提示原文**）、协作式取消（步边界检查，不撕开工具调用）。子运行 id 与子会话 id 分离，避免 `sub-` 泄露进父 journal。
   - `core.run` 新增 `should_stop` / `on_step` / `registry`；`stopped` 是可继续状态（再次 `run()` 即恢复）。新增 `POST /api/sessions/<id>/stop`（空闲会话如实回 `stopping: false`），run 响应带 `tasks` 镜像。
   - `xueness/write_lock.py`：按 **resolve 后的绝对路径**加锁，同一路径的所有写法（相对/绝对/软链）竞争同一把锁；`write`/`edit` 写入前取锁、`finally` 释放，冲突时不碰盘。明确：**仅进程内**，不覆盖另一进程或 agent 自己跑的 shell。
   - `core.compact` 修复：**保留全部 user 原文**（旧实现会静默丢弃后续用户轮次，已实证）、工具调用按整组裁剪不断配对、摘要归档且新增 `kept_user_turns`。
   - 验收：Python **674 OK**（638 基线 + 36 新）；前端 85 与 golden 校验器零回归；真实 HTTP 验证 stop 端点与 tasks 镜像；线上容器 healthy。

每阶段以测试、build、浏览器实际交互和线上 bundle 哈希共同验收。不因单项通过宣称全量 parity。默认不自动公开部署、不添加真实密钥、不执行第三方安装脚本。

## 第七批：应用级外壳与时间线视觉（2026-09-28 完成）

依据 `docs/xueness-ui-comparison.md`（实测：原生 1 JS/270KB vs ZCode 13 JS/13.3MB）。
目标：保留轻架构，补齐布局成熟度。

- **Lane S（gemini）**：`XuenessShell.tsx`（329 行）——`Shell` / `SidebarNav` /
  `TimelineCard` / `SimpleMarkdown`，+ 8 项测试。
- **Lane T（gemini）**：`XuenessTimeline.tsx`（174 行）——`TimelineStream` 卡片流，+ 5 项测试。
- **父代理集成**：容器改用 `Shell`（常驻侧栏 + 顶栏 + 状态栏）、时间线换 `TimelineStream`、
  ⌘N/⌘K 聚焦、CSS 补齐两条并行线的接缝（`.xn-shell-header` 等 31 个类名）。
- 修掉子代理留下的问题：测试里字面串编码损坏、正则依赖属性顺序、React 19 下
  `JSX.Element` 命名空间缺失（改 `React.JSX.Element`）。

### 验收
- Python **687 OK**；前端 **156 项全过**（新增 外壳 8 + 时间线 5）。
- 真实浏览器：常驻侧栏（17 任务项）、时间线 3 张卡片、状态栏、窄屏折叠开关、**0 页面错误**。
- 线上容器 healthy，产物对齐 `index-DgOeNzHo.js` / `index-CB2apdgt.css`。

### 后端 harness 改进（同期，主模型）
- **停滞检测**：连续 3 步相同工具调用 → `stalled` 收束，不再烧完剩余步数；
  **排除「等待人工审批」的重试**（那正是 UI 依赖的批准-重试模式），且不覆盖已记录结果。
  此项一度破坏 MCP 审批流（10 项测试红），已修复并回归。
- 详见 `docs/xueness-harness-notes.md`。

### 仍未做
- `RunControls` 与「切换到旧外壳」提示仍是旧内联样式，未接入设计系统。（第八批已解决：原生入口不再挂载 RunControls，旧壳入口进命令面板；RunControls 文件保留供 legacy 壳使用）
- `vendor/zcode/` 一个文件未删。

## 第八批：信息架构对齐 ZCode —— 聊天优先工作台（2026-09-28 完成）

用户目标重申：Xueness 要有 **ZCode 的功能与外观**，功能以类似 DeepSeek Harness 的插件形式组织。
本轮先解决最大观感差——「原生是标签页后台、ZCode 是聊天工作台」：

- **壳重做**（`XuenessShell.tsx`）：删除顶部品牌栏/状态栏，改「黑侧栏 + 主区」。
  侧栏 = 新建任务 ⌘N / 搜索 ⌘K 动作行 + 带状态图标的任务列表（悬浮重命名/删除）+ 品牌页脚。
- **聊天优先**（`XuenessWorkbenchContainer.tsx`）：无任务 = hero 空态（居中问候 + 输入卡，
  模式/供应商并入卡底，替换浮动 RunControls）；有任务 = 会话视图（头部切换器 + 时间线 + 停靠输入框）。
- **消息形态**（`XuenessTimeline.tsx` + `TimelineCard`）：user 右气泡 / assistant 素文 Markdown /
  tool 单行卡（错误码可见）/ 完成·提问专属卡。
- **次级面板**：八个平铺标签页收进会话头部切换器 + 侧栏底部齿轮，「‹ 返回会话」返回。
- **旧壳入口**：常驻提示浮层移除，「切换到旧外壳（对照基线）」进 ⌘K 命令面板（`main.tsx`）。
- 修掉测试暴露的问题：发送按钮断言不再耦合 React 属性顺序（沿用项目既有教训）。

### 验收
- Python **706 OK**；前端 **161 pass / 0 fail**；`npm run typecheck` 0 错；`vite build` 通过。
- 真实浏览器闭环：hero 即建即跑 → write 拒 → 批准重试 → COMPLETED；user 气泡、
  窄屏折叠、⌘K 开关、设置往返全部实测；截图见 `docs/screenshots/native-batch8-*.png`。
- 实录见 `docs/xueness-ui-comparison.md` §七。

### 仍未做
- 能力清单缺口未变：#1 归档/置顶/分组/搜索 UI、#3 @提及/斜杠面板、#6 真 Git diff、
  #5 Git 面板、#8 内容预览、#4 终端、#11/#19/#20/#18 界面化（harness 已有、只差 UI）。
- `vendor/zcode/` 一个文件未删。

## 第九批：harness 功能界面化 + 会话管理补全（2026-09-28 晚完成）

三条并行泳道（子代理 Lane A/C + 主线程 Lane B，并发配额一次一个子代理）+ 父代理集成。
核心发现：**第六批的 `/api/resources/*` CRUD 后端一直在，前端从未消费**——本轮补 UI 而非造后端。

- **Lane C（子代理）图片预览后端**：`core.workspace_image_preview`（png/jpg/jpeg/gif/webp
  白名单、2MB 上限、`path_in` 围栏软链逃逸实测被拒）+ web 路由图片分支（data URL）+ 5 测试。
- **Lane B（主线程）能力面板**：`xuenessCapabilities.ts` 数据层（list/toggle，复用
  `xuenessApi` 的 CSRF 传输）+ `XuenessCapabilitiesPanel`（六分区、每条目真启用开关，
  PATCH 只合并 `enabled`；无 handler 渲染静态徽章防假控件）+ 13 测试。
- **Lane A（子代理）会话管理补全**：`session_management.pin/list_archived/restore`
  （审计、符号链接拒绝）+ 三条 web 路由；前端 `pinSession/listArchivedSessions/restoreSession`、
  `XuenessRenameDialog`（替代 window.prompt）、SidebarNav 置顶分组。
- **父代理集成**：「能力」视图进会话头部切换器；侧栏搜索过滤框、「已归档」折叠区
  （↩ 恢复）；会话头部 📌 置顶切换；FileBrowser 渲染 `<img>`；`FilePreview.image?` 字段。

### 验收
- Python **767 OK**；前端 **181 pass**；typecheck 0 错；build 通过；线上容器 healthy。
- 真浏览器闭环：置顶→分组、重命名对话框→同步、删除→归档→恢复（置顶保留）、
  能力面板开关→服务端落库、图片预览→`<img>` 真解码。截图 `native-batch9-*.png`。
- 演示数据已清理；恢复顺序与置顶状态复原。

### 仍未做
- 能力面板只有读取+启用开关：创建/编辑/删除 UI 未做（API 已存在）。
- #1 仍缺分组/独立搜索页；#3 @提及/斜杠面板；#6/#5 真 Git diff/面板；#8 图片之外的内容预览；#4 终端。
- `vendor/zcode/` 一个文件未删。

## 第十批：能力 CRUD + 真 Git + 预览扩展 + composer 补全（2026-09-28 夜完成）

「全都做」批次，两条子代理泳道（能力 CRUD UI / Git 全栈）+ 主线程（预览扩展、composer、
面板、分组、快捷键表），父代理集成。用户要求：后端动的同时前端必须跟上——本批每项同步交付。

- **能力增删改**（Lane A 子代理）：`XuenessCapabilityDialog`（创建/编辑共用，ID 与后端同
  正则实时校验，编辑只提交变化键）+ 面板「新建/✎/🗑」；容器接线 PATCH/POST/DELETE 真往返。
- **Git 面板**（Lane B 子代理）：`xueness/git_api.py` 只读 status/diff/log（argv 无 shell、
  10s 超时、只读卫兵集成断言）+ `/api/sessions/<id>/git/*` + Dockerfile 装 git（apt 切
  TUNA）+ `XuenessGitView`。浏览器实测真 diff。
- **预览扩展**（主线程）：`BINARY_PREVIEW_SUFFIXES`（图片/PDF/音视频分型上限）+
  FileBrowser 四类渲染 + markdown 素文渲染。
- **composer 补全**（主线程）：`composerSuggestions`/`applySuggestion` 纯函数 +
  `/`命令与`@`文件建议下拉 + ↑↓/Tab/Esc；命令面板分类 fuzzy；侧栏按状态分组 pill；
  设置页快捷键绑定表。

### 验收
- Python **791 OK**；前端 **217 pass**；typecheck 0 错；build 通过；容器 healthy（git 2.47.3）。
- 浏览器闭环：能力创建→编辑→删除、Git 面板真 diff、md/PDF 预览、/ 与 @ 建议（Tab 接受）、
  分类面板、状态分组。截图 `native-batch10-*.png`。
- 过程：清 9.4GB 陈旧 build cache；apt 源切 TUNA 解决 deb.debian.org 不可达；修掉容器
  preview state 漏传 embed 的类型错误。

### 明确不做（决策）
- **浏览器终端（#4）**：绕过逐动作审批门控 = 绕过产品安全核心，需独立威胁模型，不做。
- **vendor/zcode 删除**：旧壳为对照基线，删除需独立决策。

### 仍未做
- 能力面板：MCP 连接测试、子代理运行记录视图；#1 分组拖拽排序/独立搜索页；
  #3 附件与富文本；#8 音视频已在白名单内但未实测真实媒体文件。

## 第十二批：agent CLI —— 实时步进流与多轮 chat（2026-09-29 完成）

Web 工作台之外，CLI 这条「本地 agent 体验」的主线补齐两块核心能力：

- **`core.run(on_event=...)`**：结构化实时事件回调（assistant / tool_call / tool_result /
  status 八个埋点），词汇表与 `session_events` 一致——CLI 渲染与 web 时间线同名同形。
  附加式设计：`on_step(steps)` 原样保留（任务镜像依赖它），观察者异常一律吞掉。
- **`run --stream`**：工具意图/结果/结算实时打到 stderr；stdout 摘要（text/json）逐字节不变，
  脚本管道不受影响。默认关，`--stream` 显式开。
- **`chat` 新命令**：多轮 REPL——输入即追加轮次（斜杠命令展开与 web 同一条 `expand` 路径）、
  步进实时流、写/改/执行逐动作 y/n 内联审批（Gate interactive，blanket 旗标仍优先）、
  待答问题自动把下一行作为回答（answer_session → paused → 继续跑）、`/exit` 或 EOF 结束。
  提示符全部走 stderr，stdout 只剩最终 JSON 摘要。
- 重构：`_add_agent_flags` / `_prepare_agent` 把 run 与 chat 的旗标与能力装配收进一条接缝
  （与 web 同源）；坏旗标组合仍在创建会话之前拒绝（不留孤儿会话）。

### 验收
- Python **799 OK**（新增 `tests/test_cli_stream_chat.py` 8 项：事件序列与配对、观察者异常
  不毁运行、on_step 契约不变、--stream 双通道、chat 单轮/空行/问答回路）。
- 真终端实测：`--stream` 轨迹、chat 内联审批（管道 y 批准写入并完成）、`/greet` 展开
  （`command_invocations` 落账 + 用户消息替换为展开文本）。

## 第十三批：agent CLI 收尾 —— resources 命令组 / show --timeline / stream-json（2026-09-29 完成）

- **`xueness resources`**：list/show/create/enable/disable/delete 六个子命令，直接复用
  `resources.dispatch`（与 web 同一条 jail/校验路径，零第二实现）；create 支持
  `--description/--event/--command/--body/--body-file(-=stdin)/--disable`；enable/disable 走
  PATCH 合并语义（只动 `enabled`，不会清掉 body/config）。错误走 stderr + 退出码 1。
- **`show --timeline`**：摘要在前、派生事件尾在后（与 web 时间线同词汇表）；
  纯 `show` 仍为纯 JSON。
- **`run --output-format stream-json`**：每个实时事件一行 JSON（stdout），最后一行
  `type=="summary"` 带 pending/completion；退出码契约不变（0 完成 / 2 其余）。
  程序化消费者从此可以不解析 stderr。

### 验收
- Python **807 OK**（新增 `tests/test_cli_resources_stream.py` 8 项：resources 全往返、
  非法 id 拒绝、argparse kind 白名单、body-file、timeline 渲染与纯 JSON、stream-json
  逐行合法 + summary 收尾 + 退出码）。
- 真终端实测三项（含 stream-json 9 行事件流）。
- 过程修复：show 误走 4 段 GET（API 无单条路由，改 list+过滤）；enable/disable 的
  PATCH 此前未带 `{"enabled": ...}` 载荷——测试先于 eyeball 抓到。

## 第十四批：CLI 与 web 操作面拉平（2026-09-29 完成）

`settings` / `settings-set` / `usage` / `memory-tracks` / `git` 五个命令接入与 web 完全相同的
stage-2 dispatch 函数（`settings_store`/`usage_api`/`memory_api`/`git_api`），CLI 回答与
web 回答从此不可能分叉：

- `xueness settings [section]`：全部或单节设置（JSON）。
- `xueness settings-set <section> <key> <value>`：value 先按 JSON 解析（true→布尔），
  回退字符串；POST 走 section 级读改写。
- `xueness usage --range 7d|30d|all`：本地 journal 的用量汇总。
- `xueness memory-tracks`：三条记忆轨道元数据（无 XUENESS_MEMORY_ROOT 时诚实空表）。
- `xueness git <id> status|diff|log`：只读 git（同 git_api 的 404 非 repo / 501 无 git 语义）。

统一约定：错误 → stderr `ERROR (<status>): ...` + 退出码 1；成功 → stdout JSON。
非 repo 的 git 会话退出码 1（git 沿目录树向上查找的语义在测试里专门用独立 temp 目录锁住）。

### 验收
- Python **813 OK**（新增 `tests/test_cli_surface.py` 6 项）。
- 真终端实测：settings-set 落盘、git status（?未跟踪条目）、usage totals、memory-tracks 空表。
- 至此 CLI 与 web 的操作面（会话/运行/审批/资源/设置/用量/记忆/git）全部拉平；
  交互式流与 SSE 属于各自形态的自然差异，不再逐项对照。

## 第十五批：CLI 日常入口与 ZCode 上游核对（2026-09-29）

按用户最新方向，先补自用 Agent CLI 的实际功能，功能验收后再拆插件。上游审查见
`docs/zcode-upstream-2026-09-29.md`：最新 main 为 `29628c9a`（v3.14.3，9 月 24 日），
与本地 vendor 基线分叉；未覆盖 vendor。

- `bin/xueness` 可从任意目录启动；无参数进入 chat，首个任务才创建会话。
- `chat [ID]`、`chat --continue --root DIR`；按工作区续接最近保存的未归档会话，保留 plan 模式。
- 本地 `/help`、`/status`、`/mode`、`/retry`、退出命令；自定义命令首轮展开与审计。
- 修复回答问题后没有自动运行、等待回答时退出被当作答案、审批提示污染 stdout 三处交互问题。
- chat 默认逐次审批，提供 `--non-interactive`；plan/deny list 仍优先。

验证：Python 全量 **824 项通过**；随后新增 launcher/未配置模型两项，CLI 定向 **35 项通过**；
文档更新后 packaging **10 项通过**。首次沙箱全量因无法监听回环端口而失败，放行本机测试后全量通过。
真实 PTY：首次任务 → y 审批 → write/read → completed → `/mode plan` → 退出 → `--continue`
恢复同一会话并保留 plan。未调用真实模型、未部署 Web。

仍未完成：完整 TUI、多行/附件、运行中中断恢复、工作流引擎及在线并发调整；下一步顺序已列在上游审查中。

## 第十六批：CLI Ctrl+C 协作式停止与恢复（2026-09-29）

- `cli_interrupt.RunInterrupt` 只在 CLI 运行期间接管 SIGINT；退出运行或异常时恢复原处理器与审批回调。chat 和单次 run 共享同一路径。
- 模型请求中收到 Ctrl+C：请求返回后停止，尚未记录的响应不会进入工具执行；请求失败且已请求停止时也正常保存 stopped。
- 工具调用组已开始：记录整个组的调用/结果后停止；包括恰好耗尽步数的最后一组。待答问题保留 awaiting_user，不被停止状态覆盖。
- 审批输入中 Ctrl+C：拒绝该次操作并请求停止；输入提示处 Ctrl+C 仍退出聊天。重复 Ctrl+C 不强杀。
- stopped 可 `/retry`，也可输入新方向；续接时不重放已记录成功的工具调用。单次 run 沿用未完成退出码 2，stream-json 仍合法。
- 既有墙钟预算仍按步骤边界停止，不改变其验收契约；取消不是磁盘事务回滚，也不是对进程树的硬取消。

验证：`tests/test_cli_interrupt.py` 新增 8 项真实 SIGINT 用例；CLI 定向 43 项通过。
真实 PTY 在审批提示按 Ctrl+C：write 被拒绝、文件未创建、状态 stopped、返回输入提示并正常退出。
全量 Python 回归：**834 项通过**（120.848 秒）；`git diff --check` 通过。未调用真实供应商或部署。

## 第十七批：CLI 多行输入与工作区文本附件（2026-09-29）

- `/paste` → `/end` 显式提交；`/cancel`、Ctrl+C 取消；EOF 不提交草稿。保留缩进、空行与字面斜杠命令，支持转义结束标记；超限后读到结束标记再拒绝，避免剩余粘贴文本落入命令/审批输入。
- `/attach PATH`、`/attachments`、`/detach N|all`；chat 与单次 run --prompt 支持重复 `--attach`。仅主动选取的工作区文件，不扫描或自动上传。
- UTF-8 普通文件快照：每文件 64 KiB/8000 字符，最多 4 个/16000 字符；拒绝软链越界、二进制、目录/FIFO，超限不截断。重复路径更新快照，队列变更失败保持原状。
- 首轮、后续输入与问题回答共享附件编码与 journal 审计，路径/字节数/SHA-256 按用户轮次留存；源文件之后修改不会改变已记录内容。作为非可信文件数据进入模型上下文。
- 待发队列仅在成功提交后清空，取消草稿不消耗；退出时未发队列不落盘。JSON 摘要与逐次审批契约保持。
- 尚不支持图像/PDF/Office 多模态解析。

验证：新增 `tests/test_cli_input.py` 13 项，CLI 定向 **56 项通过**；全量与终端验证结果见下。
全量 Python **847 项通过**（121.166 秒）；真实 PTY 完成「带空格路径附件 → 多行输入 → 审批 → 完成」，
直接核对 journal 的缩进、正文快照与附件审计，并确认发送后队列为空。`git diff --check` 通过。
收尾日期 2026-09-30；未调用真实模型、未部署 Web。下一步为 CLI 会话选择与管理。

## 第十八批：四项主线及扩展 Web（2026-09-30）

四项实现和实际使用方式统一记录在 [四项功能说明](xueness-four-workstreams.md)。新增 CLI session/provider 管理、按需 skill_read、HTTP MCP/诊断、后台命令、持久化 DAG/恢复/复用/并发，以及模型/工作流/子任务/PTY/Office/i18n 界面。保留 stdio、原有逐调用审批与插件接缝；本轮不提前进行插件拆分。

已实测浏览器语言切换不丢草稿、Office、PTY 和 DAG 执行日志；真实模型协议使用本机假服务验证配置选择，不使用付费密钥。完整 Office 排版、MCP OAuth/旧 SSE、Windows PTY 与 ZCode 全量对等不在本次声明内。

### 第十九批：当前上游复查与工作台美化（2026-09-30）

重新拉取只读 ZCode HEAD，仍为 `29628c9a`（9 月 24 日）。[本轮审查](zcode-feature-audit-2026-09-30.md) 重新过账旧 33 类清单，并列出 CLI TUI、多模态输入、模型流式响应/重试、模型工作流工具、可写 actor、自适应并发、MCP OAuth、Git checkpoint、Office 排版、cron 和完整插件生命周期等未完成子项；四项基础可用不代表这些子项全部完成。

美化原生工作流、模型配置与交互终端：统一标题/卡片/状态徽标，节点指标和进度、收起长计划、紧凑并发、按需日志、配置卡片加编辑表单、终端工具栏与空状态；二级页直接切换视图，侧栏图标与可访问名称，增加中英新文案和窄屏布局。保留实际操作与审批边界，不新增假数据或不可用产品动作。

验收：原生前端 219/219、类型检查、构建、两个 golden 协议校验及 diff 检查通过。浏览器验证审批/执行/日志/并发/修订复用、模型保存选择、真实 PTY、中英、390px 无整体横向溢出及侧栏开关，0 页面错误；本轮未修改 Python 服务逻辑，未重跑既有 867 项 Python 全量。截图与限制见本轮审查。

## 第二十批：插件拆分与审查缺口补齐

所有现有后端业务已迁入可信插件包；内核保留 Store/Gate/预算/journal/安全传输。CLI/API/工具/前端均遵守同一 effective 开关与依赖。新增流式模型、多模态/TUI、原生工作流/后台任务/自适应并发、Git/MCP/自动化/市场/诊断，并提供默认关闭的浏览器、SSH、渠道接入。完整清单、实际范围及验收见 [插件架构](xueness-plugin-architecture.md)。
