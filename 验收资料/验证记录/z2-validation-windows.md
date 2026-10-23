# Z2 Windows 验收记录（2026-10-22）

环境：Windows，Node v24.19.0。基线为第 19 轮完整包，开发使用独立源码目录及隔离状态；无真实/收费模型调用。

| 检查 | 实测结果 |
| --- | --- |
| 21 个受影响测试文件 | 112 项，108 通过，4 跳过，0 失败 |
| 收口后 shell 定向复验 | 6 项通过；是上述相关集合的复验，不重复计数 |
| typecheck | 通过（后端 build 的前置步骤） |
| check:lines | 918 TS 文件，最大 400 行 |
| check:plugins | 30 插件，380 源文件 |
| build | 644 个 JS 模块 |
| test:built | 搬迁、空 PATH、静态 UI、原生会话/历史、插件目录、health、未认领路由 404 通过 |
| verify-z2-runtime source | 4 场景 / 10 次 loopback 请求通过 |
| verify-z2-runtime built | 4 场景 / 10 次 loopback 请求通过 |
| Web dist | 基线 166 文件逐项 SHA-256 相同，无前端源码改动；原始比对见 [z2-web-baseline.json](z2-web-baseline.json) |

回归覆盖 turn 生命周期、停止/失败/边界、旧 Z1 重试和准入/媒体、工具契约、Read/Write/Edit、后台进程、授权等待/bridge、文件快照恢复、结果预算/分页、历史配对、公开/终端/事件投影、持久 queue/steering、原生服务、子代理和 workflow actor。4 项跳过是 queue-commands 中已退役 Python 后端的历史差分对照，不算通过。日志：[相关回归](z2-targeted-tests-windows.log)、[shell 收口复验](z2-shell-close-windows.log)。

真实服务入口验收由 `node tools/verify-z2-runtime.mjs` 和 `node tools/verify-z2-runtime.mjs --built` 执行，构建版使用 canonical dist/apps/server 入口。每种模式验证：跨 service 实例的读取依据恢复并写入（4 请求）、缺失旧工具结果闭合且零重放（1）、延迟回复期间指导在同一回合完成（2）、真实子进程终态通知一次/零增量输出消费/日志保留（3）。原始报告为 [source](z2-runtime-windows-source.json)、[built](z2-runtime-windows-built.json)。请求计数是模拟服务调用次数，不是实际模型性能。

收口时修正了仅 running 事实变化也会触发模型继续的问题，并保留旧 shellPlugin 命名导出；之后只复验受影响测试、源码/构建入口及必要构建。没有重复整个后端/前端套件，也没有重建未改动的 Web。安装器、Docker、CI、其它操作系统和真实剪贴板未在本阶段验证。归档与补丁 overlay 核验记录单独位于外部阶段交接文件旁，避免把归档自身哈希写入归档造成循环。
