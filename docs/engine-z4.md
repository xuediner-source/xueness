# Z4 执行适配与工具深度

本阶段基于 Z3，保持 Xueness 的插件、状态目录和批准流程。shell、files、network 承担产品策略，宿主连接现有执行端口。参考 ZCode v3.15.1 `aac4755666d09fdcd70272fcf063c077a639015f` 的 adapters/exec、filesystem 与 WebFetch 行为。

## 命令与初始化

Windows 默认仍使用 PowerShell；POSIX 保持原 Bash/sh 默认。选择 Bash 或 Git Bash，通过 `GET/POST /api/shell/settings` 读取或部分更新设置，保存于当前状态目录的 `shell-config.json`：

```json
{
  "shellMode": "bash",
  "shellExecutable": "C:/Program Files/Git/bin/bash.exe",
  "captureInit": true,
  "startupScript": "export PROJECT_MODE=development\n"
}
```

`shellExecutable` 留空时，Windows 只查找 Git for Windows，避开 WindowsApps 的 WSL 别名；POSIX 查找可用 Bash。切回 `system` 时同时设 `captureInit:false`、`startupScript:""`。缺少 Bash、初始化失败分别返回 `shell_not_found`、`shell_init_failed`。

保存配置、激活插件不执行脚本。第一个获准的字符串命令才读取 HOME 下 `.bashrc`，以命令工作目录和已过滤的环境生成私有快照，支持取消和超时。快照保存函数、alias、shell 选项和 PATH；shell 路径、HOME、rc 的 mtime/size 变化后重新生成。它不会跟踪 rc 间接 source 的每个文件；修改这些文件后重新保存配置或重启宿主。启动脚本按内容 hash 保存，在快照之后、每次命令之前 source。

使用初始化或启动脚本时不自动将表面上的只读命令免批，因为 alias/function/脚本可以改变命令含义。原批准规则和权限模式继续决定是否执行。主会话运行期间改变 shell 配置会取消该运行并重新装配插件；工作流 actor 在每次运行开始时读取配置。禁用或重新配置 shell 会停止其任务，清理由该实例创建的快照和启动文件。

直接 `argv` 调用不 source 初始化/启动脚本；Windows `.cmd/.bat` 走 cmd 桥接，可执行文件保持直接调用。Bash 模型工具仍使用原字符串接口。后台命令复用同一准备流程与原任务管理器，不增加隐式后台提升、粘滞 cwd 或跨宿主进程恢复。

## 文件范围与版本

`NodeWorkspaceFileSystem` 提供工作区内 stat、文本/二进制读取、行/字节范围、版本写入、删除、目录创建和带 ignore 元数据的列表。路径沿用真实工作区边界，操作接受 AbortSignal。

Read 明确给出 offset/limit 时，UTF-8 文本按块扫描，只积累选中行，正确处理 emoji、BOM 和跨块 CRLF，同时生成全文件 SHA-256 和行数。UTF-16、GBK/GB18030 保留既有解码回退；这些编码仍可能读取整份有界文件。原 256 KiB 整文件与 32 MiB 分页上限、输出 token 上限继续生效。范围读取的私有快照仍标记 range，冷恢复不会因此授予完整文件编辑依据。

Write/Edit 保持先读后改规则，原子替换前再次核验预期 SHA-256；创建新文件采用基于硬链接的原子 create-only，避免覆盖刚出现的文件；需要底层文件系统支持硬链接。已有文件的版本校验是写前的乐观检查，不能当成跨进程的事务 CAS，也不锁住外部编辑器。

只读接口：`GET /api/sessions/:id/file-bytes?path=relative.bin&offset=0&limit=4096`。返回 base64、offset、nextOffset、totalBytes、hash；默认 4096、最大 65536 字节。返回页只保留所需字节，完整 hash 仍须扫描文件。接口要求 sessions/files 均有效、会话根已获授权；远程会话返回 409。没有新增模型二进制读取工具。

## 网页抓取

WebFetch 的 HTTP 输入先升级 HTTPS；GET 最多跟随五次跳转，支持相对 Location 和查询参数。每一跳都重新校验 URL、全部 DNS 地址并固定实际连接地址，保留现有私网/FakeIP/DoH 规则及插件网络 grant。拒绝 HTTPS 降级、凭据 URL、循环和超限跳转，所有响应都关闭，共享一次抓取的超时与取消预算。搜索模型和服务的 POST 仍不跟随跳转。

成功结果首次向模型返回最多 16000 字符的提取预览，`data.fullContent` 保留 1 MiB 原响应上限内的完整提取文本，可用当前会话的 `tool_result_read` 分页读取。修复了该工具在 providers manifest 中漏登记的问题，使它在真实 PluginHost 下可用。全文不是隐藏模型总结，也不会另写任意工作区文件。

沿用 15 分钟 TTL、50 MiB 内容预算的 LRU；规范 URL 和 DoH 配置共同构成缓存键，成功项按全文字节计入预算。HTTP 升级后的等价 URL 可命中缓存，命中仍在授权后的 handler 内，禁用插件清空缓存。

network 插件发布 started/redirected/completed/failed/cache_hit 活动，同一次调用共用 requestId。sessions 将其记录为 `NetworkRequest`，纯 reducer 提供 `lastNetworkRequest`；活动仅保存 HTTPS origin 与固定状态/计数，不记录路径、query、请求头、正文或密钥。既有会话事件接口继续可用。

## 验证范围

实测平台为 Windows / Node 24.19，Bash 为本机 Git for Windows。定向回归覆盖文件/编码/新鲜度、真实命令与后台、重定向/缓存/取消及宿主接线；类型、插件、行数门禁及后端构建/搬迁检查完成后记录在工作总结。

`node tools/verify-z4-runtime.mjs` 和 `--built` 使用真实 ApplicationApi/FrontDoor、隔离状态、Git Bash 子进程、可控 Net 和 loopback 模型 fixture：保存配置不执行、获批后初始化、范围 Read、字节 API/插件开关、逐跳抓取、缓存、全文分页和持久活动。没有公网抓取或真实/收费模型调用。Linux/macOS 原生未实测，本机 Docker daemon 未运行；未为测试安装或启动系统服务。Web 源码不变，沿用并核验 Z3 的 166 个 dist 文件。

Z4 指上述适配实现完成；后续 Z5–Z8 仍包括 MCP/配置/hooks、动态工作流、外部协议及其它差异，整个引擎尚未完成。
