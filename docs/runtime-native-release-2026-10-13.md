# 原生运行时与发行验收

六阶段实现已落地，第 6 阶段的打包入口、运行时资源和原生验收门禁已完成。本轮在 Windows x64 构建并验证了真实冻结 backend、Electron 成品、NSIS 安装包和便携 ZIP；源码全量测试发现的连接收尾问题已复现修复，最终 backend 与成品已重建并完成复核。macOS Intel 与 Apple Silicon 两个原生 runner 尚未执行，仍阻挡三平台发行。所有本地模型调用为 loopback fixture，未使用收费模型。之后项目所有者明确授权覆盖本机 Windows 程序、推送源码并上传 Windows 测试版 Release，将 Mac 验收留待其自行执行，见 [GitHub 交付范围](github-publishing.md#2026-10-13-windows-测试版交付)。

## 修复与归属

- `desktop/entrypoint.py` 识别已有插件的 Pi-lite/ACP worker 和源码包 CLI，消费 `--state`/`--language` 时不扫描参数值；冻结 worker 不再误进 desktop HTTP 入口。显式 `--cli` 仍使用现有静态插件 CLI 注册表与开关检查。
- `build_backend.py` 收集固定 cryptography 50.0.2 与其许可证，runtime manifest 记录实际平台、Python、依赖版本、插件清单摘要和每个文件摘要。生成目录替换前检查实际路径。Intel CI 构建同版 Rust/OpenSSL 静态签名库，并将实际 OpenSSL LICENSE.txt 交给冻结构建收集。
- `mcp/package_binding.py` 允许冻结环境通过 `XUENESS_EXTERNAL_PYTHON` 指定真实外部 Python 绝对路径，避免只能依赖 PATH 中的启动别名。Python 源码包仍依赖外部解释器，未声称 PyInstaller backend 是通用 Python。Node 源码包在 Electron 成品中使用真实打包 Electron 的 Node 模式。
- 共享 `process_runtime.py` 的 POSIX 清理在核对 SID/PGID 后，持有 Popen wait/poll 锁保留尚未回收的 leader，完成 TERM 宽限期与组 KILL 后再回收；锁等待有期限，信号失败不报告成功。Windows Job 与已有树清理路径保留。
- `check-native-build.cjs` 检查 packager 实际收到的架构/平台参数，`dist:dir` 同样经过门禁。没有增加业务功能或共享内核例外，仍归属于已有 desktop、runtimes、mcp、extensions 的发行接线。
- 全量发现的 Windows 10053 已用真实 socket 分段上传复现。共享 HTTP 边界在发送拒绝后，只丢弃明确长度、最多 64KiB 的请求体，采用 200ms 绝对期限；Expect、非空 TE 和重复长度不进入丢弃路径，CSRF/插件门禁及关闭连接语义保持原有要求。
- Goal HTTP fixture 按 LIFO 注册清理，确保先 `shutdown` 再 `server_close`，消除测试后台线程的 Win10038 噪音。浏览器历史轨道回归在 End 定位后等待两帧并核对焦点可见，再执行独立鼠标滚动，避免把未完成渲染当作失败。

## Windows 实测

| 检查 | 本轮结果 |
| --- | --- |
| 固定签名依赖与 Ed25519 正反验证 | cryptography 50.0.2，实际 Windows x64，通过 |
| 冻结 Pi-lite worker | 同一 backend exe 发起真实 JSONL/loopback SSE，推理及中文文本通过 |
| 已签名 Python/Node ACP 源码包 | 真子进程、客户端权限拒绝、禁用门禁和退出回收通过 |
| Electron 成品 | 31 插件/223 功能、renderer 隔离、四种外观和 caption safe area 通过 |
| Electron 内 Node / Playwright | 使用成品 Xueness.exe，浏览器 worker 实际启动及关闭通过 |
| 冻结 HTTP/终端/工作流 | 认证、路径、插件禁用、三轮 ConPTY 中断/恢复、工作流与正常退出通过 |
| backend 强制退出 | 活跃终端/工作流回收通过 |
| 原生 NSIS / 便携 ZIP 构建 | 两个真实本地文件已生成 |
| 安装/更新/数据保留/卸载 | 相同 updater 代码上的前一轮隔离 GUID NSIS fixture 从 0.1.6 更新至 0.1.7，通过；两份数据摘要不变，测试注册表条目已移除；最终 HTTP 修复后未重复安装/卸载 |

本地验收目录为 `artifacts/native-stage6-20261013/windows/`，包含 `signing-runtime.json`、`frozen-runtime-transport.json`、`packaged-runtime-transport.json`、界面截图与各套原始日志。最终汇总为 [`verification.json`](../artifacts/native-stage6-20261013/windows/verification.json)，安装包与便携包的摘要在 [`installers/SHA256SUMS.txt`](../artifacts/native-stage6-20261013/windows/installers/SHA256SUMS.txt)。最终验收的 Electron 可执行文件位于 `installers/win-unpacked/Xueness.exe`，其 backend 摘要与本轮冻结验收报告一致。NSIS 更新测试的可复现证据另保留在 `desktop/update-smoke-evidence/xueness-nsis-update-p9fxauk_/`，使用独立应用名/GUID/安装目录和合成数据，没有安装或卸载用户的正式 Xueness。这份安装更新证据来自相同 updater 代码的前一轮运行；最后的 HTTP 改动后仅重打成品并复核，不能称再次完成安装/更新/卸载。

在该隔离验收之后，按所有者新授权，最终 NSIS 已实际覆盖本机 `E:/models/apps/Xueness`。覆盖前备份旧程序；覆盖后的 exe、app.asar、backend、runtime manifest 与 Web 入口摘要均和已验收成品一致，现有 308 份状态与启动偏好文件摘要保持一致。安装后的程序另外使用隔离状态通过真实启动及浏览器检查，证据为本地 `local-installation.json`、`local-installed-app.log`。这次实际覆盖不等于再次执行此前 0.1.6→0.1.7 的 NSIS 更新演练。

## 全量收尾与平台条件

各套源码全量测试本轮只运行一次，结果如下。backend Python 原始全套日志保留失败记录，修复后只重跑受影响的定向回归，没有再次运行全套或宣称修后全套全绿。

| 测试范围 | 实际结果与日志 |
| --- | --- |
| 前端全套 | 1000/1000 通过，`frontend-unit.log` |
| desktop Node | 104 通过、6 跳过，`desktop-node-unit.log` |
| backend Node | 24 通过，`backend-node-unit.log` |
| desktop Python | 13 通过，`desktop-python-unit.log` |
| backend Python 全套 | 执行 2918 项、91 跳过、1 个 Win10053 连接收尾 ERROR，原始 `backend-unit.log` 保留 |
| 修后 HTTP/questions 定向回归 | 23 项全部通过，含真实 socket 拒绝上传回归，`question-transport-regression.log` |
| Goal HTTP 清理顺序定向回归 | 8 项全部通过，`goal-http-regression.log` |
| 浏览器四个标准入口重跑 | 插件折叠、工作区任务交互、时间线虚拟化、侧栏虚拟化全部通过，`frontend-browser.log` |

Win10053 原错误位于 `AnswerQuestionRouteTests.test_post_keeps_csrf_and_plugin_gates`；已保留复现和修后证据。最终 Windows backend 与 NSIS/便携包重新构建成功；包含 HTTP 修复的冻结 worker、HTTP/ConPTY/工作流、正常与强制退出及真实 Electron 成品复核均通过。冻结正常/强制退出检查不重复执行同一源码契约；`check_backend.py --skip-contract-tests` 只在同一验收轮已经覆盖完整源码测试时使用，默认独立执行仍包含相关契约。

CI 维持 Windows x64、macOS Intel x64、Apple Silicon arm64 三个原生 runner；分别记录签名库、冻结 worker 与成品 transport 报告。发行准备检查三平台实际成功步骤、报告的平台/架构与验收结果，缺任何一份都拒绝准备发布资产。没有触发远程 workflow，也没有为当前未提交源码伪造三平台成功记录。

实际 POSIX ignore-TERM 后代测试在 Windows 跳过，必须在 Mac 原生测试中执行。此次锚点保证仅适用于仍持有未回收 Popen 的共享清理路径；跨 worker 的历史裸 PID 恢复兼容路径未改，不能扩大该保证。真实 DSH/Pi 上游模型效果、完整 v4 命令/topics 与正式发布仍不在这些 fixture 验收证据中。

独立原生检查入口：

```text
python desktop/scripts/check_package_signing.py --report <signing.json>
python desktop/scripts/build_backend.py
python desktop/scripts/check_runtime_transport.py --executable <backend> --python-executable <external-python> --report <frozen.json>
python desktop/scripts/check_app.py --executable <Electron-app> --runtime-transport-check --runtime-transport-report <packaged.json>
python desktop/scripts/check_backend.py
python desktop/scripts/check_backend.py --force-exit --skip-contract-tests
```
