# TS 迁移验收证据（2026-10-18）

本目录对应本次 M4.2a/M4.2b/M4.3 和 Windows 桌面分发接线。范围、运行方式和保留的 Python 功能见 [交接文档](../../ts/HANDOVER.md)；父目录中的旧 HTML 是输入包历史记录。

| 证据 | 结果 |
| --- | --- |
| `migration-check-final.log` | TS 516 项：511 通过、5 跳过、0 失败；类型/行数/插件门禁通过 |
| `python-full-final.log` | Python 3432 项：3324 通过、108 跳过、0 失败 |
| `python-architecture-final.log` | 插件架构脚本通过；随后执行 `py -3.11 -m unittest tests.test_plugin_architecture tests.test_packaging -q`，36 项全部通过，耗时 144.597 秒（unittest 摘要输出到终端 stderr） |
| `desktop-final-tests.log` | 桌面 119 项：113 通过、6 跳过、0 失败 |
| `frozen-backend-check.log` | 冻结后端 246 项，21 跳过、0 失败；工具、HTTP、ConPTY、工作流与退出通过 |
| `desktop-installer-final.log` | 最终 Windows NSIS 和完整便携 ZIP 构建成功；256 个 JS 编译模块 |
| `built-final-check.log` | 编译产物异地复制、空 PATH 下随包 Node 启动和 Python 互读通过 |
| `packaged-native-check.log`、`packaged-native-report.json` | 最终分发目录中的 5 次会话/历史/附件请求成功，代理计数增量 0 |
| `packaged-app-final.log`、`packaged-app-report.json` | 实际 Electron 界面：30 插件/254 功能、主题、标题栏、浏览器驱动与退出通过 |
| `screenshots/` | 最终应用四种配色/主题截图；浅色 Xueness 与深色 Claudex 已人工视觉复核 |
| `original-windows-hashes.json` | 原版两个 Windows 交付物与原清单 SHA-256 一致 |
| `final-artifact-status.json` | 新安装包签名状态及构建时间；本次构建未签名 |

测试在独立临时数据目录运行，模型服务使用本地脚本化 fixture，没有调用付费模型。Windows 验收不代表 Mac/Linux 实机验收。跳过项没有计入通过数。CI 配置已补齐 TS 依赖安装、完整检查和 Windows 分发目录检查；没有在远程触发 CI。
