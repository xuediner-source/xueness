# 终端聊天 / Terminal Chat

从项目根目录启动全屏会话：

```sh
node ts/apps/server/src/cli/main.ts chat --root . --tui
```

POSIX 用户也可运行 `bin/xueness chat --tui`。隔离状态目录时，把 `--state PATH` 放在 `chat` 前，例如 `bin/xueness --state ./tmp-state chat --tui`。可用 `--continue` 或会话 ID 恢复会话。全屏界面要求输入和输出都是 TTY，且 `TERM` 不是 `dumb`；否则 CLI 会回退到行式聊天。

输入用 Enter 提交，Shift+Enter 或 Meta+Enter 插入换行；粘贴的多行文本不会自动提交。Tab 接受当前命令、模型、推理档位、模式、文件、会话或子代理补全；上下键移动菜单，Enter 选择，Escape 关闭。`/resume` 可筛选会话，Ctrl+P 打开会话选择器（运行中先暂停），Ctrl+G 或 `/tasks` 打开子代理列表。选择子代理后显示其只读时间线，按 Escape 返回父会话。

| 操作 | 快捷键 / 命令 |
| --- | --- |
| 编辑草稿 | 左右键移动；Ctrl+Left/Right 或 Meta+Left/Right 按词移动；Ctrl+A / Ctrl+E 到行首 / 行尾；Ctrl+U 清空；Ctrl+W 删除前一个词；Ctrl+K 删除光标后的内容 |
| 历史与滚动 | 无草稿时用上 / 下键浏览输入历史；PgUp / PgDn 滚动对话；Ctrl+Home / Ctrl+End 跳到最早 / 最新内容 |
| 暂停、复制、退出 | 运行中按 Escape 请求暂停；Ctrl+Y 复制选中文本，选中文本时 Ctrl+C 也复制；无选择时 Ctrl+C 清空非空草稿，空草稿下两秒内连按两次退出；空草稿 Ctrl+D 也退出 |
| 菜单与模式 | Ctrl+P 会话菜单；Ctrl+G 子代理菜单；Shift+Tab 循环 `plan`、`build`、`edit`、`yolo`；`/mode` 打开模式菜单 |
| 侧栏 | Ctrl+X 后按 B 切换侧栏、M 切换修改文件区、A 打开开发者 API 区；也可输入 `/sidebar` |
| 队列与指导 | 运行中按 Enter 将输入排入后续队列；Ctrl+Enter 或 Ctrl+S 将指导发给当前轮次；`/queue` 查看待处理输入并用 Enter 撤回选中项 |
| 剪贴板 | Ctrl+V 从系统剪贴板捕获 PNG 图片并作为附件；Ctrl+Y 复制选中文本 |

输入 `/model`、`/effort`、`/mode` 或 `@文件路径` 后可用补全菜单；`/attach "路径"` 也可添加附件。`/compact` 手动压缩上下文，`/help` 查看命令，`/theme auto|light|dark` 选择终端主题，`/developer` 切换开发者信息。主题使用 truecolor ANSI 颜色；`auto` 在终端回复 OSC 11 背景查询时按亮度选择明暗模式，未收到回复则使用深色。Markdown 显示标题、粗体、行内代码、带目标地址的链接、引用、列表、围栏代码及基础关键字 / 字符串 / 数字 / 注释着色、GFM 表格；diff 行按新增、删除和 hunk 标记着色。

工具调用、推理、压缩和工作流以可折叠卡片显示。点击卡片标题或按 Ctrl+O 展开 / 折叠工具和推理；空草稿下按 `+` / `-` 展开 / 折叠工作流。失败或中断的压缩卡片显示 Ctrl+R 重试提示，展开后也可选择重试命令。工具卡片按实际事件显示路径、输入、结果和 diff；侧栏仅呈现后端提供的状态、子代理、MCP、修改文件、待办和实际用量数据，缺失字段会省略；API 区仅在开发者视图出现。宽度超过 120 列时侧栏默认并排显示，较窄终端通过 Ctrl+X、B 以浮层打开，各区默认展开。

模型请求遇到可恢复失败会自动等待并重试；失败尝试里的半截工具输入不会显示成工具执行。正文或思考文字产生后，本次流中断会保留已显示部分，不再自动重放。最终失败按认证、额度、网络、超时等原因显示中文提示，并保存在会话里；用户停止不会显示成供应商失败。网络区记录请求开始、完成及每次尝试耗时，缺失的用量不会补估。

审批仍由权限服务决定，终端只展示请求并提交操作员选择：上下键与 Enter 选择“仅本次允许”“在此项目中始终允许”（请求提供精确项目范围时）或“拒绝”；Y / N 可快速允许一次 / 拒绝，R 输入可选拒绝原因，Escape 拒绝。结构化澄清问题逐题填写：上 / 下或 J / K 移动，数字选择，支持多选的问题用 Space 勾选；O 输入自定义答案，S 跳过当前题；末题后 Enter 进入答案复核，Enter 提交，Tab 回到首题，PgUp 回到末题，Escape 取消。

后端模式保留 Xueness 的 `plan`、`build`、`edit`、`yolo`；全屏 TUI 没有 ZCode 的 `guarded` 模式。全屏呈现只连接会话、权限和附件端口，不自行调用模型或网络。终端图片功能是从系统剪贴板读取 PNG 并作为附件，不支持终端内图像 / 图形协议。Windows 真实 ConPTY 和 Linux x64 伪终端的源码版与构建版都已通过本地模拟 provider 验收（Linux 记录见 `验收资料/验证记录/tui-linux-*.json`）；macOS 终端与各平台真实剪贴板未实机验证。

本地复现：`node tools/verify-tui.mjs` 检查补全、审批和续聊，`node tools/verify-tui-queue.mjs` 检查排队与当前轮指导；构建后给两个命令增加 `--built`。第 14 轮在 Windows、第 15 轮在 Linux 上，这四个流程均通过，使用隔离临时状态与本地模拟 provider。完整结果与验证边界见 `ts/HANDOVER.md` 第 37、38 节。
