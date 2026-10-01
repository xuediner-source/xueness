# 品牌剥离记录

日期：2026-09-26
范围：用户可见的上游品牌（ZCode / Z.AI / 智谱 / BigModel）+ 应用标志。
原则：**能改名的改名，没必要的删掉。** 但有些东西改了会坏，这些明确保留并记录理由。

## 结果

| 指标 | 剥离前 | 剥离后 |
|---|---|---|
| bundle 中 `ZCode` | 285 | 82（全为协议常量/匹配串） |
| bundle 中 `Z.ai` | 38 | **0** |
| bundle 中 `智谱` | 3 | **0** |
| bundle 中 `BigModel` | 37 | 4（API 字段 + 匹配串） |
| bundle 中 `Xueness` | 200 | 219 |

浏览器逐页扫描（主界面 + 设置页 6 个分区）：**全部无上游品牌显示**。

## 一、改名（用户可见文案）

### i18n 两套语言文件

`i18n/locales/zh-CN.ts`、`en-US.ts`：替换 112 + 113 处。**只改 value，不动 key**
（key 被代码引用，改名会全线崩）。验证方式：`key 含 Xueness 的行 = 0`。

映射：
```
ZCode Agent  → Xueness Agent
ZCode        → Xueness
Z.ai         → 云端模型服务
BigModel     → 团队模型服务
智谱          → 内置模型
```

### 组件内硬编码标签

`alt="ZCode"` / `aria-label="ZCode"`（5 处）、feedback 标签常量、窗口标题
`ZCode / <path>`、侧边栏用户名回退、托盘提示、插件显示名缩写表、composer 与
用量面板的套餐标签 —— 共 20 余处。

### 第二 i18n 源

`lib/builtinSkillI18n.ts` 有独立的 `"zh-CN"/"en-US"` 内联对象（技能描述），
替换 6 处。

## 二、应用标志（商标问题，不只是文案）

**这是本次最重要的一处。** 上游把自己的 **Z.ai「Z」标志**当作应用图标：
`App.tsx`、`WorkspaceSidebarCollapsedRail.tsx`、`WindowsTopLeftLogo.tsx` 三处
`import appLogoUrl from ".../logo-zai.svg"`。

把别人的商标当自己的应用标志，是商标问题。已新建 `logo-xueness.svg`
（自有几何图形，非上游资产）并替换这三处引用。

**保留**：`lib/oauthProviderIcon.tsx` 仍用 `logo-zai.svg` —— 那是**标识 Z.ai
这个服务**，属于正当使用，不是冒充。

## 三、删除

| 项 | 数量 | 理由 |
|---|---|---|
| `webapp/src/main.other-session-minimal.bak.tsx` | 1 | 旧版本备份，无引用 |
| `webapp/src/main.verified-fix.tsx` | 1 | 同上 |
| `.ui-*.png` / `.test-*.png` 截图 | 33 | 开发过程残留，约 2MB |
| `vendor/zcode/packages/web` | 21 文件 | 未被 vite 别名引用（Xueness 不用其 Web 认证/分享/远程链路） |

全部经 `trash`（可恢复），非 `rm`。

## 四、明确保留（改了会坏）

| 保留项 | 理由 |
|---|---|
| `ZCODE_PROTOCOL_NAME = "ZCode Protocol"` | 参与 `z.literal` 线级校验，改了断协议 |
| `version: "ZCode Protocol/1"` | 同上，握手字段 |
| `family: "Z.ai" \| "BigModel"`（services） | **发往服务端的 API 请求字段**，非展示文案 |
| `.includes("ZCode agent transport closed")` 等 | 匹配**外部**错误文本，改了匹配失效 |
| `.includes("BigModel 账号未注册")` | 同上 |
| `useZCodeIntl` / `ZCodeTaskMeta` 等 1000+ 标识符 | 上游内部 API 名，改了全线编译失败 |
| `paths.ts` 的 `Program Files/ZCode` | Windows 安装路径探测 |
| `appCaCert.ts` 的 `organizationName` | 证书字段 |

## 五、合规文件

剥离过程中发现：**顶层没有 `LICENSE` / `NOTICE`**，而 `dist` 进了 Docker 镜像
（等于分发）。Apache-2.0 的两条义务（保留声明、标注改动文件）都没落地。
README 第 3 行还写着「not a fork」——对后端成立，对 UI 层不成立，前后矛盾。

已补：

- `LICENSE`：上游 Apache-2.0 全文
- `NOTICE.md`：重写。原文是本地草稿（863 字节，误称复制了已删除的 `packages/web`，
  漏了 services/provider/rpc）。新文含 pin 提交、实际取用包表、四类改动说明、商标声明
- `README.md`：第 3 行改为「后端独立实现 + UI 层为 Apache-2.0 衍生」；
  第 90 行指向根目录合规文件

## 六、`.gitignore`

一度把 `vendor/` 加入忽略，**随即撤回**：界面依赖它构建，忽略会导致克隆后
无法构建。改为在文件里写明「必须保留」及将来排除的前提条件。

## 七、未验证 / 遗留

- **`vendor/zcode/NOTICE.md`（863 字节的旧草稿）仍在原处**。它是上游分发内容的
  一部分，我改了顶层 `NOTICE.md` 但没动它——删不删取决于是否保留 vendor 的
  完整性，建议保留但内容以顶层为准。
- **`.brand-backup/` 保留了 11 个原始文件**，用于回滚。确认无误后可删。
- 品牌剥离**只覆盖到浏览器能渲染到的界面**。桌面端专属路径（CUA 权限面板、
  Windows 托盘等）在 Xueness 中不可达，未逐条核查。

## 八、本地壳的登录墙与运行时错误（2026-09-27 补）

品牌剥离后实际打开本地壳，发现三个问题，根源相同：**本地壳没有上游账号体系，
却沿用了上游的登录/账号 UI**。

1. **`e.session` 错误边界**：`zcodeSessionService.readSession` 走惰性代理 stub，
   返回 `undefined` 被上游直接解构成 `.session`。改为真实实现：查到会话返回完整形状，
   查不到抛 `sessionNotFound`，让上层走正常的「无此会话」路径。
2. **登录墙（Z.ai / BigModel / API Key）**：上游把「无可用模型」当「需要登录」并强制
   弹 WelcomeScreen。新增 `skipProviderLogin` prop，**只由本地壳显式开启**，
   不动上游默认行为（桌面端与其它入口不受影响）。侧栏「连接使用」入口与账号徽标一并去掉。
3. **欢迎页的上游「Z」图标**：同一处商标问题，之前漏了 `ZCodeAboutLogo`。

## 九、静态资源 404

- `/favicon.ico`：`index.html` 并未引用，是浏览器隐式请求。已生成 Xueness 图标
  （`webapp/public/`：favicon.ico / apple-touch-icon.png / icon_512@2x.png），
  并在 `index.html` 补 `<link rel="icon">`。
- `UpdateStatusDialog.tsx` 的 `new URL("../../../public/icon_512@2x.png", import.meta.url)`
  是**悬空引用**：相对路径构建期解析不了，vite 只警告。改为根 URL `/icon_512@2x.png`。
- 后端 `web.py` 新增 `_ROOT_STATIC_FILES` **白名单**路由（不是目录服务），
  否则文件进了 dist 根也照样 404。
- 验证：CDP 抓全部失败请求 = 0；506 项测试 OK（新增 2 项覆盖该路由与越权路径）。

## 十、「自动化」页崩溃（2026-09-27 修）

**症状**：点侧栏「自动化」→ 区域错误边界 `Cannot read properties of undefined (reading 'length')`。

**定位过程（含一次错误判断）**：先读源码认为是 `automations`（store 从
`agentService.listAllAutomations()` 取值）为 `undefined`，补了 stub 但**没修好**。
插桩打印真实值后才确认：`automations` 是正常数组，真凶是 **`offPeakTasks`**。

**根因**：`offPeakTaskService` 与 `clientScenesService` **都不在 stub 表里**，落进惰性代理。
代理的 `.catch()` 是**空操作**——它返回的不是真 Promise，所以
`offPeakTaskService.list().catch(() => [])` 的兜底**从不执行**，`tasks` 被写成 `undefined`，
`offPeakTasks.length` 即崩。

**修法**：显式实现 `offPeakTaskService`（list/get/getCodingPlanSupport/
getTakeNumberAvailability/CRUD）与 `clientScenesService.list()`，并补
`codingPlanSubscriptionService.getOffPeakClientConfig()`，全部按上游类型给出形状；
注册进 `stubServices`。

**验证**：本地构建后浏览器点「自动化」正常渲染（修复前必崩）；部署后线上复核
`自动化/分组/项目/管理模型` 均不崩，失败请求 0、控制台错误 0；506 项测试 OK。

## 十一、「打开文件夹」不可用（2026-09-27 修，照 DSH 方案）

**症状**：新建任务里点「打开文件夹」没有任何反应。

**根因（三层）**：
1. `webapp/src/main.tsx` 给 `Root` 传了 `supportsSettings={false}` 且未开
   `preferDirectoryBrowser`，入口被短路成幂等的「确保对话 workspace 存在」。
2. 这是浏览器壳，系统原生文件夹对话框要走 Electron IPC；`platform.selectDirectory()`
   被写死成 `Promise.resolve(null)`，永远返回「用户取消」。
3. 上游预留的 Web 替代路径（服务端目录浏览器）两个数据源都是空壳：
   `systemService.info()` 返回写死的 `/root`，`fileService.readdir()` 返回空数组。

**方案（照搬 DeepSeek Harness）**：DSH 把选目录拆成 seam，两种实现——
`directory-picker-native`（宿主屏幕原生框，仅回环+非 SSH+有显示会话时可用）与
`directory-picker-browse`（Host 只给「列一级目录 / 建子目录」两个原语，应用内渲染浏览器，
宿主屏幕不渲染任何东西，故远程/容器客户端也能用）；`auto` 启动探测一次，不满足原生条件
一律落 browse。Xueness 是容器 Web 壳，按此判定走 browse。

**落地**：
- 新增 `xueness/directory_api.py`：`GET /api/system`、`GET /api/directory`、
  `POST /api/directory`。语义对齐 DSH：只返回目录、name-sorted、`hidden` 标记、
  绝对路径、层级上限+`truncated`、流式扫描+有界有序窗口（内存 O(上限)）、
  完全限定路径才接受、建目录非递归且只接受单一段、封闭错误码。
- 两个围栏而非一个：**列目录**可在 list roots，**建目录**只在 create roots
  （browse root + 声明的 workspace roots），不让选择器在服务端状态旁造目录。
- `build_context` 新增 `list_roots` / `create_roots` / `workspace_roots`；
  后者同时喂给 `_allowed_root`，因此「浏览得到」与「能建任务」不会漂移。
- 前端：`preferDirectoryBrowser={true}`；`systemService.info()` 从真实宿主 home 取；
  `fileService.readdir()` 映射宿主原语为 `FileEntry`；选中路径经
  `sendConversationCommandV4` 作为会话 root 下发。
- `compose.yaml`：挂载 `${XUENESS_HOST_WORKSPACE:-./.host-workspace}:/host-workspace`
  并声明 `XUENESS_WORKSPACE_ROOTS=/host-workspace`。默认挂空目录，指向自己项目用：
  `XUENESS_HOST_WORKSPACE=/path/to/projects docker compose up -d --build`。

**验证**：535 项测试 OK（新增 9 项覆盖列表/隐藏/截断/段校验/围栏/CSRF/面包屑/声明根）；
线上浏览器点「打开文件夹」→ 出现「浏览文件夹」对话框、列出挂载目录真实内容、无报错；
`/host-workspace/live-demo` 作为 root 建任务成功，未声明的 `/path/to/home` 被 400 拒绝。

## 十二、文件树与图标资源（2026-09-27 续修）

「打开文件夹」接通后，继续把工作区文件树这条路径补齐，暴露出三个问题：

1. **`readdir` 被我上一轮改窄了。** 目录选择器与工作区文件树**共用**
   `fileService.readdir`；上一轮为对齐 DSH 的 browse 语义把它改成只返回目录。
   选择器自己会过滤，所以没暴露；文件树则文件全部消失。改为宿主端点支持
   `includeFiles` 开关（默认关=选择器语义），文件树显式打开；前端按 `type` 如实映射。
2. **默认工作区写死在容器里不存在。** `LOCAL_WORKSPACE_PATH = "/workspace"` 是占位符，
   容器里没有该目录也不在许可根内，文件树一打开就 400。改为启动时先取一次
   `/api/system` 锚点，再渲染 `Root`，并同步 `recentProjects` / `cwd`。
3. **文件类型图标缺失。** UI 从 `/material-icons/<name>.svg` 取图标，但
   `webapp/public/` 只有 3 个根图标，上游有 1146 个。新增
   `tools/fetch-material-icons.sh`（按 NOTICE 的固定 SHA 拉取，仅资产、无代码），
   并在 `web.py` 加**单段名 + `.svg`** 的严格路由（拒绝遍历/非 svg/嵌套）。

顺带补 `gitService.getIgnoredPaths` 显式实现——惰性代理会让 `.then` 收到 `undefined`，
下游对 `undefined` 调 `.map` 抛错（又被 `.catch` 降级成日志噪音）。

**验证**：539 项测试 OK（新增图标路由用例含遍历/非 svg/嵌套拒绝）；
线上浏览器复核：文件树同时显示目录 `proj-x` 与文件 `readme.txt`、失败请求 0、
控制台错误 0；目录选择器范围内只显示目录、不含文件。

## 十三、任务运行选项与真实供应商失败恢复（2026-09-27）

首页增加当前页面的运行选项：`fake/build` 默认，显式选择 `plan` 或 `real`；
`createSession` 与 `sendText` 共享这个值，并依旧受服务端 `allow_real` 和环境变量
约束。浏览器不输入/存储模型密钥，失败通过 `xueness-run-error` 显示，不把拒绝说成成功。
后端修复真实供应商初始化 ValueError 后 `ctx["running"]` 未清除的问题：原来会话会被
永久标记运行中（后续均 409），现在先释放 busy 状态；新增隔离测试模拟未配置模型后
同一会话仍可运行 Fake Provider。前端构建 OK；Python 542 tests OK；容器健康，线上
bundle 与 dist 均为 `index-CL2QkquP.js`；无头浏览器看到默认 build/fake、切换
plan/real 生效且没有 pageerror。真实供应商外网/密钥链未做 live 验证。
