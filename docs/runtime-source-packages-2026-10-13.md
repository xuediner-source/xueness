# 外部源码包与 ACP 适配

第 4 阶段增加实际源码包管理。功能分别归属 `extensions.source_packages`、`extensions.publisher_trust`、`mcp.managed_packages` 和 `mcp.acp_agents`，设置里的完整插件目录会显示这些子功能。入口为 `extension-package` CLI 和 `/api/plugins/packages`；市场已有 data-only 清单仍保留原格式。

## 包格式与审查

源码包是 ZIP，根目录必须包含下面的闭合描述文件 `xueness-package.json`。支持 Python 和 Node；ACP 包把 transport 改成 `acp-stdio`。

```json
{
  "apiVersion": 1,
  "id": "example-tool",
  "version": "1.0.0",
  "transport": "mcp-stdio",
  "runtime": "python",
  "entrypoint": "src/server.py",
  "capabilities": ["command"]
}
```

ZIP 不得包含穿越、绝对路径、链接、特殊文件、设备名、重复/大小写碰撞路径或加密条目。归档上限 32 MiB、单文件 8 MiB、展开合计 64 MiB、最多 512 个条目；HTTPS 下载上限 16 MiB。安装器不运行安装脚本或依赖管理器，包的依赖须事先准备或随源码包提供。

```powershell
python -m xueness --state PATH extension-package review package.zip
python -m xueness --state PATH extension-package install package.zip --sha256 SHA256
python -m xueness --state PATH extension-package enable example-tool --sha256 SHA256 --grant command
python -m xueness --state PATH mcp list
```

review 只读取/审查源码；install 只安装字节且默认禁用。enable 需要与已审查 ZIP 完全一致的 SHA-256，且 `--grant` 集合恰好等于声明 capabilities。运行还需显式 MCP 连接/`--allow-mcp`，工具仍经过逐调用 Gate。声明权限用于批准实际外部代码执行，并非操作系统沙箱；外部进程不能作为可信宿主插件 import。

## 来源签名与 HTTPS

本地 ZIP 使用操作员明确确认的 SHA-256。HTTPS 导入额外强制已信任发布者的 detached Ed25519 签名，并复用 network 的 HTTPS/public-IP pinned transport；不追踪重定向、不接受查询凭据、私网地址或 HTTP URL。HTTP API 只接受签名 HTTPS 导入，不能读取请求指定的任意本地路径。

先用 `extension-package trust-key ID --public-key BASE64 --fingerprint SHA256` 独立确认发布者公钥；不会自动相信 ZIP 或下载源携带的公钥。签名文件形状为 `{"keyId":"ID","signature":"BASE64"}`，签名消息是 `b"Xueness external package v1\0" + archive_sha256_ascii`。verify 使用 [cryptography 的 Ed25519 API](https://cryptography.io/en/latest/hazmat/primitives/asymmetric/ed25519/)，无自实现密码算法；验证库不可用时签名包被拒绝。

```powershell
python -m xueness --state PATH extension-package install https://example.org/tool.zip --sha256 SHA256 --signature signature.json
python -m xueness --state PATH extension-package revoke-key PUBLISHER_ID
```

每次启动/调用复查发布者与签名；撤销会回收对应发布者的运行连接。发布构建依赖已声明 cryptography 50.0.2。新版本已移除 macOS Intel wheel，Intel 发布需源码构建和原生检查，依据 [官方 changelog](https://cryptography.io/en/latest/changelog/)；本轮没有安装新依赖或声称完成发行包验证。

## 升级、回滚和完整性

每个版本存于 `<state>/external-packages/<id>/versions/<version>/<sha256>/`，包含原始 ZIP、源码和每文件收据。验证时重新核对 ZIP 摘要、安全解析结果、收据及实际源码，不能仅修改源码和收据绕过原始 ZIP 的绑定。只有小型 current pointer 原子切换，历史版本继续保留。

```powershell
python -m xueness --state PATH extension-package upgrade next.zip --sha256 NEXT_SHA256
python -m xueness --state PATH extension-package show example-tool --sha256 PREVIOUS_SHA256
python -m xueness --state PATH extension-package rollback example-tool --sha256 PREVIOUS_SHA256
python -m xueness --state PATH extension-package disable example-tool --sha256 CURRENT_SHA256
python -m xueness --state PATH extension-package uninstall example-tool
```

安装、升级和回滚都清空启用状态及 grants，需重新审查启用。切换前回收旧连接，清理失败时拒绝变更；旧发现结果与审批不会指向新包。禁用/卸载允许源码损坏时恢复，仅去激活指针，保留历史，不递归删除用户路径。包的完整性错误在列表中安全显示，健康包继续可用；危险链接和损坏指针仍拒绝。

## ACP v1

`acp-stdio` 包经可信 MCP facade 暴露一个 `agent_prompt` 操作。适配器执行 ACP v1 initialize → session/new → session/prompt，仅汇总助手文本。session/request_permission 固定返回取消，文件系统/终端客户端服务固定拒绝；不会替换宿主现有只读 task。DSH 的 ACP 路径以本地 `deepseek-harness/packages/subagent/subagent-acp/src/run.ts` 为协议参考，没有启动真实 DSH 或收费模型。

请求有帧、总输出、队列及时间限制；取消后复用 process_runtime 清理，Windows 额外使用 Job Object。POSIX 共用 helper 校验实际 SID/PGID，并在 TERM 宽限期及组 KILL 完成前锁住 Popen 的 wait/poll、保留未回收 leader，避免接受 TERM 的主进程先退出后留下忽略 TERM 的后代。锁竞争或组信号失败返回清理失败，ACP 不在已回收 PID 上再发送信号。真实忽略 TERM 后代回归只在 POSIX 主机运行，本轮 Windows 明确跳过，尚未完成 macOS 原生验证。源码 Python 忽略环境 Python 配置/user site 并禁写 pycache；Node 由操作员已安装运行时或桌面宿主提供。冻结 backend 的 ACP worker 入口已登记，原生安装包仍属后续阶段。

## 验证

隔离状态和真实 fixture 子进程覆盖：ZIP/权限/完整性/回滚边界、签名与撤销、MCP 源码包发现与调用、升级/禁用即时回收、ACP 权限拒绝与取消、CLI 接入和签名 HTTPS API。下载测试使用有界 fixture/mock，不下载或执行真实第三方代码；协议验证不代表真实外部 Agent 的模型效果。
