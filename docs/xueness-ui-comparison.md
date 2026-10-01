# Xueness 原生界面 vs 旧 ZCode 外壳（对比报告）

> 历史报告。当前参考是 ZCode v3.14.3（29628c9），旧外壳已退休；最新目标是保留 Xueness 品牌并对照原版前端。当前实现与尚未完成的差异见 [2026-10-01 对照记录](zcode-ui-parity-2026-10-01.md)，下述旧 bundle 尺寸与布局不代表最新构建。

日期：2026-09-28。早期对比是本机真实服务和浏览器实测；§六记录当天下午的新目标与新截图，历史测量不应误作最新构建数字。

## 一、结论先说

原生界面已经从「能用的骨架」变成「自己的产品界面」：
- 有完整设计系统（深浅色令牌、组件类），视觉不再靠 101 处内联样式硬撑。
- 默认页 8 个功能面板，覆盖了后端几乎所有接口。
- 默认加载 **1 个 JS（270KB）**，旧外壳是 **13 个 / 13.3MB**。

但**尚未追平 ZCode 的布局成熟度**：ZCode 是「侧栏 + 会话主区」的聊天式工作台，
原生目前是「顶栏 + 标签页 + 内容区」。信息架构不同，不是简单好坏。

## 二、实测数据

| 维度 | 原生（默认） | 旧 ZCode（`?shell=zcode`） |
|---|---|---|
| JS 文件数 | **1** | 13 |
| 总字节 | **270 KB** | 13.3 MB |
| 最大单块 | 270 KB | 8.9 MB（mermaid） |
| 页面错误 | **0** | 0 |
| 启用的样式表 | 自有 `styles.css` | ZCode 70KB Tailwind 体系 |
| 功能面板 | 8（时间线/文件/改动/目录/供应商/用量/记忆/设置） | 聊天 + 侧栏 |

## 三、布局与视觉差异（视觉模型转述 + 截图核对）

### 原生界面
- **结构**：顶部品牌栏（Xueness / 本地工作台）→ 新建任务输入 + 「新建并运行」→
  标签行（时间线/文件/改动/目录/供应商/用量/记忆/设置）→ 内容区。
- **配色**：深色为主，蓝/白点缀；视觉模型评价「简洁专业、间距适中、整齐有序」。
- **面板实测**（全部 0 错误）：
  - 时间线：任务列表 + 选中高亮 + 「未选择任务 / 暂无事件」空态。
  - 目录：显示绝对路径（`/private/tmp/xn-cmp7/runs`）、目录项、「新文件夹名称…」输入 + 「新建文件夹」按钮。
  - 用量：三个 Stat 卡片 + 按日序列 + 更新时间。
  - 设置：五个分区标签 + Agent 能力三个开关（允许 MCP / 允许子代理 / 允许 Hooks）+「保存配置」。
  - 文件/改动/供应商/记忆：均可访问，空态清晰。

### 旧 ZCode 外壳
- **结构**：左侧垂直侧栏（新建任务 / 搜索 / 自动化 / 分组 / 项目 / 任务列表）
  + 主区聊天（「夜深啦，别忘了照顾好自己哦」问候 + 输入框 + 「选择命令或能力」「添加上下文」）。
- **配色**：同为深色，白色/亮色文字与图标。
- **特征**：命令面板、⌘N / ⌘K 快捷键、工作区分组、`@` 上下文引用——**聊天式**交互。

## 四、第七批已补上（2026-09-28 本轮）

1. ✅ **持久侧栏**：新 `Shell` + `SidebarNav`，任务列表常驻左侧、选中项 `aria-current`。
2. ✅ **时间线卡片流**：`TimelineStream` + `TimelineCard`，user/assistant/tool/completion 各有形态。
3. ✅ **轻量 Markdown**：`SimpleMarkdown` 支持代码块/行内码/列表/粗体，手写无依赖、**文本转义防注入**。
4. ⏳ **浮动控件**：`RunControls` 与切换提示仍用旧内联样式，待下一轮统一。
5. ✅ **快捷键**：⌘N / ⌘K 聚焦新任务输入框。
6. ✅ **窄屏适配**：`max-width:900px` 侧栏折叠为可点击开关。

### 第七批实测（本机真实浏览器）

| 项 | 结果 |
|---|---|
| 常驻侧栏 | 存在，17 个任务项 |
| 时间线卡片 | 3 张（含 user/assistant/tool） |
| 状态栏 | 存在 |
| 窄屏折叠开关 | 存在且可点击 |
| 页面错误 | **0** |
| 前端测试 | **156 项全过**（新增 外壳 8 + 时间线 5） |
| Python | **687 OK** |

## 五、下一轮前端重点（已据此开线）

优先级从高到低：
1. **应用级外壳**：持久侧栏（任务列表 + 导航）+ 顶栏 + 状态栏，替换「顶栏+标签」。
2. **时间线视觉升级**：消息卡片化、工具调用卡（状态/耗时/错误码）、轻量 Markdown。
3. **浮动控件统一**：`RunControls` 与切换提示接入设计系统。
4. 快捷键（⌘N 新建、⌘K 聚焦搜索）。
5. 窄屏折叠。

## 五之二、前端类型检查验收口径（2026-09-28 追加）

**只看 `src`，不看 `vendor`。** 这是唯一有效的类型验收标准：

```bash
cd webapp
npx npm run typecheck     # 等价于 tsc --noEmit -p tsconfig.typecheck.json
```

- `tsconfig.typecheck.json` 继承 `tsconfig.json`，`include: ["src"]`，
  `exclude: ["src/legacy", "../vendor"]`。
- 该脚本必须 **0 错**才算过。当前实测：`0 error`。
- `src/legacy/` 是上游 ZCode 适配层，类型错不算本项目错；`vendor/zcode/` 自身
  约 2500+ 条 TS 错**不属于本项目、也不许去改 vendor**。

**为什么以前会看到一个 2581 的数字**：裸 `npx tsc --noEmit` 走 `tsconfig.json`，
它只有 `include: ["src"]`；而 `src/main.tsx` 曾用裸字面量 `await import("./legacy/ZcodeShell")`
把 legacy 及其 `@zcode/ui` 传递依赖拉进程序，于是 vendor 的 2580 条错也一起报出来
（2580 vendor + 1 src = 2581）。

现已双管齐下：

1. `src/xuenessSnapshot.ts` 本地化协议类型，去掉 src 里最后一条 `@zcode/*` 引用。
2. `src/main.tsx` 改用 `import.meta.glob("./legacy/ZcodeShell.tsx")` 惰性引用旧外壳——
   **Vite 仍在构建期静态打包**（旧外壳照常作为独立分块产出），但 tsc 只看到一层
   惰性导入映射，不再顺着 specifier 跟进 legacy/vendor。

结果：裸 `npx tsc --noEmit` 现在也是 **src 0 错 / 其余全在 ../vendor/**，
不再有「src 与 vendor 混在一起」的假象。

> **能力对照清单**：逐类对照 ZCode 与 Xueness 原生「有什么/缺什么/是否不适用」的完整清单，
> 见 `docs/xueness-parity-inventory.md`（33 类：已对齐 7 / 缺失 17 / 不适用 9）。那里是
> 「功能是否一模一样」能否验收的唯一依据。

## 六、2026-09-28 新目标：功能对齐 + 视觉接近 ZCode，原生零 `@zcode`/vendor 运行依赖

此前「把原生做成 ZCode 的样子是倒退」**已不再代表当前目标**。现在的双重验收目标是：

1. **能力对齐**：逐项按 `docs/xueness-parity-inventory.md` 盘点并验证实用能力，不把演示壳/假数据当作完成；尚未迁移的交互应明确标注。
2. **视觉接近**：参照真实旧壳截图，逼近深色中性灰背景、黑色侧栏、弱描边卡片、青蓝强调色、消息流与工具/审批形态；不是复制 vendor 组件或 CSS。
3. **依赖边界**：原生默认入口最终不得依赖 `@zcode/*` 或 `vendor/zcode/`（JS、CSS、类型、构建时引用都需要逐项证明消除）；旧 `?shell=zcode` 暂时保留，仅为对照基线，删除前需独立决策。现阶段仅完成**设计令牌层独立**，绝不声称整体能力或依赖目标已达成。当前项目构建仍会产出 vendor 惰性分块；过去「1 个 JS」指默认入口的历史网络观测，非无 vendor 构建依赖的证明。

### 实拍基线（本机 127.0.0.1:5174，Chrome headless，1440 × 900，接 8137 后端）

| 场景 | 证据 | 结果与局限 |
|---|---|---|
| 旧壳主屏 | [zcode-main.png](screenshots/zcode-main.png) | 真实 `?shell=zcode` 首屏、侧栏和输入区。 |
| 旧壳侧栏局部 | [zcode-sidebar.png](screenshots/zcode-sidebar.png) | 同一首屏裁剪，分组与会话列表可见。 |
| 旧壳会话消息 | [zcode-timeline-message.png](screenshots/zcode-timeline-message.png) | 点击已有会话 `delegate`，显示 user/assistant 消息。 |
| 旧壳工具卡 | [zcode-tool-card.png](screenshots/zcode-tool-card.png) | 点击已有 `live stop check`，能看到「写入 hello.txt／执行失败」。 |
| 旧壳设置 | [zcode-settings.png](screenshots/zcode-settings.png) | 点击左下角「设置」，可见多级导航与一般配置。 |
| 审批浮层 | **真正待批准弹窗未捕获**；[zcode-approval-overlay.png](screenshots/zcode-approval-overlay.png) 只是「变更前确认」模式菜单 | 真实点击 composer 模式入口取得菜单截图；已有会话虽出现 `needs_review`，旧壳却呈现为「已处理」。模式菜单**不是审批对话框**，不得拿它冒充审批流。 |
| 原生对照 | [native-comparison.png](screenshots/native-comparison.png) | 原生首屏，独立 CSS 令牌生效；不代表所有功能对齐。 |

截图中展示的旧壳控件可能部分只是离线适配层模拟，实际可用性必须逐项验证；已有样本会话数据也不是此轮新建的用户任务。审批浮层需要后续用**真实待批准事件**在旧壳复现，再补图。移动端/触屏未测。

## 七、第八批（2026-09-28 傍晚）：信息架构对齐 ZCode —— 聊天优先工作台

本轮解决「原生是标签页后台、ZCode 是聊天工作台」这个最大观感差。信息架构重排，不是换皮：

1. **壳**：删除顶部品牌栏与全局状态栏。布局改为「黑侧栏 + 主区」：侧栏顶部
   新建任务 ⌘N / 搜索 ⌘K 动作行，任务列表带状态图标（运行中脉冲 / 完成 ✓ / 失败 ✕ /
   待审 ?），悬浮显示重命名/删除；底部品牌 Xueness + 设置齿轮。
2. **聊天优先主区**：无任务时是 hero 空态（大字问候 + 居中输入卡 + 圆形发送钮，
   模式/供应商选择并入输入卡底部行，替换原浮动 RunControls 面板）；选中任务时是
   会话视图（头部：标题+状态+视图切换器+刷新/重命名/删除；时间线；底部停靠输入框）。
3. **时间线消息形态**：user 右对齐气泡、assistant 无边框素文（Markdown）、tool 单行卡
   （状态图标 + 工具名 + 等宽主题 + 徽章，错误码在展开行）、完成/提问为专属卡片。
4. **次级面板收进切换器**：文件/改动/目录/供应商/用量/记忆/设置从平铺标签页改为
   会话头部下拉切换 + 侧栏底部齿轮，「‹ 返回会话」返回。所有面板往返真实 API 不变。
5. **旧外壳提示**：常驻浮层通知移除；「切换到旧外壳（对照基线）」进 ⌘K 命令面板。

实拍（本机 1440×900，接 8137 后端，Chrome 内嵌浏览器）：

| 场景 | 证据 |
|---|---|
| 空态 hero | [native-batch8-hero.png](screenshots/native-batch8-hero.png) |
| 会话视图（工具卡/完成卡/停靠输入框） | [native-batch8-conversation.png](screenshots/native-batch8-conversation.png) |
| 窄屏折叠 + user 右气泡 | [native-batch8-narrow.png](screenshots/native-batch8-narrow.png) |
| ⌘K 命令面板（含旧外壳入口） | [native-batch8-palette.png](screenshots/native-batch8-palette.png) |

浏览器实测闭环：hero 输入→即建即跑→write 被拒→待审批卡→批准并重试→COMPLETED
（步数 4→5→6 递增）；续发消息 user 气泡右对齐；视图切换器到设置再返回；窄屏 640px
折叠开关可用；⌘K 开/Esc 关。全程 0 页面错误。

验收：`npm run typecheck` 0 错；`bun test src/` **161 pass / 0 fail**；`npx vite build`
通过；Python **706 OK**。已知自动化工具的 `fill`+`press` 连发会吞 Enter（点击聚焦后
正常，人工输入不受影响），已用事件监听实证非应用缺陷。

仍待对齐（按 `xueness-parity-inventory.md` 优先序）：#1 归档/置顶/分组/搜索框 UI、
#3 @提及与斜杠命令面板、#6 真 Git diff、#5 Git 面板、#8 内容预览、#4 终端、
#11/#19/#20/#18 的界面化。

## 八、第九批（2026-09-28 晚）：harness 功能界面化 + 会话管理补全

三条并行泳道（子代理 ×2 + 主线程）+ 父代理集成。核心发现：第六批已建好完整的
`/api/resources/{mcp,skills,commands,hooks,subagents,plugins}` CRUD，前端从未消费——
本轮把它变成 UI，同时补齐会话管理后端缺口。

1. **能力面板（#11/#19/#20/#18 的界面化，第一层）**：新「能力」视图（会话头部切换器进入），
   六个分区（MCP/技能/命令/Hooks/子代理/插件）列出真实配置条目；每条目一个真正的启用开关
   （PATCH `/api/resources/<kind>/<id>` 只合并 `enabled` 字段，实拍验证服务端落库）；
   空态诚实、错误可见；无 handler 时渲染静态徽章而非假开关。
2. **会话管理补全（#1）**：后端新增 `pin`/`list_archived`/`restore`（审计进
   `management_history`，符号链接拒绝，归档目录 jail）；路由 `POST /api/sessions/<id>/pin`、
   `GET /api/sessions/archived`、`POST /api/sessions/<id>/restore`。侧栏出现「已置顶」分组
   （📌 标记，归档/恢复往返后置顶保留）与「已归档」折叠区（↩ 恢复按钮）；
   重命名从 `window.prompt` 换成真对话框（自动聚焦全选、空值/未改动禁用确认、Enter/Esc）。
   会话头部新增置顶切换按钮。
3. **侧栏搜索**：过滤输入框（客户端按标题/任务名过滤）。
4. **图片预览（#8 起步）**：`workspace_image_preview`（png/jpg/jpeg/gif/webp 白名单、
   2MB 上限、复用 `path_in` 围栏，软链逃逸实测被拒）→ 文件面板渲染 `<img>`（data URL）。

实拍（本机 1440×900，接 8137 后端）：

| 场景 | 证据 |
|---|---|
| 置顶分组（侧栏） | [native-batch9-pinned-sidebar.png](screenshots/native-batch9-pinned-sidebar.png) |
| 重命名对话框 | [native-batch9-rename-dialog.png](screenshots/native-batch9-rename-dialog.png) |
| 图片预览 | [native-batch9-image-preview.png](screenshots/native-batch9-image-preview.png) |
| 能力面板 | [native-batch9-capabilities.png](screenshots/native-batch9-capabilities.png) |

浏览器实测闭环：📌 置顶 → 侧栏分组；重命名对话框 → 列表与详情同步；删除 → 归档区可见 →
↩ 恢复 → 回到活跃列表且置顶保留；能力面板开关 PATCH → 服务端 `enabled` 落库确认；
图片预览 `<img>` 实际解码渲染。演示数据已全部清理（演示资源删除、演示图移除、置顶复原）。

验收：Python **767 OK**；前端 **181 项全过**；`npm run typecheck` 0 错；`vite build` 通过；
线上容器 healthy。本轮泳道过程记录：并发配额一次只容一个子代理，Lane B 由主线程按同一契约实现。

### 本轮令牌提取与边界

只读参照 `vendor/zcode/packages/ui/src/styles.css` 中 `@theme` / `.dark` 颜色角色：暗色 `neutral-900` 主背景 `#171717`、`neutral-950` 侧栏 `#0a0a0a`、`neutral-800` 卡片 `#262626`、`sky-500` 品牌 `#0ea5e9`、白色 10% 边框与工具/assistant 语义色。令牌在自有 `webapp/src/styles/tokens.css` 独立定义，由自有 `webapp/src/styles.css` 引用；没有修改、复制或导入 vendor CSS。此阶段是**配色与基础表面**接近，不宣称像素级一致（间距、构图、字体、审批交互还需追平）。

本次验证：`cd webapp && npm run typecheck` 通过；`npm run build` 通过（vendor 惰性大分块警告）；`bun test src/` 通过 **160 pass / 0 fail**。直接 `node --test src/*.test.ts src/*.test.tsx` 不支持本项目的扩展名/无扩展名 TS 导入，不能作为测试失败结论。浏览器截图通过真实 Chrome 打开两条路由；初次浏览器请求撞上其它并行开发中的临时导出不匹配，重新加载后两条路由成功渲染。旧版 §二/§四的统计为历史数据，任何后续分块数或测试数变化以重新测量为准。

## 九、第十批（2026-09-28 夜）：能力 CRUD + 真 Git + 预览扩展 + composer 补全

「全都做」批次。三条线（子代理 ×2 + 主线程）+ 父代理集成，每项后端与前端同步交付：

1. **能力面板增删改**：六分区均可新建（ID 实时校验与后端同正则）、编辑（id 只读、
   只 PATCH 变化键）、删除（confirm）；hooks 的 event 枚举写入 placeholder。
   浏览器闭环：创建 demo-skill → 编辑描述 → 删除，全部真实往返。
2. **Git 面板 + 真 diff（#6/#5 第一层）**：后端 `git_api.py`（status/diff/log，
   argv 数组无 shell、10s 超时、`--no-optional-locks`、**只读卫兵有集成断言**——三轮命令
   前后仓库状态逐字节不变；git 缺失 501 / 非 repo 404 诚实空态）；Dockerfile 装 git
   （apt 源切 TUNA 镜像，deb.debian.org 在本网络不稳定）；前端 Git 视图（分支徽章、
   M/A/D/? 状态着色、真·工作树补丁、最近提交）。实拍：master + 2 变更 + 完整补丁 + 提交历史。
3. **预览扩展（#8）**：`workspace_binary_preview` 统一二进制白名单（图片 2MB /
   PDF 4MB / 音视频 8MB 各自上限、path_in 围栏不变）；文件面板按类型渲染
   `<img>`/`<embed>`/`<audio>`/`<video>`；markdown 以素文渲染（SimpleMarkdown）。
4. **composer 斜杠命令与 @ 文件提及（#3 第一层）**：`/name` 前缀出命令建议、
   `@frag` 出工作区文件建议；↑↓/Tab/Esc 键盘交互；后端的 `/name args` 展开早已存在
   （append_user_turn → commands.expand），本轮接上的是 UI。Tab 接受实测 `/de` → `/deploy `。
5. **命令面板升级（#29 第一层）**：命令/任务两组分类、子序列 fuzzy 排序、描述行；
   任务组带状态。
6. **分组（#1 第一层）**：侧栏「全部 / 按状态」pill，按状态分 进行中/已完成/其他 三组
   （带计数，ZCode 式分组头）。
7. **快捷键表（#13 第一层）**：设置页「快捷键」分区渲染当前真实绑定表（只读；
   冲突检测与自定义随绑定扩充再引入）。

实拍：`native-batch10-*.png`（Git 面板 / 分类面板 / 新建技能对话框 / 创建结果）。

验收（实跑）：Python **791 OK**；前端 **217 pass**；typecheck 0 错；`vite build` 通过；
线上容器 healthy 且内置 git 2.47.3。过程修复：容器 preview state 漏传 embed 字段
（typecheck 拦截后修复重部署）；Docker 构建清理 9.4GB 陈旧 build cache 后恢复正常。

### 明确不做（本批决策）
- **浏览器终端（#4）**：内嵌终端天然绕过「逐动作审批」这条产品安全契约——审批门控正是
  Xueness 的核心设计。要做需要独立的威胁模型（PTY 传输 + 免审批白名单或一次性授权），
  属单独决策，不是「还没来得及做」。
- **vendor/zcode 删除**：旧壳仍是对照基线，删除需独立决策（roadmap 既有约定）。

## 十、第十一批（2026-09-28 深夜）：视觉精修 —— 细线图标与质感对齐

对照 ZCode 原版截图逐项排差（用户反馈「和原版还是有很大差距」），根因是**图标语言与细节质感**，
不是布局（布局在第八批已对齐）。本批全部是观感修复，零功能变化：

1. **细线 SVG 图标库**（`ui/icons.tsx`，16 个手绘 path，stroke currentColor，无依赖）：
   替换全部 emoji/字符图标（⊕🔍⚙✎🗑⟳📍📌▲✓✕◌↑）。
2. **状态点**：任务列表状态从字符（✓✳?•）改为 ZCode 式彩色标记——运行中旋转弧线、
   完成绿勾、失败红叉、待审黄点、其余灰点。
3. **时段问候**：hero 从固定文案改为 ZCode 式时段问候（夜深了/早上好/中午好/下午好/晚上好
   + 接下来交给我吧），品牌句并入副行；纯函数 `heroGreeting` 导出可测。
4. **composer chips**：模式/供应商选择器改圆角 pill；新增 / 命令与 @ 上下文两个
   helper 按钮（与手动输入同路径插入触发符）；发送钮改圆形 SVG 上箭头。
5. **用户气泡头像**：右侧「你」圆头像（ZCode 消息形态）。
6. 会话头部操作图标、侧栏悬浮操作、次级视图返回钮全部换 SVG。

实拍：[native-batch11-hero.png](screenshots/native-batch11-hero.png)（空态：SVG 图标 + 彩色
状态点 + 时段问候 + chips 输入卡）、[native-batch11-conversation.png](screenshots/native-batch11-conversation.png)
（会话态：SVG 头部操作 + 头像气泡 + chips + 圆形发送）。

验收：前端 **217 pass**（1 条 📌 字符断言随图标化更新为 SVG 断言）、typecheck 0 错、
build 通过、8137 容器 healthy。零功能改动：所有 testid/aria/键盘行为不变。
