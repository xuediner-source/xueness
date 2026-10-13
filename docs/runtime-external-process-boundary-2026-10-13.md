# 外部插件进程边界

第三方工具复用现有 MCP 插件：stdio 服务器运行在独立进程中，HTTP/SSE 服务器通过对应 MCP 传输连接。状态文件不提供 Python/Node 模块加载入口。市场继续只安装 data-only manifest，并由已有插件 SDK 校验版本、权限和原子安装/升级回滚；市场 manifest 不会下载或执行服务器代码。

## 配置身份和审批

`mcp/process_boundary.py` 对服务器公开配置计算规范化 SHA-256。`Pool` 将客户端绑定到该摘要；同一个服务器 ID 的 argv、目标 URL、认证引用或其它配置变化时，先回收旧客户端再创建新的客户端。清理旧进程树失败时拒绝替换。

会话加载时记录已发现工具所对应的配置摘要。调用前重新读取 MCP 资源；配置变更、移除或禁用时回收旧连接并要求在新运行中重新发现工具。已有逐工具调用 Gate/审批仍作用于实际调用，配置摘要本身不授予权限，也不会把旧审批悄悄指向新的服务器。

绑定 `_state_dir` 的 stdio、HTTP 和 SSE 客户端在启动、发送及收到响应的边界检查 MCP 插件开关。Pool 也比较状态目录身份，同一公开配置不能复用其它状态目录的 OAuth/开关绑定。宿主的 MCP plugin scope 在禁用或退出时关闭该状态目录的所有 Pool；其它状态目录的连接不受影响。stdio 子进程回收会终止等待；已发送的 HTTP 请求不能保证立即中断，仍受原有超时限制，返回时复查开关并拒绝继续使用响应。CLI 的一次性诊断仍用 finally 关闭客户端，run-owned MCP loader 在运行结束时 teardown。

## 资源和传输限制

stdio stdout 每行上限 1,000,000 字符，待处理队列上限 32 帧；协议帧必须为带有 `jsonrpc: "2.0"` 的对象，响应不能同时包含 result/error。非法输出、超限或错误响应关闭进程，不把服务器 stdout/stderr 内容加入诊断。stderr 按最多 4,096 字符的块读取，只保留 64 块，避免无换行日志形成无限缓冲。stdout/stdin 使用 UTF-8。

stdio 的完整请求/响应交换串行执行，避免工具调用与 catalog 请求从同一读队列取走彼此的响应。版本兼容沿用已有 MCP initialize 协商；进程创建、最小环境和进程树清理继续使用 `process_runtime`，Windows 保留 MCP 自有的挂起创建 Job Object。

## 验证与范围

`tests/test_mcp_process_boundary.py` 使用隔离状态和真实本机 fixture 子进程，验证配置替换回收、旧发现结果拒绝重定向、持久禁用、scope 状态隔离、恶意输出资源上限以及并发响应归属。没有下载第三方代码或调用真实模型。

此边界现在也承接 `extensions` 管理的源码 ZIP：本地摘要确认、签名 HTTPS 导入、不可变版本与历史回滚、默认禁用及精确权限批准已经落地；启动/调用同时验证原始 ZIP 与源码文件。ACP v1 专用适配通过可信 MCP facade 提供一次外部调用，详见 [源码包与 ACP 说明](runtime-source-packages-2026-10-13.md)。已有 data-only 市场保留原格式，不引入宿主动态 import；MCP 配置摘要与源码包内容摘要分别验证不同的事实。
