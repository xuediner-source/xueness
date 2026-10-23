# 扩展、配置与工具接口差异证据

## 范围与基线

- 最新 ZCode：3.16.2，HEAD `3c5b227649371507ddc4eb46ac5133afe6db1cab`，源码根目录 `E:/models/apps/_stage-z8/reference-ZCode-latest-20261024`。
- 旧基线 ZCode：v3.15.1，HEAD `aac4755666d09fdcd70272fcf063c077a639015f`，源码根目录 `E:/models/apps/session-comparison-20261012/sources/ZCode`。
- Xueness：0.2.1，源码根目录 `E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project`（该目录名沿用旧版本号；`desktop/package.json:3`、`ts/apps/server/package.json:3` 均为 0.2.1）。
- 最新相对旧基线的新增项按 `E:/models/apps/_stage-z8/engine-gap-audit-20261024/upstream-engine-delta.json` 与旧树核对。未涉及模型调度、workflow/memory、session 存储。账号、遥测和品牌绑定作为产品项排除。

## 行为差异

1. **【不同契约】项目配置与信任边界不同（既有差异）。** ZCode 的配置工厂按 system → project → user → env → CLI 合并 MCP server，同名 server 由较高层覆盖；project 配置直接进入有效配置。workspace hook declarations 单独走 digest admission。Xueness 的 workspace config 仅允许 plugins/mcp patch，并且只有 workspace root 与当前文件 digest 同时命中信任记录时才应用；hooks 字段从配置 patch 剥离，另走 hooks 信任机制。  
   ZCode：`adapters/src/config/config-factory.ts:239-248,372-397`；hook admission：`core/src/hooks/configured-runner.ts:74-86`、`core/src/hooks/workspace-hook-runtime-admission.ts:116-133`。  
   Xueness：`ts/plugins/settings/src/runtime-config.ts:9-18,173-202,217-260`，特别是 237-246。  
   基线：ZCode 配置层与 hook admission 在旧树已存在；本次索引没有将 config-factory 或 hook admission 文件列为变更。

2. **【架构/产品有意差异】MCP server 的连接时机不同（既有差异）。** ZCode 将 project MCP 视为默认可信，加入自动连接集合；untrusted project server 集合为空。Xueness 只有在 MCP 插件启用、请求带 allow_mcp 且 session 为本地时才为该次 run 装载服务器，run 结束后关闭插件；check 和资源/提示目录请求还需显式 connect/confirmed。  
   ZCode：`bootstrap/src/app/runtime-config.ts:94-116,158-161`；旧树同处 111-114 也有空的 untrusted 集合。  
   Xueness：`ts/apps/server/src/agent-service.ts:140-145,306-312`；`ts/plugins/mcp/src/mcp-ops-http.ts:123-141`。  
   基线：自动连接行为在 v3.15.1 已有；本次 MCP adapter 另有下文的 Apps 握手变化。

3. **【不同契约】Hook 的触发门不同，workspace hook 的 digest 信任两边都存在。** ZCode plugin hooks 并入 runtime hooks；有 plugin hook 时 merge 会强制 enabled=true，因此 plugin hook 不依赖每次请求的 allow_hooks。Xueness 将 legacy SessionStart/UserPromptSubmit/PreToolUse/PostToolUse 等入口按本次请求 allow_hooks 开关；其 pipeline 标记的工具后观察钩子可在 legacy 关闭时触发，但仍受 hooks feature 开关和 reached call 约束。Xueness workspace hook 也按 declaration digest 信任，不属于缺失能力。  
   ZCode：`bootstrap/src/app/runtime-config.ts:164-169,248-270`；生产传入点 `bootstrap/src/app/create-app.ts:239-286`；workspace admission `core/src/hooks/configured-runner.ts:74-86`。  
   Xueness：`ts/apps/server/src/agent-service.ts:260`；`ts/plugins/hooks/src/index.ts:140-169,171-203`；workspace digest admission `ts/plugins/hooks/src/trust.ts:92-105`。  
   基线：ZCode hook runner / admission 在 v3.15.1 已存在。

4. **【架构/产品有意差异】插件扩展边界不同；最新还补上 MCP 插件的 alwaysLoad 传递。** ZCode 启动时发现 plugin directories，将声明解析为 skills、commands、hooks 和 MCP server config，再注入 runtime；MCP loader 接受 stdio/http/sse，并将 alwaysLoad、enabled、timeoutMs 等通用字段复制进配置。Xueness 的扩展 marketplace 是数据 manifest：验证器拒绝 entrypoint/command，不导入外部代码；可执行插件来自 server 的显式 bundled registry。  
   ZCode：`bootstrap/src/app/startup-marks.ts:12-40`、`adapters/src/plugins/index.ts:151-210,284-286`、`adapters/src/plugins/mcp.ts:22-28,181-189`、生产注入点 `bootstrap/src/app/create-app.ts:285-286`。  
   Xueness：`ts/plugins/extensions/src/sdk.ts:2-6,59-64,117-126`；`ts/apps/server/src/bundled-plugins.ts:1-4,17-25,41`。  
   基线：插件发现和组件模型在 v3.15.1 已有；最新 delta 对 `adapters/src/plugins/mcp.ts` 的修改包含 line 187 的 alwaysLoad 字段透传。

5. **【实际功能缺口候选】技能与命令可从额外目录发现，这是最新新增行为。** ZCode 最新 resolver 接受 additionalDirectories，把目录 basename 作为 namespace；skill qualifiedName 和命令 namespace 保留来源目录，且生产启动/协议路径把 additionalDirectories 传到 runtime。Xueness discovery 只根据 session 的单一 workspace root 与 stateDir 枚举项目、兼容目录和用户目录，没有额外目录参数。  
   ZCode：`adapters/src/skills/roots.ts:13-16,56-65`、`adapters/src/skills/index.ts:65-66,224-227`；`adapters/src/commands/roots.ts:13-15,56-65`、`adapters/src/commands/index.ts:54-56,215`；生产传递 `bootstrap/src/app/runtime-config.ts:142`、`bootstrap/src/app/create-app.ts:862-864`、`bootstrap/src/custom-commands.ts:21,96`。
   Xueness：`ts/plugins/skills/src/discover.ts:34-43,117-123`；`ts/plugins/commands/src/file-commands.ts:68-79,150-153`。  
   基线：旧树对 skills/commands roots 与 runtime-config 的检索没有 additionalDirectories/namespace；delta 将这些 resolver/runtime 文件列为本次修改。

6. **【当前核对范围内确认未发现对应实现】MCP Apps UI 握手不同；等待连接的 adapter API 是最新新增。** ZCode MCP initialize 声明 Apps client capabilities，并在 MCP port、session facade 和 UI protocol 间暴露 app connection snapshot/wait、工具可见性和 app-provided tools；3.16.2 新增 waitForAppConnection，等待 server 初始化后还重新核验 lease 与连接代次。对 Xueness 的整个 `ts/plugins/mcp/**`、`webapp/src/plugins/mcp/**` 及宿主注册进行检索后，未发现 appConnection/waitForAppConnection、`ui://` resource 或 MCP Apps UI host。Xueness 确有 MCP elicitation 表单 UI 与 resources/prompts 管理面板，但它们不承载 MCP Apps UI resource。  
   ZCode：`adapters/src/mcp/index.ts:1540-1541,2198-2206`；`adapters/src/mcp/pool.ts:349-365`；`bootstrap/src/app/session-facade.ts:464-470,521-529`；UI 调用 `bootstrap/src/zcode-protocol/mcp-ui/protocol.ts:223-224`。  
   Xueness：`ts/plugins/mcp/src/mcp-ops-http.ts:73-87,105-113,123-141`、宿主 routes `ts/apps/server/src/application-api.ts:170-172`；MCP 管理/elicitation UI `webapp/src/plugins/mcp/index.tsx:81-150`、`ElicitationForm.tsx:411-568`、`elicitationSubscription.ts:44`。这些 UI 是 resources/prompts 管理与 elicitation，不是 MCP Apps resource host。
   基线：旧树未包含 waitForAppConnection API；该 adapter/pool 握手为最新新增。MCP Apps 总体能力并非本次才加入，新增点是连接等待与 lease 校验。

7. **【浏览器为不同契约；OS CUA 在核对范围内确认未发现等效接口】浏览器自动化与 OS CUA 接口不同（既有差异）。** ZCode 在启用 browser-use runtime 时把 BrowsersFacade 注入持久 Node REPL 的 agent.browsers，模型可通过 JS 调用浏览器对象 API；另有 ComputerUseRuntime 挂载为 agent.computerUse，支持 app/window 级操作。Xueness 暴露六个固定 browser_* 工具（navigate/inspect/snapshot/click/fill/screenshot），每次对确切 action 做审批，worker 不执行模型提供的 JavaScript；其 native_ops 工具清单仅含工作区文件、工具发现和文档读取。在 `ts/plugins/browser/**`、`ts/plugins/native_ops/**` 及 host agent 注册中未发现 ComputerUse、agent.computerUse、listApps/getApp/getAXState 或 OS UI automation 节点。desktop bundle 有宿主插件注册，但核对的 agent-facing runtime 不将其作为 ComputerUse extension；网页浏览与 desktop host 功能均不等同于 OS 级 CUA。  
   ZCode：`core/src/tool/handlers/node-repl.ts:15-20,311-315`、`core/src/browser-client/index.ts:47-61`；CUA runtime 注入 `node-repl-host/src/server.ts:318-328`，SDK `zcode-cua-plugin/scripts/computer-use-client.mjs:1174-1178`。  
   Xueness：网页工具 `ts/plugins/browser/manifest.json:2-12`、`ts/plugins/browser/src/tools.ts:1-5,15,91-105`；native_ops 工具清单 `ts/plugins/native_ops/src/types.ts:1-12`、`manifest.json:16-32`；宿主 registry/agent wire `ts/apps/server/src/bundled-plugins.ts:17,23,30,38-41`、`agent-service.ts:245-266`。  
   基线：ZCode 的 browser facade / REPL 路径在 v3.15.1 已存在。

8. **【不同契约；搜索能力已存在】WebSearch 的执行接口不同（既有差异）。** ZCode 的逻辑工具 WebSearch 映射到 provider-native web_search，只在当前模型声明支持 native search 时向真实请求暴露。Xueness 提供 web_search/image_search 和 web_fetch，搜索由显式配置的公共服务端点或另配的 search model 执行，并要求网络工具审批。  
   ZCode：`contracts/src/tools/websearch.ts:116-131`、`core/src/runtime/methods/config.ts:149,289-293`、`core/src/tool/handlers/websearch.ts:71-73,162-166`。  
   Xueness：`ts/plugins/network/src/tools.ts:22-25,88-96`、`ts/plugins/network/src/services.ts:48-59,99-102`。  
   基线：provider-native WebSearch 在旧树已存在（`contracts/src/tools/websearch.ts:116`）；latest delta 的相关改动不构成新的搜索执行模式。

## 等效能力与限定范围复核

版本复核：旧目录名含 `0.1.8`，实际 `desktop/package.json:3`、`ts/apps/server/package.json:3` 与 `ts/dist/package.json:4` 都声明 0.2.1；当前树中不存在 `ts/desktop/package.json`，本文件按实际包版本更正。

MCP Apps/CUA 范围复核：对 `ts/plugins/mcp/**`、`webapp/src/plugins/mcp/**`、`ts/plugins/browser/**`、`ts/plugins/native_ops/**` 全部实现文件（排除 tests/specs、dist、node_modules），以及宿主注册文件 `ts/apps/server/src/{bundled-plugins.ts,agent-service.ts,application-api.ts,agent-subagents.ts,mcp-servers.ts}` 和 `ts/packages/kernel/src/plugin-host.ts`，执行了 `rg --no-ignore -i --max-columns 240` 检索。MCP Apps 词项为 appConnection、waitForAppConnection、`ui://`、openai/widget、`_meta.*ui`、text/html、iframe、resource/ui、McpApp、MCP Apps UI；CUA 词项为 ComputerUse、computerUse、computer_use/computer-use、listApps、getApp、getAXState、list_windows、agent.computer。指定插件实现目录没有 Apps/UI/CUA 匹配项；宿主命中仅为 MCP runtime/resources/elicitation API、browser handoff、nativeOps 注册，以及不相关的 resource_subscriptions 和 browser 网络 sandbox 注释，没有 app connection 或 ComputerUse 注册。

等效实现核对：`webapp/src/plugins/mcp/index.tsx:81-150` 提供 MCP server、resources/prompts 管理；`webapp/src/plugins/mcp/ElicitationForm.tsx:411-568` 与 `elicitationSubscription.ts:44` 提供 MCP elicitation 表单/等待提交，这是有效 MCP UI 能力，但不是 `ui://` MCP Apps resource host。`ts/plugins/browser/src/tools.ts:15` 是六个网页操作；`ts/plugins/native_ops/src/types.ts:1-12` 与 `ts/plugins/native_ops/manifest.json:16-32` 是文件、发现和文档工具；没有等效 OS CUA 节点。Xueness 仍具备 MCP tool discovery、resources/prompts、网页浏览、web_fetch 与 web_search，这些不算缺失。本次没有发现需要单列的纯 refactor 项。上面列出的旧基线能力都用旧树源码直接确认；“最新新增”仅标记 delta 与旧树差异能支持的行为。没有从旧路线图推断缺失。

