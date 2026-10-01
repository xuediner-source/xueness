# Xueness 目标架构：DSH 插件宿主 + ZCode 工作台

2026-09-25。状态：设计边界已澄清；**没有安装为 DSH 插件，也没有打通完整原生会话**。

## 用户确定的产品边界

- DeepSeek Harness（DSH）是插件宿主、agent/runtime 内核。现有 DSH 插件可继续提供模型路由、记忆、压缩、验证等能力。
- ZCode 已完成的 Web 工作台是 UI 与交互源，**先保留其布局、信息架构、交互、组件与美术**；之后再统一改版。不再把 Python Xueness 右侧「本地任务」抽屉当成目标产品。
- Xueness 是组合产品的名称，而不是把 Python 原型伪装成 DSH 或宣称 ZCode 功能已经可用。必要的协议桥接应落在 DSH 插件的 server/client 适配层，不要求 DSH 核心直接替换成 ZCode 后端，也不能靠返回空值的惰性 stub 冒充完整实现。

## 已核验的本地事实

- `vendor/zcode/` 保存上游 UI 等源，`NOTICE.md` 将来源固定为 `zai-org/ZCode@328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`，Apache-2.0 `LICENSE` 与版权归属在目录内。当前 `webapp/src/main.tsx` 启动上游 `Root`，但服务大多是浏览器内 stub；当前 `webapp/src/XuenessTasks.tsx` 右侧另造任务抽屉，不能充当原生工作台功能等价实现。
- `webapp/src/xuenessBridge.ts` 的 `createSession`/`sendText` 目前转入 Python `/api/sessions`，并**自动运行 Fake Provider**；原生 SessionPane 没有对应 snapshot，选择任务会转到本地抽屉。它不是 DSH 插件实现。
- 隔离 DSH 插件 `integration-lab/dsh-usage-board/package.json` 使用 `dsh.client.platform=web` + `inject=["slots"]`；`lib/client.js` 的实际模式是 `window.__ModuleLoader__.load({id,factory})`、`ctx.slots.inject("shell.overlay", ...)`。`dsh-subs-hub` 也使用 `dsh.client` 与 runtime/connection/settings 注入。以上说明 DSH 可以挂 UI 插件，但**仅 `shell.overlay` 不能证明可以无损替换整个 shell**。
- 本地 `integration-lab` 只有六个插件的隔离副本，没有完整 DSH 宿主与可运行的客户端依赖。进一步只读检查官方 `deepseek-ai/deepseek-harness@477b4f420553e8a52c2fbccc464d7561b239c443`：`packages/client/README.md` 将 `web/modules/connection/ui-renderer/ui-slots/ui-layout/ui-conversation/ui-approval` 列为独立包；`packages/client/ui-slots/README.md` 记载从预种的 `root` Slot 开始组合，扩展注册必须对应已声明的 Slot；`packages/client/ui-layout/README.md` 记载主内容的 `main` keyed slot 与 `ctx.layout.selectPanel(id)`，不是只有 overlay 插槽。进一步读官方固定 SHA 源码 `packages/client/ui-layout/src/client/index.ts`：其 `apply()` 独占注册 `root` 并声明 `sidebar/main/rightbar/shell.overlay/shell.leading` 子 Slot，`main` 是 keyed 区域；注释明确 `sidebar` 与 `rightbar` 已被原组件占用，替换占用者会使它声明的子位置消失。`packages/client/ui-layout/src/client/service.ts` 的 `selectPanel` 只接受已注册 `main` key。**结论：可以新增主面板，但 ZCode 全工作台不是在 `shell.overlay` 上叠一个插件即可；必须研究在 profile 中替换布局插件/根注册或复用并逐个替换占位组件，并验证卸载回滚。** 现在还不能声称可安装。
- 官方 `packages/client/ui-conversation/README.md` 说明会话视图按 Session Controller 的事件流/Context snapshot 组装，输入编辑器由 `SessionInputShell` 持有；`packages/client/ui-approval/README.md` 说明审批从 Host 侧事件与交互路径返回、Web 面板仅 allow-once/reject。这意味着原生 ZCode 的 V4 session snapshot 不能靠当前 Python 空 stub 冒充 DSH 会话，也不能让 UI 侧审批绕过 Host。以上是固定 SHA 的**文档声明**，尚未逐行验证实现。

## 分阶段落地及验收

1. **宿主接口审查，不改现网。** 基于官方固定 SHA 源码进一步核实 profile 如何禁用/替换 `ui-layout` 独占 `root` 的注册，plugin client bundling、Session Controller 事件协议、命令与审批接口以及文件/项目 API。先验证替换根布局还是只添加 `main` keyed panel；不把 overlay 强行伪装成完整 shell。验收：最小示例插件挂载/卸载且原 DSH shell 可恢复；无真实凭证。
2. **ZCode UI 插件包装。** 从已固定上游源码构建 Web 工作台，保留许可证与 NOTICE；发布包需标明修改过的文件、检查转依赖许可，并避免上游商标背书。通过 DSH client 插件入口加载，而不是在 DSH 核心里硬拷贝 UI。验收：本地 DSH host 中能启用/停用，截图与上游布局对照，无新造三栏抽屉覆盖主区；构建产物与 host 实际服务一致。
3. **逐功能对接 DSH 内核。** 为原生输入框、会话/消息流、任务列表、工具卡片/逐次审批、模型选择、工作区文件/差异、设置建立清晰的 host adapter。每项明确已接/未接，不用空代理返回值蒙混。审批保持 DSH 侧 deny-by-default；禁止前端 ACK 绕过后端 gate。验收：从原生输入框提交到 DSH 会话、流式回复、写文件前暂停并单次批准、恢复/刷新后历史一致，全程有记录与自动测试。
4. **隔离测试再决定替换默认工作台。** 源码测试、浏览器端到端、DSH 宿主内安装/卸载和回滚；只在这之后谈现网部署。现有 Python 原型可保留为隔离验证工具，但不再作为目标内核。

风险：ZCode 工作台与 DSH 内核有不同的状态机/消息协议；UI 外观可以先搬，完整功能不能用视觉相似或静态构建代替。用户明确要求最终「ZCode 精装房作插件 + DSH 毛坯房作内核」，故路线 A/B（针对 Python 原型的协议补丁或全量复刻）不再是目标路线。
