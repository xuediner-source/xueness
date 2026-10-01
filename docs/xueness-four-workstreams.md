# 四项功能交付与使用说明（2026-09-30）

本轮范围：CLI 会话/模型、工具与长任务、工作流、辅助 Web；包含用户追加的交互式终端、Office/多媒体预览和国际化。这是 Xueness 本地功能实现，不表示与 ZCode 全部功能或协议一模一样。插件拆分仍是下一阶段。

## 1. CLI 会话和模型

```sh
./bin/xueness sessions list --root /absolute/workspace --search 关键词
./bin/xueness chat --select --root /absolute/workspace
./bin/xueness sessions rename SESSION_ID '新标题'
./bin/xueness sessions pin SESSION_ID
./bin/xueness sessions unpin SESSION_ID
./bin/xueness sessions archive SESSION_ID
./bin/xueness sessions list --archived
./bin/xueness sessions restore SESSION_ID

# 密钥事先放在指定环境变量里，不写进 argv，也不会回显。
./bin/xueness providers save personal --name Personal --base-url https://your-gateway.example/v1 --model your-model --key-env PERSONAL_MODEL_KEY
./bin/xueness providers list
./bin/xueness chat --root /absolute/workspace --provider-id personal --model another-model
```

会话内 `/models` 列出配置，`/model ID [MODEL]` 切换，`/model env` 使用环境配置。保存的模型选择随会话恢复。第二十三批起仅提供配置模型入口，公开离线执行已移除；当前开始界面和运行说明见 [对话开始界面说明](xueness-start-interface.md)。

同一会话由 CLI 或 Web 运行时持有跨进程独占锁；另一个进程不能同时覆盖记录。交互式 chat 在打开期间持有锁；退出后可在 Web 操作。归档保留工作区和审计记录。

实现：`operator_cli.py`、`provider_config.py`、`session_lease.py`、`cli.py`。

## 2. 工具和长任务

```sh
# 只注入技能目录；正文通过 skill_read 工具按需读取。
./bin/xueness chat --root /absolute/workspace --skill-catalog
# 原先的完整短正文注入仍可用。
./bin/xueness chat --root /absolute/workspace --inject-skills
./bin/xueness mcp-check SERVER_ID --root /absolute/workspace

# 参数按 argv 执行，不隐式拼接 shell；需要 shell 时显式传 sh -c。
./bin/xueness jobs start --root /absolute/workspace --timeout 300 --approve -- python3 -c 'print("background")'
./bin/xueness jobs list
./bin/xueness jobs show WORKFLOW_ID
./bin/xueness jobs logs WORKFLOW_ID
./bin/xueness jobs cancel WORKFLOW_ID
./bin/xueness jobs wait WORKFLOW_ID --timeout 60
```

后台进程独立于 CLI 请求存活；输出最多落盘 2 MB、读取尾部 16 KB；取消/超时终止命令进程组。普通 Agent 的 `--max-wall-seconds` 是协作式时间预算，在调用边界停止，不会强行截断网络请求。子任务进度可在 Web 工作流面板查看，最近 100 项完成元数据随会话保存；父任务停止会传播到子任务边界。

MCP 保留 stdio，增加 Streamable HTTP 的 JSON/SSE 响应、会话头、版本协商与工具目录分页。资源配置示例：

```json
{
  "id": "remote",
  "enabled": true,
  "transport": "http",
  "url": "https://your-mcp.example/mcp",
  "headersEnv": {"Authorization": "MY_MCP_AUTH"}
}
```

`MY_MCP_AUTH` 是服务端环境变量名，其内容应包含完整认证头值（例如 Bearer 前缀）。诊断会显式连接；配置保存本身不连接。仅允许 HTTPS，测试用字面 loopback IP 可显式 `allowLoopbackHttp: true`。禁止携认证信息重定向。此传输不包含 OAuth、旧版 SSE 发现、自动重连或调用重放。

技能目录与按需读取都只取当前启用的资源；正文有预算并标记为不可信参考。按需读取结果会作为工具结果进入 journal。`--disallow-tools skill_read` 或 `read` 可拒绝读取。

## 3. 持久化 DAG 工作流

将计划保存为 JSON：

```json
{
  "name": "检查与构建",
  "concurrency": 2,
  "nodes": [
    {"id": "check", "kind": "command", "argv": ["python3", "-m", "unittest", "discover", "-s", "tests"], "timeout": 300},
    {"id": "build", "needs": ["check"], "kind": "command", "argv": ["npm", "--prefix", "webapp", "run", "build"], "timeout": 300}
  ]
}
```

```sh
./bin/xueness workflow create plan.json --root /absolute/workspace
./bin/xueness workflow show WORKFLOW_ID
./bin/xueness workflow start WORKFLOW_ID --approve
./bin/xueness workflow concurrency WORKFLOW_ID 4
./bin/xueness workflow pause WORKFLOW_ID
./bin/xueness workflow resume WORKFLOW_ID --approve
./bin/xueness workflow cancel WORKFLOW_ID
./bin/xueness workflow logs WORKFLOW_ID NODE_ID
./bin/xueness workflow recover WORKFLOW_ID
./bin/xueness workflow create revised-plan.json --root /absolute/workspace --reuse WORKFLOW_ID
```

- 节点最多 64 个，并发 1..8；检查重复 ID、缺失依赖、循环、目录越界和参数类型。
- 每个运行独立持久化状态、尝试次数、事件和日志；独占 owner 防止双重运行。
- 暂停停止调度新节点，已开始节点继续完成；取消终止活动命令；降低并发不杀已经运行的节点。
- 同一工作区或上下级目录的命令串行；互不包含的 `cwd` 可并行。该约束是协作锁，不是 OS 沙箱；显式命令仍可访问其进程权限允许的其他路径。锁不覆盖用户手动操作、交互式终端或所有其他 CLI。
- 恢复保留已完成节点，不自动重放；失联运行必须先 recover，再显式批准重试未完成节点。崩溃前可能已产生外部效果，需要检查后决定是否重试。
- 显式复用仅限同一 root、已结束运行、完全相同的已完成节点，且所有依赖也可复用；改动向下游失效传播。不会校验外部文件是否被用户随后修改；需要重新验证时不使用 `--reuse`。
- `kind: "agent"` 节点使用 `prompt` 和可选 `provider_id`/`model`，保持只读；真实模型需 `--allow-real`（Web 需服务器启用）。依赖的简短结果作为有界、不可信上下文传入。公开 `fake` 节点选项已移除，测试通过内部 Provider 注入验证。

实现：`workflows.py`、`workflow_worker.py`、`workflow_cli.py`、`operations_api.py`。

## 4. Web 工作台与扩展界面

```sh
cd webapp
npm run typecheck
npm test
npm run build
cd ..
python3 -m xueness.web --port 8137
```

模型配置、工作流入口在侧栏底部；会话右上角视图选择器包含文件、能力、工作流和终端。

- 模型页可新增、编辑、选择供应商配置；密钥不回显，空值保留旧密钥；可切回环境模型。真实运行仍需服务器 `--allow-real-provider`。
- 工作流页支持 JSON 计划创建、完整计划审阅、执行、暂停、取消、恢复、复用、动态并发、节点日志、事件和子任务进度；后台单命令也走同一引擎。
- 能力页可编辑 MCP transport、command、args、URL、环境认证映射，并连接诊断；技能/命令编辑加载完整正文，子代理可编辑名称与指令。
- 交互式终端使用真实 PTY + xterm，支持交互输入、Ctrl+C、尺寸调整、滚动输出和同一会话重连。最多 4 个；显式关闭或服务器关闭时清理。重启服务器后不恢复终端；后台持久任务请用 jobs/workflow。空闲 30 分钟的终端在下次新建终端时回收。仅支持当前 POSIX 平台（macOS/Linux）。
- Office：DOCX 段落/表格、XLSX 单元格/缓存值、PPTX 幻灯片文字，均为只读内容预览；不保留完整排版，不运行宏/公式。压缩文件、XML 与输出均有上限。PDF、图片、音频、视频继续使用已有有界预览和浏览器原生支持的格式。
- 原生工作台可实时中英文切换，偏好保存在浏览器；切换不刷新页面、不清空草稿。用户任务、模型回答、文件正文和远端错误不自动翻译；legacy 对照壳保留其自身行为。

## 验收

测试入口：`python3 -m unittest discover -s tests -v`；`npm --prefix webapp test`（现在统一运行原生 TS/TSX 和 UI primitives 测试）；`npm --prefix webapp run typecheck`；`npm --prefix webapp run build`。

新增 `tests/test_workflows.py`、`tests/test_extended_operations.py`、`webapp/src/i18n.test.tsx`；覆盖真实命令失败后续跑、复用失效、并发增减/暂停、同目录串行、不同目录并行、终止、超时、只读 Agent 节点、模型实际 HTTP 请求、MCP JSON/SSE、PTY 输入/Ctrl+C/清理、Office 边界、技能按需加载及拒绝。

本轮浏览器实测在一次性 `/tmp` 工作区进行：中英文切换保留草稿 → DOCX 预览 → PTY 输入/关闭 → DAG 创建/批准/完成/日志，0 页面错误。未调用付费模型、未发布远端服务，未重新部署现有容器。

最终验收：Python 全量 **867/867**；原生前端 **219/219**；TypeScript 类型检查、Vite 构建、两个 golden 协议校验通过。补充工作流定向 **10/10** 验证运行中把并发从 3 降为 1 时，3 个活动节点继续完成；浏览器另验证模型保存/选择、默认后台命令、语言偏好重载、技能正文编辑保留及 MCP 工作区默认值。
