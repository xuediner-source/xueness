# Z5 验证记录索引

Windows / Node v24.19.0，2026-10-23。本阶段只运行相关回归与必要构建/应用验收，未运行无关全套或前端重建。按最终测试身份去重：67 tests、64 pass、3 skip、0未解决失败。不是单个runner一次汇总；重复补跑不累计。

| 记录 | 验证事实 |
| --- | --- |
| z5-host-regressions-windows.log | 六文件20tests：17pass、1fail、2skip；另有整体skip suite |
| z5-plan-draft-fix-windows.log | 上述唯一fail在Z4同样重现后修复，原命名用例1pass；file-rewind额外4pass。快照仅覆盖工作区，不再拦住授权宿主草稿 |
| z5-config-merge-windows.log | 同一MCP宿主测试文件新增1pass，覆盖旧资源与新层合并、type别名覆盖 |
| z5-mcp-targeted-windows.log | 五文件25tests，24pass、1POSIX环境skip |
| z5-hooks-targeted-windows.log | 两文件13pass |
| z5-settings-targeted-windows.log | runtime-config四项pass |
| z5-runtime-source-windows.json / z5-runtime-built-windows.json | 真实ApplicationApi/FrontDoor，各4场景4次loopback模型请求，无收费/公网模型 |
| z5-z3-compatibility-built-windows.json | 最终构建Z3四场景3次loopback请求，真实文件快照/回退、分叉、SQLite无损导出 |
| z5-build-windows.log / z5-relocated-built-windows.log | 类型检查、677JS构建和搬迁空PATH运行通过 |
| z5-baseline-web-audit.json | Z4基线零删除、Web源码不变，166dist逐项size/hash一致 |

结构门禁：964个TS文件，最大400行；30插件、406插件源文件，均通过。初始失败日志留作事实，修复验证以指定补跑日志为准。全套suite的跳过不算通过；Linux/macOS原生、安装器、Docker、CI未在本阶段验证。
