# Xueness 0.1.8 · Z3 阶段交付

Z3 会话事件与存储的 Xueness 适配完成，基于 Z2。主代理负责范围/设计/验收，GPT-6-Luna / max 子代理执行指定模块；额度暂不可用时由主代理接手。按用户要求，完成阶段后继续 Z4。

- 持久运行事件、单调序号/epoch、纯 reducer、冷实例分页与 SSE Last-Event-ID 恢复接入真实服务；保留完整可见事件，旧事件协议继续兼容。
- 可选 Node SQLite 完整快照库、授权根查询、事务导入和无损导出后续写，保留 JSON journal 与修订链为权威。
- 分叉改为 child 独立身份并记录稳定边界；真实指导和后台系统通知保持同一回合。消息回退有 lease、revision 和 branch-cut generation，旧工具不重放。
- 授权文件工具前后快照、hash 核验预览、字节恢复/新文件删除和失败补偿；文件与对话分别回退。压缩 operation 与摘要 boundary 同快照提交，冷恢复只采用精确完成证据。
- 永久删除覆盖新事件 ledger、文件历史 artifact 和 SQLite 行；开关、归属、catalog/manifest 同步。

19 个相关测试文件：runner 汇总 75 tests / 74 pass / 1 skipped / 0 fail，另有 3 个整体跳过的退役 Python 对照 suite。类型、插件（30/393）、行数（939/400）、后端构建（659 JS）和搬迁检查通过；实际 HTTP 主入口 source/built 各 4 场景、3 次本地模拟模型请求通过。旧自动压缩测试依赖工具结果超过窗口，Z2 的 64 KiB 预算使它不再触发；本阶段只调低该 fixture 窗口以保留原测试目标。

Web 源码未改动，沿用并逐项核验 166 个 dist 文件；未运行无关全套，未调用真实或收费模型，未提交/推送/发布。SQLite 为辅助库、导出仅 journal/修订链，文件回退不包含 shell/网络副作用，详见 [使用说明](docs/engine-z3.md) 和 [HANDOVER §44](ts/HANDOVER.md)。完整包与相对 Z2 的零删除补丁应用见 [PATCH-Z3.md](PATCH-Z3.md)。
