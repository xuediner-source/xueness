# Xueness 0.1.8 第 18 轮：请求整形与工具调用兼容

从第 17 轮完整包继续，完成引擎路线图 Z1 第 3 块。主代理确定范围与实现取舍，所有子代理使用 GPT-6-Luna / max，仅执行指定任务。实现详情见 [ts/HANDOVER.md 第 41 节](ts/HANDOVER.md)。

## 完成内容

- **工具参数与名称**：识别 BOM JSON，统一合法对象/标量的序列化，空值参数按既定规则处理；工具名称去首尾空白。空名称但有有效 ID 的客户端调用作为同 ID 的 unknown_tool 结果闭合，不中断整个模型请求。缺失/重复 ID 和不合法 envelope 仍拒绝。损坏 JSON、重复键保持原文，由普通工具参数校验返回错误，不变成可执行的空对象。
- **严格 schema**：工具显式声明 `function.strict: true` 时，仅原生 Anthropic 协议和裸 `claude-` 模型尝试转换；数值/长度等限制折入描述，嵌套 schema 递归转换。不可表达的 `$ref/$defs`、tuple、字典 schema 等回落原 schema，不发送 strict 字段；原输入和本地校验规则不改。没有默认开启所有工具。
- **system 兼容**：OpenAI-compatible 序列化时把连续开头的 system 按原序直接拼接；中间 system 不挪位。Anthropic 保留中间 system 的位置，不再统一提到开头。
- **思考历史**：带签名/脱敏思考块与来源保存在私有会话元数据里，下一次 Anthropic 请求投影时按模型和服务身份过滤；隐藏思考不自动变成正文。纯思考/尾部思考/空白消息按参考规则整理，媒体绑定边界保留。明确的签名拒绝可在未提交输出时恢复一次，删除签名块并保留已有正文，原始会话历史不被改写。HTTP 错误体只留下窄匹配的安全布尔标记。
- **工具流**：Anthropic 等到 content_block_stop 才提交工具调用；OpenAI 等到 finish_reason 才关闭工具输入。JSON 首次可解析、EOF 或单独 [DONE] 均不替代结束事件。失败前奏、未闭合工具和内部 tool_result 不执行、不泄漏到观察回调。Anthropic 支持 thinking start 签名、原生签名 delta 优先和 redacted thinking。
- **接线与归属**：主会话、子代理、工作流都连接 providers 的请求整形扩展，四项新能力登记到插件面板；实时模型切换使用即将启用的模型身份做签名过滤。

## 验证（Windows，Node v24.19.0）

- 相关回归累计 78 项，全部通过；新增 19 项聚合测试。覆盖参数/调用身份、schema、历史结构、签名、媒体、待应用模型切换、工具契约、子代理、工作流和第 17 轮重试/取消行为。
- 类型检查、插件门禁（30 插件 / 368 源文件）、行数门禁（893 个 TS 文件 / 最大 400 行）通过。后端构建 630 个 JS 模块；搬迁后运行验证通过。
- 本地 HTTP 验收源码版/构建版各 6 场景、12 次 loopback 请求，均通过；包括真实 wire 内容、工具只执行一次、签名持久化/回放/一次修复、正文后不重放及未闭合工具不执行。记录在 `验收资料/验证记录/request-shaping-windows-{source,built}-round18.json`。
- 复现：`node tools/verify-request-shaping.mjs`；先 `npm --prefix ts run build`，再运行 `node tools/verify-request-shaping.mjs --built`。

按用户要求只做相关验证，没有跑后端/前端全套。没有前端源码改动，沿用第 16 轮的 166 个 Web 构建文件；没有真实/收费模型调用，没有提交、推送或发布。安装器、Docker、CI、macOS 与真实剪贴板未在本轮验证。

完整包和相对第 17 轮的补丁包均更新文件清单；补丁覆盖同名工程目录合并。Z1 可选第 4 块（并发准入、本地调试）及之后的 Z2 回合运行时仍未完成。
