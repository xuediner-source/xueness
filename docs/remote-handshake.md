# 远程 SSH 握手与能力协商

实验功能，默认关闭。只接受设置里的布尔值 `true`。remote 插件本身默认关闭；插件停用后 `remote_exec` 与其它远程入口一样不可用。声明为 `system=windows` 的主机仍然在批准之前、SSH 之前拒绝，探测脚本不会发到那台机器上。

开关关闭时，结果仍然只有 `ok`、`exit_code`、`output`。没有探测连接，也没有新的字段。

这里没有部署远端服务，也没有照搬上游协议名。ZCode v3.14.3（只读树 `/workspace/refs/ZCode`，`29628c9`）里对应的是：

- `harness/remote/README.md`：只是一台开了 sshd 的容器，没有握手格式。
- `packages/server/src/remote/handshake.ts`：跳过横幅，失败时带上退出码和有界的 stdout / stderr。
- `packages/server/src/remote/detectEnv.ts` 与 `ssh-backend.ts` 的 `detect`：`uname -s`、`uname -m`，以及可读时的 `/proc/sys/kernel/ostype`。`darwin` 报在 Linux 内核上时当成 `linux`。
- `packages/server/src/remote/remotePlatformSupport.ts`：Windows 远端在执行命令前拒绝。`windows_nt`、`mingw*`、`msys*`、`cygwin*` 都归一成 `win32`。
- `packages/zcode-server-cli/src/contracts.ts` 的 `controlResponseSchema` 与 `ipc/controlError.ts`：错误分成 `code`、`message`、`retryable`。

Xueness 的远程执行是「在已信任的主机上跑一段已批准的 argv」，不是启动一个远端服务进程。探测通过之后才发起第二次 SSH，操作者的命令不会写进探测脚本。一次会话里先写命令再等 hello，远程壳可以跳过等待直接执行；分开两次连接可以避免这一点。

界面开关尚未接到「设置 → 通用」。在那之前用 `POST /api/settings/general`（沿用 Host、Origin 与 CSRF）写入 `remoteHandshakeEnabled`。该请求会替换整个 `general` 段，调用方需要带上仍要保留的其它键。没有新的 HTTP 路径。

## 开关 `remote.handshake`

设置键 `general.remoteHandshakeEnabled`。缺省、`false`、`"true"`、`1` 都算关闭。设置读失败也算关闭，不会因为设置文件坏了就多开一次 SSH。

开启后的顺序：

1. 仍先拒绝 `system=windows`，并检查 argv 与连接摘要。
2. 既有 Gate 批准。没批准就不探测。
3. 第一次 SSH 只跑固定脚本，超时 15 秒。选项与正式执行相同：`BatchMode=yes`、`StrictHostKeyChecking=yes`、`ConnectTimeout=10`、不读用户 ssh 配置。本地 Windows 的 `ssh` 仍隐藏控制台，macOS 与其它系统的 creationflags 为 0。
4. 解析 `xueness-hello-begin` 与 `xueness-hello-end` 之间的三行。开始标记必须出现在前 32 行内（标记前的横幅最多 31 行），正文最多看前 64 KiB。平台、架构、内核只接受长度不超过 64 的字母、数字和 `._+/-`。
5. 协商通过后、第二次 SSH 之前，在配置锁里再读一次已保存的连接。探测期间被改掉或读失败时，沿用既有错误 `connection changed; inspect configuration again`，不发送命令。通过之后才发第二次 SSH，超时仍是 40 秒。命令仍是 `cd -- <目录> && exec <argv>`，引用方式不变。

协商结果：

| 探测 | 结果 |
| --- | --- |
| `win32` 家族 | 不发送命令。`error_code` 为 `capability_unsupported` |
| `darwin` 且内核是 `linux` | 当成 `linux`，`platformCorrected` 为 true，然后执行 |
| 其它能解析的平台 | 能力是 `posix-shell`，然后执行 |
| 没有完整帧，且退出码为 0 | `handshake_invalid`，不执行 |
| 传输失败 | 见下表，不执行 |

`failure.retryable` 只描述这次 SSH 是否值得重试。工具结果的顶层没有 `retryable`：代理循环把顶层 `retryable: false` 当成需要暂停的运行，探测失败不应该走那条暂停。

| `error_code` | `failure.retryable` | 何时 |
| --- | --- | --- |
| `capability_unsupported` | false | 探测到 Windows 壳 |
| `ssh_host_key` | false | 主机密钥校验失败 |
| `ssh_auth` | false | 认证失败 |
| `ssh_timeout` | true | 探测在 15 秒内没有结束 |
| `ssh_unavailable` | true | 拒绝连接、无法解析、没有路由等；本机没有 `ssh` 时同码但 `retryable` 为 false，文案是 `ssh client unavailable` |
| `handshake_invalid` | false | 对端把脚本跑完了，但没有可用的能力帧 |
| `handshake_closed` | 退出码 255 时为 true | 帧不完整且进程非正常结束 |
| `command_timeout` | true | 探测已通过，正式命令在 40 秒内没有结束。`executed` 为 true |

失败时 `error` 是字符串，`diagnostics.stdout` / `diagnostics.stderr` 各自最多 2048 个字符，保留尾部，去掉终端控制字符和 ANSI 颜色序列。诊断里不放 ssh 的 argv。

正式命令成功时，原有 `ok`、`exit_code`、`output` 保持原样（stdout 与 stderr 仍按原来的方式拼在一起，上限 16000）。另外有 `executed: true`、`feature` 和 `handshake`。`handshake.schema` 是 `xueness.remote-handshake.v1`。

命令行 `xueness remote exec`：探测或传输失败、以及正式命令超时，写到 stderr 并返回 1，stdout 为空。远端命令自己以非零退出时，仍把结果写到 stdout 并返回 2。

前端若要加开关，只需要在现有通用设置里保存布尔键 `remoteHandshakeEnabled`，并在工具结果里读取上面的字段。不需要新接口。
