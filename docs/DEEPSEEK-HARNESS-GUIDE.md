# DeepSeek Harness 使用指南

日期：2026-10-26（H08.05）。对应实现：`ts/plugins/deepseek_harness/`（版本 0.2.1，catalog 见 `ts/catalog/deepseek_harness.json`）。

DeepSeek Harness 是一个**默认关闭**的可信 bundled 插件，面向 DeepSeek 风格 provider（V4.1 / R1 一系）提供：

- **确定性 KV-cache 前缀稳定器**（`deepseek_harness.prefix_cache`，H01.03）
- **reasoning_content / reasoning_effort 双协议桥**（`deepseek_harness.reasoning_bridge`，H01.04）
- **编辑后自动验收门禁 + 压缩诊断**（`deepseek_harness.auto_verify`，H02.01）
- **错误栈压缩与有限次自修复**（`deepseek_harness.self_repair`，H02.02）
- **Critic-Solver 双模型补丁评审编排**（`deepseek_harness.critic_solver`，H02.05）
- **JSONL 轨迹记录与 KV 命中率分析**（`deepseek_harness.trajectory`，H02.06）
- **TS/Python 符号图仓库地图**（`deepseek_harness.repo_map`，H02.03/04）

外加兼容层（H04：SWE-bench、规则包/工具包导入、沙箱 verify）、基准与回归（H06）与 swarm 编排（H07）。

## 0. 铁律（先读）

1. **零粘合（zero-glue）**：外部 harness 源只是**声明式数据清单**。loader / registry / 兼容层从不 import、求值或执行源里的任何代码（`ts/plugins/deepseek_harness/src/loader.ts` 头注）。
2. **默认关闭**：`defaultEnabled: false`。插件关闭或依赖不可用时，所有 RPC 方法直接回答 `disabled`，不启动任何请求、轮询或子进程。
3. **启用 ≠ 授权**：插件 manifest 声明 `exec: ["*"]`（门禁/自修复要跑配置好的命令）。实际执行仍受 Gate、审批、Host/Origin/CSRF 与工作区边界约束；生产入口须绑定状态目录（`--state` / `createApplicationApi({ stateDir })`）。
4. **失败不扩散**：单条加载、单个 bench case、单个 swarm job 失败都只标记自身，不中断其余部分。

## 1. 安装与启用

插件已随服务端打包（`ts/apps/server/src/bundled-plugins.ts` 的 `BUNDLED_TS_PLUGINS`，目录登记 `ts/catalog/deepseek_harness.json`），无需单独安装：

1. 打开 **设置 → 插件 → 已安装功能插件**（settings 插件关闭时用账户菜单的「插件管理」入口）。
2. 找到 **DeepSeek Harness** 卡片（含 7 个子功能），开启总开关。
3. 开关持久化在状态目录里；重启后按状态目录恢复。

命令行侧对应 `xueness harness ...`（见 §3）；Web/HTTP 侧 `/api/deepseek_harness/*` 路径族归本插件所有（`ts/packages/contracts/src/route-catalog.ts` 的 `BUNDLED_PLUGIN_IDS`）。

## 2. RPC 面：load / list / verify / bench

宿主用 `createHarnessApi()`（`ts/plugins/deepseek_harness/src/index.ts`）构建 RPC 面，方法名是 `<plugin>/<action>`：

| 方法 | 参数 | 作用 |
| --- | --- | --- |
| `deepseek_harness/load` | `{ source }` | 热加载一个目录或包源 |
| `deepseek_harness/unload` | `{ id }` | 卸载一个已挂载 harness |
| `deepseek_harness/list` | `{}` | 列出所有挂载及贡献计数 |
| `deepseek_harness/verify` | `{ id? }` | 结构化逐项校验报告 |
| `deepseek_harness/bench` | `{ baseline? }` | 跑基准套件；带 baseline 时出回归报告（H06.06） |

### 2.1 harness 源的形状

一个源是**目录**，满足其一即可：

- 目录下有 `deepseek-harness.json`；或
- `package.json` 带 `xuenessHarness` 块（优先读取）。

清单字段：`sdkApiVersion`（必须是 `1`）、`id`（`^[a-z][a-z0-9_-]*$`）、`version`（`MAJOR.MINOR.PATCH`），以及五类贡献 `tools` / `hooks` / `verifiers` / `skills` / `promptTemplates`。约束：单文件 ≤ 256 KB；每类贡献 ≤ 200 条；清单不能是符号链接；类内重名在加载时即拒绝。

### 2.2 加载语义

- **全有或全无**：先完整解析校验，再挂载；挂载中途被拒会回滚已落部分，失败后 registry 与之前完全一致。
- 重复 id 二次加载返回 `already_mounted`，且**不会**碰已有挂载。
- registry 以 `${kind}:${name}` 索引，任何贡献名最多一个属主。
- `verify` 会**重读**每个源并输出逐项（per-item）结构化报告，因此能发现源目录在挂载后被改动/删除的情况。

### 2.3 沙箱 verify（H04.06，opt-in）

`withSandboxedVerify(api, verifier)` 把 `deepseek_harness/verify` 包进隔离执行：先把工作区克隆成 worktree 沙箱（`kind: "worktree"`）或容器沙箱（`kind: "container"`，需给 `ContainerSpec`），在克隆内跑 H02 门禁表；失败即回滚到门禁前快照，**源工作区永不被触碰**。沙箱默认放在 `<cwd>/.sandboxes`，默认 `keep: "onFailure"`（保留失败沙箱便于诊断）。

## 3. CLI：`xueness harness`

CLI 是同一 dispatch 的薄封装，保证 CLI 与 RPC 不漂移：

```text
xueness harness <load <path> | unload <id> | list | verify [id] | bench [baseline-json]>
```

- 输出一律是 JSON 行；退出码：成功 `0`，命令失败 `1`，用法/JSON 解析错误 `2`。
- `bench` 在套件不健康（有 case 失败或回归）时退出 `1`，可用于 CI 门禁。
- `bench` 的 baseline 是此前一次运行的 `summary` JSON（见 §6）。

## 4. Builtins（内置执行面）

### 4.1 auto-verify（编辑后验收门禁）

门禁表每项是 `GateDefinition`：`name`、`command`（argv 数组）、可选 `watch`（工作区相对路径/前缀，只有命中改动才跑；无 `watch` 恒跑）与 `timeoutMs`。运行器选项：`cwd`、`defaultTimeoutMs`、`stopOnFirstFailure`、压缩 `limits`（默认 head 15 行 + tail 25 行、4000 字节）。失败时返回**压缩诊断**而非原始输出（去 ANSI、规整换行）。生产执行器是 `spawnGateRunner`；时间与进程全部可注入，压缩/选择规则是纯函数。

### 4.2 self-repair（有限次自修复）

`compressStackTrace` 把原始错误栈压成有界摘录（消息 + 最外层用户帧 + 内部帧折叠为省略标记 + 工作区路径相对化）。`runSelfRepairLoop` 在每轮门禁失败后把压缩诊断交给 repair 回调再复验，最多 `maxAttempts` 轮，**必然终止**；repair 返回空即放弃。

### 4.3 critic-solver（双模型评审）

Solver 出补丁、Critic 出结构化裁决，循环直到 Critic 接受、判定不可修复或 `maxRounds`（默认 3）耗尽。模型是注入的 `HarnessModel`——编排本身不开网络。`onExchange` 钩子把每轮交换喂给轨迹记录器。

### 4.4 trajectory（轨迹与 KV 命中分析）

`TrajectoryRecorder` 每次模型交换追加一行 JSON（JSONL），含 prompt 与 DeepSeek 风格 usage 里的缓存命中 token 数；`analyzeTrajectory` 读回并按模型/角色聚合 KV 命中率——前缀稳定性是**测出来的**，不是假设的。

### 4.5 repo-map / symbol-graph（仓库地图）

`symbol-graph` 用纯正则从 TS/Python 源提取符号与引用关系（无 AST 依赖）；`repo-map` 把 path+source 列表压成有界、确定性的地图：按信号排序的文件 + 每文件符号摘要 + 字符预算（宁可声明不要函数体），适配 DeepSeek 上下文窗口。

## 5. Providers 路径：prefix-cache 与 reasoning 桥

- **prefix-cache（H01.03）**：`canonicalJson`（排序键、稳定标量）+ `stablePrefix`（投影到缓存相关部分：system、按名排序的工具声明、消息历史，按构造排除易变字段）+ `createPrefixCache`（按 session 记录前缀，报告最长公共前缀命中长度与按 model 的命中率）。指标是请求序列的纯函数，同序列重放得同数字。
- **reasoning-bridge（H01.04）**：OpenAI 线（`reasoning_content` 字段 + `reasoning_effort` 参数）↔ Anthropic 线（`thinking` 块 + `budget_tokens`）双向转换；effort 档位 `low|medium|high|max` 双向映射。往返保证：user/assistant 列表经 Anthropic 再回来逐字节一致；`signature` 是线本地元数据，进 OpenAI 线即丢弃，绝不伪造。

H08.03 的 e2e 验证 reasoning_effort 与 prefix-cache 在 providers 路径生效。

## 6. Bench 与回归报告（H06）

- **跑法**：`xueness harness bench > baseline.json`（或 RPC `deepseek_harness/bench`）。默认套件三个确定性 case：stable-append（全命中）、prefix-churn（大多未命中）、canonical-JSON 往返。token 数由请求字符确定性推导。
- **回归比较**：下次运行传 baseline —— `compareBenchRuns` 对 `latencyMs` / `tokensIn` / `tokensOut` / `cacheHitRate` / `successRate` 出带符号 delta 与裁决（`improved` / `regressed` / `unchanged`，默认相对阈值 10%），ok→failed 列为硬回归，case 增删单独记录；`serializeRegressionReport` 字节稳定可存档 diff，`renderRegressionMarkdown` 出人读表格。
- **profiler（H06.03）**：每次模型调用记一条样本——token 数（provider 报告或确定性估算，估算必带标记）、按 H01.03 测的 KV 命中、原始延迟与采样条件；`summary` 按模型聚合命中率（前缀测得 vs provider 报告）与延迟 min/median/p95/max。`profiled-runner`（H06.04）让一次 bench 运行自带 profile。失败调用不进 profile（没有诚实的数字），其余 case 照跑。
- **H06.01/02**：注入时钟的 runner（重复运行字节一致报告）+ 自带确定性输入的 fixtures（SWE-bench 导入、contracts 校验、prefix 重放、shard 规划）。

## 7. Swarm（H07）

- **coordinator（H07.01）**：N 个 worktree 槽位独占租借；全忙时显式等待队列，释放时排队者依次获得。纯内存记账，无定时器。
- **sharding（H07.02）**：`planShards` 把文件 scope 贪心 LPT 划成 N 个**互不重叠**的分片，按文件权重大致均衡；确定性（排序输入 + 稳定 tie-break），`shardsAreDisjoint` 可复查。
- **critic-slots（H07.03）**：Solver 槽池（默认 2）与 Critic 槽池（默认 1）**完全分离**，评审洪峰不会饿死求解吞吐（`SwarmStats` 有按类别的并发高水位证据）。
- **job-runner（H07.04）**：单 job 异常/拒绝/崩溃被逐槽捕获，重试至多 `maxRetries`（默认 1）后**标记**失败——绝不Reject整个协同运行、不连坐兄弟槽、不留死锁槽位；`progress()` 出实时计数。H08.04 的 e2e 验证 subagent 可用 harness 工具且不越权。

## 8. 兼容层（H04）

- **SWE-bench（H04.01/02）**：`importSweBenchTasks` 解析任务 JSONL（容忍空行/CRLF，测试键大小写不敏感，坏行带 1 起始行号报告、不整批失败）；`evaluateSweBenchRun` 按「FAIL_TO_PASS 全过且 PASS_TO_PASS 不回退」判定 resolved（缺失按未过计）；`exportSweBenchEvaluations` 经确定性序列化器输出字节稳定的 JSONL。
- **规则包导入（H04.03）**：`importRulePacks` 识别三种源——`cursor`（`.cursorrules`、`.cursor/rules/*.mdc|*.md` → prompt 模板）、`claude-skills`（`.claude/skills/<id>/SKILL.md` → skill 贡献）、`deepseek-harness`（原生清单，零转换直挂）。导入同样全有或全无，失败回滚本次全部挂载。
- **工具包导入（H04.04）**：`importToolBundle` 加载声明工具（MCP 暴露的 gate 为 `mcp`）的原生 harness 源——就是普通加载，list/verify 一视同仁，零粘合不变。
- **沙箱 verifier（H04.05/06）**：见 §2.3。

## 9. CLI / Desktop 呈现

- **CLI**：`xueness harness`（§3），与 RPC 同一 dispatch。
- **Desktop 评审抽屉（H05.03/04）**：`ts/apps/desktop/src/renderer/critic-review-drawer.ts` 的纯视图模型把 `CriticSolverResult` 变成逐轮 Solver/Critic **行级 diff**（对工作区基线，LCS diff + 增删统计）、一键接受/拒绝（接受的补丁不可变地应用），并与轨迹联动：`summarizeTrajectory` 把 H02.06 JSONL 压成回放时间线，时间线事件能定位回产生该补丁决策的轮次。模型无 DOM 访问，渲染层只消费它。
- **HTTP**：`/api/deepseek_harness/*` 路径族归本插件（route catalog）。

## 10. 验证门禁（开发者）

在 `ts/` 下：

```sh
bun test            # 或 npm test（node --test）
npm run check:lines     # 单文件行数门禁
npm run check:plugins   # 插件结构/清单/导入一致门禁
npm run typecheck
```

H08 的 e2e（extensions / hooks / providers / subagents 四条路径，H08.01–04）位于 `ts/plugins/deepseek_harness/test/`，回归证据见仓库根 `H08.06-result.md`。

## 附录 A：H08 收口硬化清单（H08.06）

每项给出不变量与落地位置；「e2e」列指 H08.01–04 的四条路径测试。

| # | 硬化不变量 | 落地 | e2e |
| --- | --- | --- | --- |
| A1 | 零粘合：源是纯数据，永不执行 | loader.ts / rule-pack-importer.ts | H08.01 extensions |
| A2 | 加载全有或全无 + 回滚，重复 id 不伤旧挂载 | loader.ts | H08.01 |
| A3 | 清单边界：256KB / 每类 200 条 / 拒符号链接 / sdkApiVersion=1 | loader.ts | H08.01 |
| A4 | 贡献名全局唯一（`${kind}:${name}` 单属主） | registry.ts / adapter.ts | H08.01 |
| A5 | 插件禁用即全线 `disabled`，无残留子进程/轮询 | index.ts（enabled 门） | H08.01–04 |
| A6 | hooks 能触发 auto-verify / self-repair 且门禁命令受 exec 能力与审批约束 | builtins/auto-verify.ts、self-repair.ts | H08.02 hooks |
| A7 | 自修复有界（maxAttempts）必然终止 | builtins/self-repair.ts | H08.02 |
| A8 | reasoning_effort 档位映射与 reasoning_content 往返逐字节一致 | reasoning-bridge.ts | H08.03 providers |
| A9 | prefix-cache 命中率是请求序列的纯函数（重放同数字） | prefix-cache.ts | H08.03 |
| A10 | subagent 可用 harness 工具且不越权（槽位独占、scope 不重叠） | swarm/* | H08.04 subagents |
| A11 | 单 job 失败不连坐：捕获/重试/标记，progress 可观测 | swarm/job-runner.ts | H08.04 |
| A12 | bench 失败 case 不中止套件；回归报告字节稳定 | bench/suite.ts、report.ts | 全绿门禁 |
| A13 | 沙箱 verify 源工作区零触碰，失败回滚 | compat/sandbox-verifier.ts | H08.02 |
| A14 | 确定性：注入时钟/纯函数，重复运行同报告 | bench/*、swarm/coordinator.ts | 全绿门禁 |

回归证据（`bun test`、`check:lines`、`check:plugins`、`typecheck` 四门禁输出）写入仓库根 `H08.06-result.md`；未解释的失败为零是收口条件。
