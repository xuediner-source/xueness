# DeepSeek Harness 与 Xueness

更新于 2026-11-12。对应实现：`ts/plugins/deepseek_harness/`，目录登记见 `ts/catalog/deepseek_harness.json`。

Xueness 的扩展能力由自有的通用插件系统提供。插件分三类：随应用发布的官方内置插件、由插件中心按需下载的官方插件，以及用户从本机导入的扩展包。`deepseek_harness` 插件默认关闭，它的作用是为通用扩展包导入提供 **DSH 包类型**。它不是功能入口，核心运行流程不依赖它。

## 1. 能导入什么，不能导入什么

| 来源 | 结果 |
| --- | --- |
| DeepSeek Harness 生态中公开发布的插件（GitHub 主题 `dsh-plugin`） | 不能导入或运行。导入页会识别它并说明原因 |
| 上述插件仓库里的技能文件夹（含 `SKILL.md`） | 可以按「技能文件夹」导入，单个或整批 |
| 声明式清单（`deepseek-harness.json`，或带 `xuenessHarness` 块的 `package.json`） | 已停止导入（2026-11-12）。导入页会列出其中内容并说明原因；以前导入的包仍可查看、重新检查、启用和移除 |

公开发布的 DSH 插件是代码：`package.json` 带有 `dsh` 块，`dsh.bundle.patch` 指向的 `cordis.patch.yml` 把包的入口挂载到 DSH 的 Cordis 宿主，`dsh.client` 把浏览器端的一半加载进 DSH 的 Web 界面，代码调用 `@deepseek-ai/dsh-*` 运行时服务。Xueness 没有 Cordis 宿主，也只从构建时确定的清单加载插件代码（见 `AGENTS.md`），所以这类插件不能在这里运行。2026-11-11 用八个真实仓库的清单验证过（dsh-ops、dsh-routing-suite、dsh-context、dsh-agent-teams、dsh-market、dsh-purge 和两个 dsh-tavern 项目），结果一致。

声明式格式 `deepseek-harness.json` 是 Xueness 早先自己定义的，没有任何公开的 DSH 插件使用它，名字却会让人以为它与 DSH 插件兼容。Xueness 另有自己的声明式格式 `xueness-plugin.json`，所以这种格式已停止导入。原来写在里面的内容请这样迁移：

- 提示模板：写成 Xueness 扩展包（`xueness-plugin.json`）里带 `body` 文本的命令组件。
- 只有一段文字的技能：写成 Xueness 扩展包里带 `body` 文本的技能组件。
- 带脚本或参考文件的技能：做成含 `SKILL.md` 的文件夹，按「技能文件夹」导入。
- 工具、钩子、校验命令的声明：原本只供查看，不会执行，不需要迁移。钩子可以写进 Xueness 扩展包，导入后逐条人工开启。

## 2. 使用

先在「设置 → 扩展与维护 → 功能模块」启用 **DeepSeek Harness**。

- **界面**：「设置 → 扩展与维护 → 扩展包导入」。选择 DSH 插件的文件夹，页面会说明它为什么不能导入，并提供导入其中技能文件夹的按钮。以前导入的声明式包仍在列表中，可以启用、停用、重新检查和移除。
- **命令行**（以前导入的包）：

```sh
xueness plugin activate dsh my-dsh-package
xueness plugin deactivate dsh my-dsh-package
xueness plugin unimport dsh my-dsh-package
```

- **从 DSH 插件仓库整批导入技能**：先把仓库下载到本机，然后

```sh
xueness plugin import ./dsh-agent-teams --all-skills --dry-run
xueness plugin import ./dsh-agent-teams --all-skills
```

这会找出文件夹下每个含 `SKILL.md` 的目录并逐个导入；仓库里的代码不会被读取或执行。单个技能文件夹超过 100 个文件或 600 KB 时会跳过，请在技能页面添加。

启用后，技能名称为 `包ID:技能ID`，提示模板是斜杠命令 `/包ID.模板ID`。它们分别是技能插件和命令插件的资源，只在对应插件启用时生效。

## 3. 已停用的声明式格式（供查阅以前导入的包）

一个扩展包是一个文件夹，包含 `deepseek-harness.json`，或 `package.json` 中的 `xuenessHarness` 块（两者都有时优先后者）。下面的规则仍用于校验和预览，但新包不再导入。

| 字段 | 说明 |
| --- | --- |
| `sdkApiVersion` | 必须是 `1` |
| `id` | `^[a-z][a-z0-9_-]*$`，且不是 Windows 保留文件名 |
| `version` | `主版本.次版本.修订号` |
| `tools` | `{ name, gate, mutating, description }`，只供查看 |
| `hooks` | `{ event, handler }`，只供查看，不会执行 |
| `verifiers` | `{ name, command }`，只供查看，不会执行 |
| `skills` | `{ id, path }`，`path` 是包内的 `.md` / `.markdown` / `.txt` 文件 |
| `promptTemplates` | `{ id, template }` |

限制：清单不超过 256 KB，每类贡献不超过 200 条，每个技能文件不超过 128 KB，路径不能离开包目录，清单和文件不能是符号链接。以前导入的包保存在状态目录下的私有副本（`<状态目录>/deepseek-harness/library/<id>/`）；导入页的「重新检查」会重读副本并报告清单是否被改动、技能文件是否齐全。

导入只读取数据。扩展包里没有任何内容会被 import、求值或执行。

## 4. 插件的范围

DeepSeek Harness 插件现在只做一件事：通用扩展包导入里的 DSH 包类型（功能 `deepseek_harness.library`）。模块是 `importer`（接入通用扩展包导入，拒绝新的声明式清单）、`cordis-plugin`（识别 DSH 代码插件并说明为什么不能导入）、`library`（以前导入的包的列出、重检、读取和移除）、`loader` 和 `registry`（清单校验与贡献名登记）。

早期版本随插件发布过一批没有被 Agent 运行流程调用的模块（前缀缓存、推理字段转换、验收门禁、基准、压力场景、淘汰赛、优化循环、槽位协调、SWE-bench 导入等）。它们从未产生运行时效果，已经删除，功能目录中的对应条目也一并移除。会话中的前缀复用测量由 providers 插件的 `runtime-prefix.ts` 提供。

## 5. 开发检查

```sh
npm --prefix ts run check
npm --prefix webapp run typecheck
npm --prefix webapp run build
```

测试材料在[私有验证库](https://github.com/xuediner-source/xueness-private-tests)。功能归属见[插件架构](xueness-plugin-architecture.md)，导入与启用的用法见[插件与技能指南](optional-plugins-and-folder-skills.md)。
