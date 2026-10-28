# Xueness TypeScript 后端

Xueness 的后端全部在此目录。迁移从 Python 后端前面的 TS 前门开始，逐步接管全部插件；第 10 轮删除了 Python 后端、桥接与回退开关，Web 服务、桌面宿主和 CLI 都只运行 TypeScript。当前阶段范围及 Z7 source/built 验收结果见 [HANDOVER.md](https://github.com/xuediner-source/xueness-private-tests/blob/main/archive/project/ts/HANDOVER.md)（第 48 节：Z7 app-server/headless）、[Z7 使用说明](https://github.com/xuediner-source/xueness-private-tests/blob/main/archive/project/docs/engine-z7.md) 和 [Z7 工作摘要](https://github.com/xuediner-source/xueness-private-tests/blob/main/archive/project/WORK-SUMMARY-20261023-Z7.md)。

## 运行

需要 Node 24.11+（直接运行 `.ts` 源码，类型在运行时剥离）。完整工程带有构建好的 `webapp/dist/`。

```sh
cd ts
npm ci
npm run check
npm run serve            # 等同于 ../bin/xueness-web
```

默认监听 `http://127.0.0.1:8137`。通过设置中的 provider 配置实际模型；本机测试只使用本地脚本化服务，不调用付费模型。命令行入口是 `../bin/xueness`（`apps/server/src/cli/main.ts`）。

从项目根目录运行 `node ts/apps/server/src/cli/main.ts chat --root . --tui` 可进入全屏终端聊天；它由 sessions 插件拥有。没有 TTY 时使用原有行模式。详见[终端聊天使用说明](../docs/xueness-terminal-chat.md)。

`npm run serve -- --help` 可查看 `--port`、`--host`、`--project-root`、`--state`、`--web-runs`、`--workspace-root` 和 `--allow-real-provider`。非 loopback 绑定仍需 `XUENESS_ALLOW_REMOTE=1`。

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 行数、插件、类型与全部测试 |
| `npm test` | 全部测试（Python 对照在没有 Python 后端时自动跳过） |
| `npm run test:sessions` | 存储、修订链、锁和基础投影 |
| `npm run test:fast` | 显式跳过 Python 对照的快速测试 |
| `npm run build` | 编译 JS，准备生产依赖和随包 Node |
| `npm run test:built` | 复制产物后在空 PATH 下启动验证 |
| `npm run test:packaged` | 实际安装目录中的运行时与原生路由检查 |
| `npm run serve:built` | 使用编译后的 JS 启动 |
| `npm run typecheck` | 严格类型检查，不生成文件 |
| `npm run check:plugins` | allowlist、manifest、import 与能力门禁 |
| `npm run check:lines` | 每个 TS 文件最多 400 行 |
| `npm run bench:tools` | 隔离工作区中的工具对照基准 |
| `npm run manifest -- --write` | 重新生成项目根目录的 `complete-project-manifest.json`（不加 `--write` 只检查） |

随机对照规模可用 `XUENESS_DIFF_CASES`（默认 3000）、`XUENESS_IGNORE_CASES`（150）、`XUENESS_GUARD_CASES`（4000）调整。测试输出中的跳过项不算通过。

Python 差分对照（`test-support/python-oracle.ts`）仍保留：把 `XUENESS_PROJECT_ROOT` 指向第 9 轮检查点的解压目录（其中仍含 `xueness/`），并设置 `XUENESS_PYTHON` 指向 CPython 3.11+，即可重新与冻结的 Python 实现逐项比对。

## 生产链路

```text
桌面 / HTTP 客户端
  → TS 前门：分帧、Host/Origin/CSRF、桌面令牌、体积/时限、流背压；无人认领的路由返回 404
  → 插件 API：providers、sessions、planning、git、settings、desktop、browser …（插件目录数据在 catalog/）
  → SessionStore / NativeFileLocks
  → AgentRunner → provider → PluginHost / ToolBridge → 文件、shell、交付检查
```

- SessionStore 默认使用原生跨进程锁（Windows 字节锁、POSIX flock）；持久化无损保留 float、负零和大整数。
- 会话保存遵循私有临时文件、备份、原子发布、目录同步及修订链规则。Python 数值等价导致修订链损坏的问题已修复。
- 会话生命周期包含审批、部分输出、队列、steering、完成记录、压缩、模型切换、事件流、分叉与检查点；附件包含私有媒体绑定、分块续传和恢复回执。
- 插件禁用后不再启动其新任务；运行环境、流订阅和后台任务在停止或退出时清理。
- 编译产物的工作区依赖已物化，不含指向开发目录的绝对 junction。桌面使用随包 Node 和 JS（`backend-ts/`），不再携带冻结的 Python 后端。

代码地图、逐项能力和迁移过程见 HANDOVER；第 33 节记录删除 Python 后的状态。原有 M0–M4.1 设计记录保存在 [docs/M0-M4.1-reference.md](https://github.com/xuediner-source/xueness-private-tests/blob/main/archive/project/ts/docs/M0-M4.1-reference.md)，该文件是历史快照，不能代替本次状态。完全对齐 ZCode 的后续步骤见 [docs/zcode-alignment-roadmap.md](https://github.com/xuediner-source/xueness-private-tests/blob/main/archive/project/ts/docs/zcode-alignment-roadmap.md)。

## 验证边界

- 不把 POSIX/macOS/Windows 的跳过项宣称为已验收。构建出来的运行时只适用于构建主机的系统与架构。
- 测试会真实启动 HTTP 服务、Git 仓库和跨进程锁竞争；模型调用由本地脚本化服务提供。测试通过不代表实际模型的成功率、Token 成本或性能。
- 会话格式与 Python 版本保持字节兼容，旧状态目录可直接读取、续写。
- 同进程插件与权限策略不是系统沙箱。shell 内容、脚本、Git 驱动等仍由现有执行权限边界约束。

## 兼容性说明

- 普通 JSON 解码遵循 JS 数值表示；持久化会话和修订日志显式使用无损解码。JS 的整数样式对象键有固有遍历顺序，极少数孤立代理字符仍有限制。
- Node HTTP 解析器会更早拒绝部分畸形请求；极少数原因短语、字体 MIME 和请求行超时行为与原 Python 服务可能不同。
- provider 代理读取环境变量，不读取 Windows 注册表/macOS 系统代理。User-Agent 标识执行器；错误体读取和 DNS 超时约束与 urllib 有已记录差异。
- 后台 shell 任务不跨宿主重启；下次显式运行时，已保存的 running 事实若失去对应运行器会标记为 lost、退出码未知，并投递一次状态通知。既有日志不会被当作仍在运行的任务恢复。
- 新功能必须有实际插件 owner、manifest 中英文 feature、有效状态检查与权限/生命周期测试。详见项目根目录 AGENTS.md、CONTRIBUTING.md。
