# Z3 Windows 验收（2026-10-23）

环境为 Windows / Node v24.19.0。隔离工作区与状态目录，网络仅 loopback 模拟模型。文件原始结果：[source](z3-runtime-windows-source.json)、[built](z3-runtime-windows-built.json)、[相关回归](z3-targeted-tests-windows.log)、[Web 基线](z3-web-baseline.json)。

- 19 个相关测试文件一次组合：runner 汇总 75 tests、74 pass、1 skipped、0 fail。日志另标明 3 个 history corruption/history pages/journal storage 的历史 Python 对照 suite 整体跳过；fork parity 为那 1 项 skipped，均不算通过。
- 类型检查通过；check:lines 为 939 文件、最大 400 行；check:plugins 为 30 插件、393 源文件；build 为 659 个 JS 模块；test:built 的搬迁/空 PATH、静态 UI、原生 session/history、catalog、health 和未认领路由 404 通过。
- 实际 HTTP ApplicationApi + FrontDoor 的 source/built 各 4 场景、3 次模型请求：事件恢复 8 页/36 事件/3 个工具结果/稳定边界/SSE Last-Event-ID；SQLite 大整数/负零保留、完整 snapshot 与 history 导出后续写；指导及系统通知下单个闭合回合分叉/child-local identity/无重放；真实 Read/Write handler 的快照、2 文件回退、对话回退后仅留 system、generation=1、HistoryReset 与 FileRewound 持久记录。
- 166 个 Web dist 文件 SHA-256 与 Z2 一致，Web 源码没有变化，没有重复前端构建或无关全套。

定向验收发现的旧自动压缩测试在 Z2 基线也失败：64 KiB 工具结果预算使原 fixture 不再达到 auto 阈值。这里只把该 fixture 的 contextWindow 从 40000 改为 30000，恢复原有“触发压缩后重新附加读取结果与 todos”的目标，产品压缩阈值没有为测试改动。

永久删除回归扩展了新 ledger、文件快照、SQLite 行的清理及其它会话保留。所有 fixture 最终清理自身临时目录。无真实/收费模型、提交、推送或发布。安装器、Docker、CI、其它系统未在此阶段实测；归档全哈希与补丁 overlay 校验位于外部阶段交接旁。
