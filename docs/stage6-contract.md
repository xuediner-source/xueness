# Xueness Stage 6 契约：把 UI 到 API 的最后一段电线接完

前三段把后端能力接进了执行链路。本段补齐**用户界面到后端**的缺口——凡是设置页里
「能看见、点了没反应」的开关，都要真的生效。

## 缺口清单（已逐条核实）

| # | 缺口 | 现状 | 目标 |
|---|---|---|---|
| G1 | `commandsService.setCommandEnabled` | no-op | PATCH `resources/commands/<id>` `{enabled}` |
| G2 | `pluginManagementService.setPluginEnabled`、`pluginsService.setPluginEnabled` | no-op | PATCH `resources/plugins/<id>` `{enabled}`，**id 需归一化** |
| G3 | 运行时能力开关（MCP / 子智能体 / 钩子） | 后端已支持，**UI 无入口** | 设置页「常规」加三开关 |
| G4 | `POST /api/settings/<section>` 整节替换 + 前端只发变更键 | **数据丢失 bug** | 前端发前先合并已存值（已修，本段验证） |

### G2 为什么需要 id 归一化

上游有硬编码插件 id，例如
`OFFICIAL_BROWSER_USE_PLUGIN_ID = "browser-use@zcode-plugins-official"`。
后端资源 id 必须是 `^[A-Za-z0-9._-]{1,64}$`，`@` 非法 → PATCH 会 400。
开关层必须把 id 归一化后再发。

## G3 设计要点

- 三个键：`allowMcp` / `allowSubagents` / `allowHooks`（与 `xuenessBridge.readRunOptIns()` 一致）。
- 归属设置分区：**`agent`**（新增，已加入 `settings_store.SECTION_IDS` 与前端 `SECTION_OF_KEY`）。
  单独分区便于审计：它们会 spawn 子进程 / 嵌套模型调用。
- **默认全关**：读取失败一律当 false（fail closed）。
- 读取路径：`useSettings().settings`（前端 `settingService.get()` 已把全部分区扁平化合并）。
- 写入路径：`useSettings().update({allowMcp: true})` → `settingService.update` →
  `persistSettingsPatch` → 按 `SECTION_OF_KEY` 落到 `agent` 分区。
- UI 位置：`settingsPageHelpers.tsx` 的 `GeneralSectionContent` 末尾新增一个
  `SettingsGroupCard`，三个 `SettingsRow` + `Switch`。
  条件：`useOptionalServices()` 有服务时才渲染（与同文件既有写法一致）。

## 文件分工

| 子代理 | 允许改的文件 |
|---|---|
| A | `webapp/src/main.tsx`、`webapp/src/xuenessServices.ts` |
| B | `vendor/zcode/packages/ui/src/settingsPageHelpers.tsx`、`vendor/zcode/packages/ui/src/i18n/locales/zh-CN.ts`、`vendor/zcode/packages/ui/src/i18n/locales/en-US.ts` |

**主代理独占**：`webapp/src/xuenessBridge.ts`（已改）、`xueness/settings_store.py`（已改）、`tests/`。

## A 的任务细节

1. `xuenessServices.ts` 新增并导出：

```ts
/** 把上游插件 id（可能含 `@`）归一化成后端可接受的资源 id。 */
export function normalizeResourceId(raw: unknown): string | null
```

规则（与 `toHookResourceItem` / `toMcpResourceItem` 的 id 归一化逐字一致）：
- 非字符串 → `null`；`trim()` 后为空 → `null`。
- 把不在 `[A-Za-z0-9._-]` 的字符替换为 `-`。
- 截断到 64 字符。
- 结果为空、或等于 `.` / `..` → `null`。

2. `main.tsx`：
   - `commandsService.setCommandEnabled` 从 no-op 改为：
     取 `params.commandId`（或 `params.id`）→ `normalizeResourceId` → 非空则
     `await setResourceEnabled("commands", id, params.enabled)`。
     签名参照上游 `CommandSetEnabledParams`：`{commandId, filePath, enabled, agentSource?}`。
   - `pluginManagementService.setPluginEnabled` 与 `pluginsService.setPluginEnabled` 两处
     都改为：取 `params.pluginId` → `normalizeResourceId` → 非空则
     `await setResourceEnabled("plugins", id, params.enabled)`。
   - 用最小结构类型承接，**不要 `any`**。

## B 的任务细节

1. `settingsPageHelpers.tsx`：
   - 在 `GeneralSectionContent` 的 `return` 里，**最后一个 `</SettingsGroupCard>` 之后**、
     最外层 `</div>` 之前，插入一个新 `SettingsGroupCard`，含三个 `SettingsRow`：
     - 「启用 MCP 服务器」/ `settings.agent.allowMcp` + `.description`
     - 「启用子智能体」/ `settings.agent.allowSubagents` + `.description`
     - 「启用钩子」/ `settings.agent.allowHooks` + `.description`
   - 每个 `control` 是 `<Switch checked={...} onCheckedChange={...} />`。
   - 在组件顶部用 `const { settings: sharedSettings, update: updateSharedSettings } = useSettings();`
     读值与写值（`useSettings` 从 `@/hooks/useSettingService.js` 导入）。
     **该 hook 必须无条件调用**（React hooks 规则），不能放在 `hasServices` 分支里。
   - 追加到 `GeneralSectionContent` 的 props（可选布尔 + 可选回调），供宿主传入；
     缺省时回落到 `sharedSettings` 里的同名键。**保持向后兼容：新 props 都可选。**
   - `Switch` 已在文件顶部导入，直接用。

2. 两个 i18n 文件各加 6 个键（zh-CN 用中文，en-US 用英文）：
   `settings.agent.title`、`settings.agent.allowMcp`、`settings.agent.allowMcp.description`、
   `settings.agent.allowSubagents`、`settings.agent.allowSubagents.description`、
   `settings.agent.allowHooks`、`settings.agent.allowHooks.description`
   —— 放在 `settings.systemTitle` 附近，保持字母序不强制。
   描述要**如实说明代价**：MCP 会启动子进程；子智能体会嵌套运行模型；钩子会在工具调用前后执行命令。

## 验收（硬性）

### A
```sh
cd /path/to/xueness/webapp
npx tsc --noEmit --strict --target ESNext --lib DOM,DOM.Iterable,ESNext --module ESNext --moduleResolution Node --skipLibCheck src/main.tsx src/xuenessServices.ts 2>&1 | tail -20
```
应 exit=0。

### B
同上命令，把入口换成 `../vendor/zcode/packages/ui/src/settingsPageHelpers.tsx`
（注意该文件用 `@/` 别名与 `.js` 后缀导入，单文件 tsc 会报大量解析错误——**这不算失败**。
以 `vite build` 成功为准）：
```sh
cd /path/to/xueness/webapp && NODE_OPTIONS=--max-old-space-size=8192 npx vite build 2>&1 | tail -5
```
应 `built in`。

### 主代理（端到端）
1. 生产容器：`PUT /api/settings/agent` 三个开关 → 重新读取一致。
2. 生产容器：`readRunOptIns` 语义 —— 设置 `allowMcp=true` 后，run 请求确实会启动 MCP 客户端
   （用假 server 证明）；关掉后不启动。
3. G4 验证：连续写同一分区的不同键，先写的键**不丢失**。
4. 设置页扫描 13/13 分区无新报错。
