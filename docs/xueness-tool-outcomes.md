# 工具调用结果统计

更新于 2026-11-13。记录端：`providers` 插件 `ts/plugins/providers/src/tool-outcomes.ts`（功能 `providers.tool_outcomes`）；汇总与界面：`usage` 插件 `ts/plugins/usage/src/tool-outcomes.ts`、`webapp/src/plugins/usage/UsageToolOutcomes.tsx`（功能 `usage.tool_outcomes`）。

## 为什么要量

打算加入「调用前检查」和「决策模型」来减少失败的工具调用所浪费的时间。决策模型本身要花时间，还可能误拦正确的调用，所以先要知道：工具调用多常失败、为什么失败、每次失败实际多花了多少时间，以及哪些失败本可以在调用前挡下。这项统计就是做这个判断的依据。

## 记录什么

每次运行中，每个结束的工具调用都按结果里的错误代码归类：

| 分组 | 典型错误代码 | 可避免 |
| --- | --- | --- |
| 参数错误 `arguments` | `invalid_tool_arguments`、`invalid_argument` | 是 |
| 编辑未匹配 `edit_mismatch` | `edit` / `apply_patch` 的 `not_found`、`ambiguous_match`、`no_change` | 是 |
| 未知工具 `unknown_tool` | `unknown_tool`、`tool_not_active`、`not_deferred_tool` | 是 |
| 路径问题 `path` | `not_found`、`is_directory`、`file_too_large` | 是 |
| 命令写法错误 `command` | shell 无法解析的命令（例如 PowerShell 5.1 不支持 `&&`）、cmdlet 不接受的 Unix 参数（例如 PowerShell 中的 `ls -la`）、找不到程序（退出码 126/127/9009）、`command_timeout`、`command_not_found` | 是 |
| 网络错误 `network` | `network_*`、`dns_*`、`http_*`、`tls_*`、`redirect_*` | 是 |
| 命令返回非零 `command_exit` | 命令正常执行但退出码非零（例如测试仍未通过） | 否 |
| 权限与审批 `policy` | `approval_required`、`denied`、`permission_denied`、`plan_mode_denied` | 否 |
| 中断 `interrupted` | `run_paused`、`cancelled` | 否 |
| 其他 `other` | 其余代码 | 否 |

「可避免」指调用前的检查或决策模型有机会挡下的失败；权限、审批和中断不是模型的错误，单独列出但不计入。

时间分三部分：

- **失败的工具本身**：失败调用的工具执行时间，实测。
- **读错误后重新请求（估算）**：一步中有可避免的失败时，紧接着的那次模型请求要读错误再重试。把这次请求的耗时按「失败调用数 / 该步调用数」的比例算给这些失败。这是估算：同一步里成功的调用本来也需要下一次请求。
- **模型输出无法解析为工具调用**：轻量 JSON 工具模式下，模型输出不是有效的工具调用格式时，整次请求作废，实测其耗时。

每个会话在 `tool_outcomes` 里保存有上限的计数（总计、按分组、按工具、按错误代码、按模型），长会话也不会丢失早期的数据；分叉出的新会话不复制它，跨会话汇总不会重复计算。

## 在哪里看

「设置 → 用量」页最后的「工具调用」卡片：调用数、失败与可避免的比例、失败多花的时间及其三部分、按原因的分布、失败最多的工具、按模型的对比和错误代码。统计周期与页面上方的范围一致；一个会话只要在周期内有更新，就整体计入（不保存逐次调用的时间戳）。本机服务器常常不报告 Token 用量，这张卡片不依赖 Token 数据。

## 限制

- 只统计功能上线之后的运行；已有会话不回填。
- 恢复耗时是估算，工具耗时与解析修复耗时是实测。
- 只统计主会话的运行。子代理和工作流角色的运行不带 `providers` 的活动扩展，目前不记录；它们的工具调用失败不在统计里。
