# 插件按需下载与文件夹技能

## 使用方式

技能、钩子、MCP 连接器与协作代理是内置功能，不再作为重复安装条目出现在扩展市场。

订阅中心、返回模型监测、WorkBuddy 号池和酒馆不随 Xueness 安装，也不在安装包或源码仓库里预置。打开扩展市场，选择插件并点击“下载并安装”，Xueness 才从官方插件仓库 [xuediner-source/xueness-marketplace](https://github.com/xuediner-source/xueness-marketplace) 下载它；下载完成后，到插件管理中启用。下载失败或完整性校验失败时，插件不会变为可用。

未下载的插件只出现在扩展市场里：插件管理的功能插件目录、设置导航和模型列表都不显示它们，下载并启用后才出现。

WorkBuddy 需要用户提供自己的账号认证。下载包包含网关程序，不包含账号、令牌或认证种子。订阅中心同样只使用用户自己提供或授权的账号。返回模型监测读取正在使用的模型响应，不主动发送额外探测请求；上游没有报告型号时，显示未报告。

移除可选插件会先停用其服务，再删除插件代码和界面资源。账号、会话与配置留在用户数据目录中。旧版只有安装清单、没有实际插件文件的记录，需要重新下载后才能启用。

## 初始技能与使用开关

技能页直接显示七项初始技能：`seagull-game-security`、`seagull-lab`、`seagull-license-security`、`seagull-memory`、`seagull-pentest`、`seagull-reverse` 和 `ask-user-question`。它们随桌面端安装，无需在市场下载，内容标注“内置技能”。

这七项初始技能默认关闭，由用户逐项启用。每个目录型技能均提供独立开关；选择保存在用户状态目录，重启后保留。关闭后，该技能不出现在模型的标准或轻量技能目录中，也不能通过 `Skill` / `skill_read` 或输入框技能引用读取。已加载到过往会话中的正文属于会话历史，不会因开关而改写旧消息。

`ask-user-question` 使用标准模式的 `AskUserQuestion` 或轻量模式的 `ask_user`，按实际工具 schema 发起结构化提问；原始技能与辅助示例也一并保留。内置文件不随开关修改，也不提供删除按钮。原有文档、表格及可视化技能继续保留，并可各自启用或停用。

## 从文件夹添加技能

进入“技能”，点击“从文件夹添加”，在系统选择器中选择以下任一种目录：

```text
my-skill/
  SKILL.md
  scripts/
  references/
  assets/
```

也可以选择包含多个技能目录的父文件夹。每个技能需要在自己的 `SKILL.md` 中提供有效的 `name` 和 `description` 前置信息：

```markdown
---
name: project-review
description: Review a project using its architecture notes and local checks.
---
Read references/review.md, then follow the project-specific checks.
```

界面会显示读取进度、取消入口和校验结果。脚本、参考文档及二进制附件按原始字节复制到用户技能目录；添加动作不执行脚本。原文件夹不被修改。已有同名技能时整批拒绝，避免部分覆盖。

已添加的文件夹技能直接参与技能发现与模型的 `skill_read`。界面中的删除按钮只移除添加的副本。手动建立的技能目录继续可读；“新建”仍可创建原有格式的技能。

单次导入最多 1,024 个文件、32 MiB；单文件最多 16 MiB，`SKILL.md` 最多 256 KiB。文件内容分块上传，路径穿越、系统保留名称、重名路径及目录链接均被拒绝。

## 分发与实现

2026-11-17 起，四个插件的源码、界面和下载包都在独立仓库 [xueness-marketplace](https://github.com/xuediner-source/xueness-marketplace) 中维护：`plugins/<id>/backend` 是后端，`plugins/<id>/frontend` 是界面，`packages/` 是按内容摘要命名的下载包。本仓库只保留每个插件的描述（`ts/plugins/<id>/manifest.json`、`package.json` 与 `ts/catalog/<id>.json`：名称、路由、功能与能力声明），用于在扩展市场显示下载入口；插件门禁拒绝这些目录里再出现 `src/`、`assets/` 或界面代码。

`ts/packages/kernel/src/optional-packages.json` 固定本次核心构建允许的四个插件、下载地址、包摘要与每个文件的摘要，下载地址只能是官方插件仓库（`https://raw.githubusercontent.com/xuediner-source/xueness-marketplace/main/packages/`）。下载器只在用户选择安装时联网获取，验证整个压缩包和所有文件后，再原子发布到用户状态目录；桌面安装包和命令行压缩包不再携带任何插件包，也不读取本机副本。

插件界面是包内的 `frontend/optional-<id>.js` 与 `.css`。工作台在需要时以脚本方式加载它（`webapp/src/plugins/extensions/optionalFrontend.ts`），并把自己的 React 和宿主接口（`@xueness/host` 第 1 版：`t`、`tf`、`useLocale`、`get`、`post`、`del`、`EmptyState`）借给插件，插件包不自带 React。服务端从已校验的安装目录提供这些文件。

发布插件：在 xueness-marketplace 仓库运行 `npm run release`（需要本仓库检出在旁边的 `../xueness`），它构建界面、打包、写出 `pins.json`，并把新的固定摘要写入本仓库的 `optional-packages.json`；先推送插件仓库，再提交和推送核心，否则新摘要对应的包还下载不到。

只有这四个内置许可的官方插件可以加载代码。普通市场清单和用户导入的数据清单继续禁止 `entrypoint`、`command` 等可执行字段（钩子组件里的 `command` 是例外：它只登记为关闭的钩子，由用户检查后打开）；远程目录不能扩展代码加载许可。

服务端只加载已安装且通过校验的包，不回退读取开发目录。安装后可以按需启用，无需重启桌面端；禁用与卸载会关闭对应的代理或网关。核心更新固定摘要后，已安装的旧版本需要在扩展市场重新下载。

文件夹导入 API 属于 `skills` 插件，下载与包管理属于 `extensions` 插件；共享内核仅提供固定摘要的模块加载与资源读取，工作台容器仅负责挂载界面。

## 验证

回归覆盖下载后热加载、默认停用、旧清单不可激活、校验失败拒绝安装、移除后 API 拒绝访问、保留账号目录，以及技能文件夹的复制、取消、冲突和路径检查。真实桌面端验证使用独立测试数据目录，不读取用户的账号或会话。

历史长任务压测另见私有验证库的 [WorkBuddy Benchmark](https://github.com/xuediner-source/xueness-private-tests/tree/main/archive/project/验收资料/20261026-workbuddy-benchmark)。该报告使用此前版本执行，其任务成功率不能用来代替本次插件分发与文件夹导入验收。

## 从本机导入扩展包

「设置 → 扩展与维护 → 扩展包导入」可以导入本机的声明式扩展包：选择包含清单的文件夹，或只选清单文件，预览后确认导入。包类型自动识别，每种类型只在所属插件启用时可用：

- Xueness 声明式扩展包（`xueness-plugin.json`）。导入后默认关闭，到插件管理中启用。
- 技能文件夹（含 `SKILL.md` 的文件夹，连同其中的脚本和参考文件）。导入后技能立即可用，与在技能页面「从文件夹添加」相同；超过 100 个文件或 600 KB 的文件夹请在技能页面添加。
- Cursor 规则包（项目里的 `.cursorrules`，以及 `.cursor/rules` 下的 `.mdc`/`.md`）。启用后每条规则是一个斜杠命令。
- MCP 服务器定义（`.mcp.json` 或 `mcp.json`）。导入的服务器默认关闭，不会启动或连接；请在 MCP 服务器页面检查命令后逐个启用。请求头中的凭据不会导入。
- DeepSeek Harness 插件（需要先启用 DeepSeek Harness 插件）：公开发布的 DSH 插件是代码，导入页会识别并说明不能导入的原因，其中的技能文件夹可以按「技能文件夹」导入。声明式清单 `deepseek-harness.json`（或带 `xuenessHarness` 块的 `package.json`）已停止导入，以前导入的包仍可启用和移除；新内容请写成 Xueness 扩展包。

导入只读取清单和包内文件，不运行包内代码。

命令行使用同一流程：

```sh
xueness plugin imports
xueness plugin import ./my-package --dry-run
xueness plugin import ./my-package
xueness plugin unimport dsh my-package
```

导入后的扩展包默认不生效。在扩展包导入页点「启用」，或运行 `xueness plugin activate dsh my-package`，它的技能会出现在技能列表中（名称为 `包ID:技能ID`），提示模板成为斜杠命令（`/包ID.模板ID`）。「停用」或 `xueness plugin deactivate dsh my-package` 撤回这些内容；移除扩展包时也会一并清理。技能插件或命令插件关闭时，对应内容不会启用，结果中会说明原因。DSH 扩展包里的工具、钩子和校验命令不会被启用或执行。

Xueness 声明式扩展包可以在技能和命令组件里携带正文（`components.skills[].body`、`components.commands[].body`，各不超过 128 KB），带正文的组件同样可以启用。

Xueness 声明式扩展包还可以携带钩子定义（`components.hooks[]`：`event`、`command`，可选 `matcher`、`timeout`；`event` 为 SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop 之一，`command` 不超过 2000 个字符）。导入预览会显示每个钩子要运行的命令。启用扩展包时，钩子登记到钩子页面，但保持关闭，需要在钩子页面逐个检查后打开；扩展包导入页会显示还有几个钩子等待检查。替换扩展包时，只有事件、命令和匹配条件都没变的钩子保持原来的开关，其余回到关闭。

扩展包导入页选择的文件夹里如果有多个含 `SKILL.md` 的目录，页面会提示「导入这 N 个技能」，一次导入全部。

## 酒馆

酒馆是插件中心的可下载插件：在扩展市场下载安装，到插件管理中启用，然后从会话顶栏的「更多 → 酒馆」打开酒馆面板（「设置 → 扩展与维护 → 酒馆」里也有一个入口）。面板分四页：

- 角色：导入 SillyTavern 兼容的 JSON 角色卡（V1、V2、V3）和 PNG 角色卡。PNG 里的设定在浏览器中取出，只上传设定和一张不超过 64 KB 的小头像；单张卡片的设定不超过 768 KB。选中角色后可以翻看全部开场白、完整设定和存档，选择人设、预设和世界书后开始对话，也可以先「预览提示词」，看一轮请求会带上哪些段落、哪些世界书条目被激活以及原因。
- 世界书：导入 SillyTavern 的 world info JSON；角色卡内嵌的世界信息随角色使用。支持关键词（含 `/正则/`）、次要关键词逻辑（AND ANY、AND ALL、NOT ANY、NOT ALL）、角色前/后位置、顺序、概率、区分大小写、整词匹配和防递归。可以把一本世界书设为「全局」（所有角色扮演对话都用），也可以逐条开关条目、设为常驻。
- 预设：决定每轮请求怎样组织。可以编辑主提示、各段落（主提示、人设、描述、性格、场景、世界书、示例对话）的顺序和开关、作者注释及其深度、后置指令、世界书扫描深度和字符预算、递归层数，以及是否把开场白作为角色的第一条消息、是否提供工作区工具。可以导入 SillyTavern 的对话补全预设（prompts 与 prompt_order）；温度等采样参数由模型连接决定，导入时会列出被忽略的项。内置预设只读，复制后编辑。
- 人设：你在故事里的名字和描述（`{{user}}`），可以设一个默认人设。

开始对话后，这个对话以角色扮演模式运行：每轮请求都按预设重新组织角色、人设和世界书，世界书按最近几条消息的关键词重新激活，作者注释和后置指令放在对应位置，工作区上下文、记忆、编码工作指引和工具都不发送。标准模式和本机轻量模式都适用；轻量模式下仍保持一个 JSON 回复的协议。对话本身是普通会话，存档列表里可以随时打开继续；删除存档不会删除对话。

角色卡只作为数据读取，卡片里的内容不会被执行或联网获取。资料保存在状态目录的 `tavern/` 下，角色、世界书、预设和人设各不超过 200 个，存档不超过 1000 个。

限制：开场白发送给模型，但不显示在对话记录里（在酒馆面板里可以看到）；世界书位置只区分角色前和角色后，SillyTavern 的作者注释位置与按深度插入的条目按角色后处理。

`xueness plugin import <文件夹> --all-skills` 会导入文件夹下每个含 `SKILL.md` 的目录，适合从其他工具的插件仓库（例如 DeepSeek Harness 插件）中取出技能；仓库里的代码不会被读取或执行。加 `--dry-run` 先看会导入哪些。

一次性运行也会展开斜杠命令：`xueness run --prompt "/包ID.模板ID 参数" --root <目录>`。
