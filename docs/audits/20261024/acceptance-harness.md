# 对照验收入口（F00.04 acceptance harness）

日期：2026-10-24（F00.04 建立）。维护者：对齐主线（F01–F14 各轮验收时追加结果，不重写本入口）。

## 这是什么

一批**离线可复现的边界样本** + **统一结果记录格式**，让后续轮次按[公共能力契约表](public-capability-contracts.md)（47 行，F00.03）的 invariant 逐行验收，而不是用 fixture 数量、文件数或 LOC 冒充对齐。

- 样本目录（机器可读）：[acceptance-harness/samples.json](acceptance-harness/samples.json)
- 结果记录格式：[acceptance-harness/acceptance-result.schema.json](acceptance-harness/acceptance-result.schema.json)
- 可执行脚本：[acceptance-harness/scripts/](acceptance-harness/scripts/)
- 本轮记录：[acceptance-harness/results/2026-10-24-f00.04.json](acceptance-harness/results/2026-10-24-f00.04.json)

两条铁律：

1. **verdict 只以 invariant 是否成立为准**。复现已知断线（如 C-TOOL-03 的 tool_search）记 `fail`——这是 harness 的成功、契约的失败，两者都如实记录，绝不把「复现成功」写成「接通」。
2. **样本数不是成功率**。记录与批次文件禁止携带 successRate/passRate/coverage 等聚合率字段（`check-results.ts` 直接拒绝）。

## 如何跑

前置：`npm --prefix ts ci`（workspace 依赖已安装）。全部脚本在隔离进程内直接 import 生产源码模块——无服务器、无模型、临时状态目录、不动用户状态。

```sh
# 工具事件：C-TOOL-03 / C-TOOL-05 断线复现（S-TOOL-03A / S-TOOL-05A）
node docs/audits/20261024/acceptance-harness/scripts/repro-tool-search.ts

# 模型流：C-MDL-02 取消不重试 / 已提交不重播 / 分类退避（S-MDL-02A / S-MDL-02B / S-FAIL-01）
node docs/audits/20261024/acceptance-harness/scripts/repro-model-stream.ts

# 恢复：C-WFL-05 跨进程租约探针（S-WFL-05A）
node docs/audits/20261024/acceptance-harness/scripts/probe-lease-drain.ts

# 校验结果记录文件（结构/引用/词表/无成功率字段/费用授权规则）
node docs/audits/20261024/acceptance-harness/scripts/check-results.ts \
  docs/audits/20261024/acceptance-harness/results/<file>.json
```

**退出码语义**：0 = 复现/验证了样本定义的边界形状；1 = 边界形状发生变化（对 gap 行意味着实现动了、契约状态需重估；对 pass 行意味着回归）。每条脚本末尾同时打印 `[HARNESS]`（复现是否成功）与 `[CONTRACT]`（invariant 今日结论）——**退出码 0 不是契约通过**。

同形状的既有回归（跑全量时自然覆盖，单点复现用上面的脚本）：`ts/packages/agent/test/model-retry.test.ts`、`ts/packages/agent/test/lifecycle.test.ts`、`ts/packages/agent/test/stream-boundary.test.ts`、`ts/packages/agent/test/runner-lease.test.ts`、`ts/plugins/providers/test/runtime.test.ts`、`ts/plugins/workflows/test/dynamic-runs.test.ts`。

## 如何记录

每轮验收产出 `results/<date>-<round>.json`，格式见 schema。最小示例：

```json
{
  "schema": "xueness.acceptance-results.v1",
  "round": "F02.02",
  "recordedAt": "…ISO-8601…",
  "recordedBy": "…",
  "records": [
    {
      "sampleId": "S-TOOL-03A",
      "contractId": "C-TOOL-03",
      "mode": "offline",
      "verdict": "pass",
      "verdictBasis": "『模型可用一个通用搜索工具按 query 检索…』——执行器已注册且按 query 返回启用插件引用",
      "evidence": { "command": "node docs/…/repro-tool-search.ts", "exitCode": 1, "keyOutput": ["…"], "sourceAnchors": ["…"] },
      "recordedAt": "…"
    }
  ]
}
```

规则：

| 规则 | 说明 |
| --- | --- |
| 一条 record 回填一个契约行 | 样本覆盖多行契约时拆多条 record（`contractId` 单值） |
| verdict 词表 | `pass`（invariant 成立）/ `fail`（invariant 被违反，含复现已知缺口）/ `blocked`（已定义未执行，必填 `blocker`）/ `not_run`（推迟，必填 `blocker`） |
| 引用完整性 | `contractId` 必须在契约表 47 行内，`sampleId` 必须在 samples.json 内（checker 强制） |
| 新增样本 | 修改后续轮次行为时先在 samples.json 登记样本（含 invariant 原文引用），再跑再记；不登记样本的散测不算本 harness 验收 |
| fail → pass | 只有重跑样本且新证据成立才可翻 verdict；实现改动使脚本 exit 1 时先重估样本与契约状态 |
| 不聚合 | 任何文件不得出现成功率/覆盖率/完成度百分比；汇总只允许「N 条记录、X pass / Y fail」这样的分类计数 |

校验：`node docs/audits/20261024/acceptance-harness/scripts/check-results.ts <files…>`。该校验器做结构/词表/引用/费用授权/无聚合率检查，**不是**完整 JSON Schema 引擎，也不判断证据真伪——证据真伪由评审与源码锚点负责。

## 真实模型验证（单列；默认不调用）

涉及真实收费模型的验证**只**通过 `mode: "live_model"` 的样本与记录进行，与离线样本分开存放、分开判定：

- **本轮状态**：无用户费用授权，F00.04 未做任何真实模型调用；唯二 live_model 样本（S-MDL-01L、S-MDL-02L）verdict 均为 `not_run` 并记录 blocker。
- **授权后怎么跑**：用户在本对话明确授权（记录 `costAuth.authorizedBy` 与 `grantRef`）→ 在隔离状态目录配置测试账号/端点 → 按 samples.json 中 live_pending 样本的 steps 执行 → 记录 trace/事件与 `costAuth.cost`（token 与费用原值；未知就整体省略，不得虚构）。
- **checker 强制**：`mode=live_model` 且 verdict 为 pass/fail 的记录必须 `costAuth.authorized=true`，否则文件整体判 INVALID。
- **建议场景**（未来轮次，均需先登记样本）：C-MDL-01 逐协议逐字段规范化对照；C-MDL-02 真实流取消与断连（需可控断连代理）；F14.02 的代表性真实任务（编辑/长任务/并发子代理/工作流/MCP）。
- **fixture ≠ 性能**：离线脚本与 fixture 回放永不记为真实模型性能或成功率证据。

## F01–F14 如何引用（对照口径）

1. 契约表每行的 `acceptanceRound` 指到轮次（如 C-TOOL-03 → F02.02）。
2. 该轮次动工前先跑对应该行的样本（samples.json 按 `contractIds` 反查），得到今日 verdict 基线；动工后重跑，产生该轮 `results/<date>-<round>.json`。
3. 轮次结案时：样本 verdict 变化写进轮次 result 文档；契约表本身不重写——后续轮次在 F14.05 收口时按累计记录统一回填。
4. 新契约行为（新增能力）按上表「新增样本」规则先登记再验收。

## 本轮（F00.04）登记的样本一览

| sampleId | 类别 | 契约行 | mode | 今日 verdict |
| --- | --- | --- | --- | --- |
| S-TOOL-03A | 工具事件 | C-TOOL-03 | offline | fail（复现 R01 断线，复现≠接通） |
| S-TOOL-05A | 工具事件 | C-TOOL-05 | offline | fail（生产者缺失；消费侧完好） |
| S-MDL-02A | 模型流 | C-MDL-02 | offline | pass |
| S-MDL-02B | 模型流 | C-MDL-02 | offline | pass |
| S-FAIL-01 | 故障 | C-MDL-02 | offline | pass（另登记 C-TOOL-06 挂点） |
| S-WFL-05A | 恢复 | C-WFL-05 | offline | pass（限离线可探针子句） |
| S-WFL-05B | 恢复 | C-WFL-05 | offline | blocked（探针设计稿；F03.06） |
| S-MDL-01L | 模型流 | C-MDL-01 | live_model | not_run（无费用授权） |
| S-MDL-02L | 模型流 | C-MDL-02 | live_model | not_run（无费用授权） |

其余 38 行 gap/unverified 契约的验收挂钩：按契约表 `acceptanceRound` 指针在各自轮次登记样本后验收，本入口不预置空壳 fixture。
