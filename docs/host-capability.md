# 宿主平台探测与一次性能力票据

实验功能，默认关闭。只接受设置里的布尔值 `true`。desktop 插件停用后，这些路由与其它桌面路由一样返回 403。不修改 `GET /api/desktop/status` 的字段，也不替换长期桌面令牌、Host/Origin 或 CSRF。

票据规则参考 ZCode v3.14.3（只读树 `/workspace/refs/ZCode`，`29628c9`）的 `packages/server/src/hostCapability.ts`：32 字节随机数、30 秒有效、只放在本进程内存、消费前先删除。过期、重放和成功都会作废，只有第一次且未过期的消费得到 `accepted: true`。这里没有照搬上游源码，也没有 WebSocket `/ws/host`。`accepted` 不等于授权：`grantsAccess` 固定为 `false`，其它路由仍只认原来的桌面令牌。

平台名走 `process_runtime.host_platform_family`，工作区选择器也走这个函数。macOS 先于 Windows 判断，避免把含有 `win` 这三个字母的 `darwin` 当成 Windows。路径是否忽略大小写走 `write_lock.host_paths_ignore_case`，与写锁同一条件。Windows 与 macOS 都忽略大小写，Linux 保持区分。

界面开关尚未接到「设置 → 通用」。在那之前用 `POST /api/settings/general`（沿用 Host、Origin 与 CSRF）写入下面的键。该请求会替换整个 `general` 段，调用方需要带上仍要保留的其它键。

## 开关 `desktop.host_capability`

设置键 `general.desktopHostCapabilityEnabled`。

开关关闭时，下面三个路径都返回 **400** `desktop.host_capability not enabled`，不创建票据、不读取数据目录。错误方法是 **405**。desktop 插件关闭是 **403**，先于本开关。

### `GET /api/desktop/host-capability`

查询本进程的平台和能力。忽略查询串里的 `platform`，不接受客户端自报的系统。

| 字段 | 含义 |
| --- | --- |
| `schema` | `xueness.host-capability.v1` |
| `feature` | `desktop.host_capability` |
| `serverId` | 本进程、本状态目录的 32 个小写十六进制字符。不落盘，进程退出即消失。不是凭据 |
| `version` | 与桌面状态里的版本相同 |
| `platform.raw` | 与 `GET /api/desktop/status` 的 `platform` 相同，例如 `darwin`、`win32`、`linux` |
| `platform.family` | `macos`、`windows`、`linux`，或其它小写平台名；空值是 `unknown` |
| `capabilities.desktopHost` | 本进程是否配置了桌面令牌，与状态里的 `desktop` 相同 |
| `capabilities.nativeDirectoryPicker` | 是否绑定了窗口所属的原生目录选择 |
| `capabilities.nativeWorkspacePicker` | `{available, platform}`。只有 `macos` 才会查找 `osascript`，不会打开对话框 |
| `capabilities.nativePermissionBridge` | 是否同时有桌面令牌和权限桥。不查询、不请求系统授权 |
| `capabilities.frozen` | 是否为冻结后端 |
| `capabilities.hostOriginCsrf` | 这条 HTTP 服务固定为 `true` |
| `capabilities.desktopContinuous` | 固定 `false`。没有桌面连续 WebSocket |
| `capabilities.websocketRpc` | 固定 `false` |
| `capabilities.processResourceTelemetry` | 固定 `false`。不要据此订阅不存在的事件 |
| `capabilities.hostCapabilityTicket` | 本开关打开时为 `true`，表示可以申请票据 |
| `capabilities.caseInsensitivePaths` | Windows 与 macOS 为 `true`，Linux 为 `false` |

响应不含 `dataDirectory`，也不含票据。`serverId` 在同一次进程里保持不变。

### `POST /api/desktop/host-capability`

申请一张票据。正文必须是空对象 `{}`。带上任何字段都是 **400**，并且不会入库。成功正文：

| 字段 | 含义 |
| --- | --- |
| `capability` | 16 到 128 个 URL 安全字符。默认是 32 字节随机数的 base64url |
| `expiresAt` | 服务器时钟的到期时刻，毫秒整数。默认签发后 30 秒 |
| `grantsAccess` | `false` |

未消费的活票据超过 128 张时返回 **429**，不淘汰尚未过期的票据。过期项在下一次签发或消费时清掉，腾出的空位可以再签发。生成器如果返回了不合规则的字符串，返回 **500**，并且不保存该值。

### `POST /api/desktop/host-capability/consume`

消费一张票据。正文 `{"capability": "<票据>"}`，或请求头 `X-Xueness-Host-Capability`，或两者完全相同。两者不一致时 **400**，并且两张都不作废。格式不对是 **400**。从未签发、已过期或已经用过都是 **401** `invalid or expired host capability`，响应里不回显票据。

成功正文只有 `schema`、`feature`、`accepted: true`、`grantsAccess: false`。没有角色字段，也不会把调用方写成受信宿主。桌面令牌仍然每个请求都要带；没有令牌时在进入本路由之前就是 403，票据不会被提前消耗。

票据只存在签发它的那个进程的内存里。另一个状态目录、另一次进程，或 stdio app-server 与 HTTP 不在同一进程时，都不能用对方的票据。关开关再打开，已经烧掉或过期的票据不会复活。

## 前端

本轮没有改 `webapp/`。需要界面时：

- 在「设置 → 通用」增加 `desktopHostCapabilityEnabled`，默认关。保存 `general` 时不要丢掉这个键。
- 开关打开后再 `GET /api/desktop/host-capability`。用 `platform.family` 区分 Windows 与 macOS，不要再各写一套 `sys.platform` 判断。`platform.raw` 仍与现在的桌面状态一致。
- 三个固定为 `false` 的能力位表示通道不存在，不要订阅。
- 申请和消费都要带 CSRF。桌面壳还要带原来的 `X-Xueness-Desktop-Token`。
- `grantsAccess: false` 时不要据此放开批准、目录或凭据。
