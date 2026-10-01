# 对话开始界面与在线运行（第二十三批）

2026-09-30。按用户要求，正式 CLI 和 Web 入口仅使用已配置模型；开始界面的操作对照 ZCode，配色、排版和整体视觉采用 Codex 式的简洁工作台方向。

## 源码基线与操作对应

本轮只读复查的上游为 [ZCode v3.14.3 / 29628c9](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)。重点检查 `packages/ui/src/v4/ConversationComposer.tsx`、`v4/composer/V4ComposerToolbar.tsx`、`V4ComposerModeControls.tsx`、`V4ComposerCuaEntry.tsx`、`prompt-editor/ChatPromptActionMenu.tsx` 及开始页传入的条件和回调。第二十三批仍保留本地对照源码；第二十四批在完成设置与工作区检查后已移除旧机壳，许可证归属继续保留。

| 开始界面操作 | Xueness 的实际行为 |
|---|---|
| 工作区 | 选择服务器允许的项目目录，打开目录选择器，或发送时创建独立任务目录。独立目录不展示其他工作区的文件和历史会话。 |
| Git 分支 | Git 插件生效且目录是仓库时显示；仅切换已有本地分支，脏工作树或正在运行的工作区会阻止切换。 |
| SSH 工作区 | Remote 插件生效时显示连接管理和选择；保存、准备和选择不连接主机。发送后绑定连接摘要，执行由 SSH 工具和权限门控制。 |
| 加号菜单 | 附件、目标、工作流、插件管理及文件/会话/技能/插件上下文。目标和工作流按开始状态与能力条件显示。方向键、Home/End 和 Escape 可操作菜单。 |
| 附件 | 选择、粘贴、拖入和移除。文本进入受限上下文；图片/PDF/视频只在所选模型声明支持时发送原生多模态输入。总计最多四份文件，媒体每份 2 MiB、总量 4 MiB。 |
| `@` / `$` / `/` | `@` 选择文件、插件或会话，`$` 选择已启用技能，`/` 选择命令或开始任务入口。上下文采用可移除标签；自定义命令正文由服务端展开。 |
| 模式 | 单个模式菜单；计划开关独立于执行权限，可单独移除计划标记。计划模式优先禁止修改。 |
| 执行权限 | 审批后修改、自动修改工作区文件、完整访问。工具禁用、插件授权和目录范围始终生效；自动修改仍保留命令审批。 |
| 模型 | 搜索和选择环境配置/已保存配置，加载失败可重试，可进入模型管理。未配置模型时明确引导配置并禁用发送，保留可编辑草稿。 |
| 思考强度 | 只显示模型声明的选项；多档时提供“默认”。切换模型清除上一个模型的显式选项，选择值进入实际模型请求。 |
| 浏览器与后台任务 | 浏览器插件生效时提供启用状态与设置；工作区已有未结束工作流时显示真实数量和管理入口。 |
| 发送/停止 | 默认 Enter 发送、Shift+Enter 换行；设置中可改为 Mod+Enter 发送，Enter 换行。首次运行确认启动后即可停止，运行中按钮及 Escape 可请求中断；停止在安全运行边界生效。 |

上游桌面原生 CUA 入口有平台和服务开关条件。当前 Web 形态没有原生桌面控制服务，因此不展示该入口；已有浏览器自动化明确标为浏览器。上下文用量只在有可信 used/max 数据时显示，当前不伪造上限或订阅配额。没有服务端输入队列时也不宣称支持队列清空/保留流程。

## 运行和插件边界

公开 `--fake`、`demo`、`/model fake` 和 Web 模拟供应商选择已移除；历史模拟会话不能继续运行。确定性 Provider 只用于内部测试注入。正常 Web 启动默认允许已配置模型请求，`XUENESS_ALLOW_REAL=0` 可由宿主关闭；缺少配置不会回退到模拟回答。

新增准备接口由 `sessions` 插件提供。发送先验证模型、附件和上下文，再取得短期、限量、单次使用且绑定工作区的 token，随后创建任务或追加消息；无效输入不会先创建空任务。缓存中的模型和远程连接快照经过服务端验证，日志仅记录受限摘要，不重复存储密钥或附件正文。普通 API 请求体上限仍为 1 MiB，只有附件准备接口允许 6 MiB。

主要实现：

- `webapp/src/XuenessWorkbenchView.tsx`、`XuenessComposerToolbar.tsx`、`XuenessWorkbenchContainer.tsx`：编辑器、操作菜单、工作区和运行接线。
- `webapp/src/xuenessComposer.ts`：目录和输入准备客户端；`plugins/providers/`、`plugins/remote/`：模型与 SSH 配置。
- `xueness/bundled_plugins/sessions/composer_api.py`、`http_routes.py`：可信输入缓存、会话接线和权限。
- `xueness/bundled_plugins/providers/`：模型能力声明、推理参数和真实协议适配。
- `webapp/src/styles/composer-toolbar.css`、`composer-workspace.css`：中性色菜单、工作区与响应式布局。

本轮的功能模块继续通过可信插件注册表生效；没有将上游云账号、商业额度或原生桌面服务声明成已复刻功能。

## 本轮验收

- 后端全量 `python3 -m unittest discover -s tests -q`：1017 项，997 项通过、20 项跳过。
- 前端单元测试：248/248 通过；TypeScript 检查和 Vite 生产构建通过。构建仍提示已有的大 chunk 和混合静态/动态导入。
- 帧和事件 golden 校验均通过：包含全部九种事件及拒绝样例、分页和投影。
- 浏览器用本机 OpenAI 兼容协议服务完成真实 HTTP 路径验收，没有调用付费模型服务。检查未配置模型的发送限制、配置保存与 MAX 参数、Git 分支切换、文本和图片附件、文件和历史会话引用、首次停止、计划模式阻止写入、自动修改文件、保存消息后运行失败的无重复重试。
- 浏览器检查没有页面异常或外部网络请求。中文浅色、英文深色、320px 和 390px 布局通过；窄屏没有横向溢出。

运行失败后，已经保存的消息会清空对应草稿并提供“重试运行”，重试只运行已有消息；未接受的输入保留草稿。准备 token 缓存跨 HTTP 插件上下文副本共享，并由实际 HTTP 创建会话测试覆盖。

验收截图：

- [开始页：中文浅色](screenshots/batch23-20260930T084433Z-start-configured.png)
- [开始页：英文深色](screenshots/batch23-20260930T084433Z-start-english-dark.png)
- [附件和引用标签](screenshots/batch23-20260930T084433Z-start-context-menu.png)
- [实际协议对话](screenshots/batch23-20260930T084433Z-conversation-online.png)
- [停止运行](screenshots/batch23-20260930T084433Z-conversation-stopped.png)
- [自动修改文件](screenshots/batch23-20260930T084433Z-conversation-file-edit.png)
- [390px](screenshots/batch23-20260930T084433Z-start-mobile-390.png) / [320px](screenshots/batch23-20260930T084433Z-start-mobile-320.png)
