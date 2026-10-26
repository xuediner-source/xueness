# Xueness 0.2.1 Windows 安装与全链路回归（2026-10-26）

该版本来自 `Xueness-0.2.1-complete-20261026.tar.gz`，包含 35 个 bundled plugins，已在 Windows 正式安装路径构建、覆盖并验收。

## 全量结果

`npm --prefix ts run check` 退出码 0：**2,390 项，2,328 通过，0 失败，62 项既有跳过**。原先 17 项失败及订阅套件清理异常全部通过；既有跳过的名称和数量未变。新增真实 SSH 转发进程退出与订阅 worker 退出回归。行数、插件结构和 TypeScript 类型门禁通过。

安装后 API smoke、13 组桌面交互（21 个设置页）通过，HTTP 4xx/5xx 与未处理页面/console error 均为 0。覆盖期间 2,467 个用户文件逐字节不变；2,549 个后端文件哈希与新包一致。正式桌面 UI 经本地 Bonsai `qwen3.8-27b` 获得指定回复并核验 journal；这是连通性验证，不是模型性能基准。

## 本次修复

- 补齐后端锁文件工作区登记和插件 catalog v1 字段，结构门禁同时校验分发目录。
- 修复 Node 持久 REPL 动态导入、Windows 会话迁移边界和 HTTP 半截请求超时回包。
- 修复待审批答复被在途 run 回执阻塞，恢复取消传播设置入口并校正百分比/停止原因显示。
- Harness 的测试文件系统使用本机路径；NTFS junction 与 POSIX symlink 均验证链接拒绝，导入器明确拒绝链接文件槽。
- OAuth 在 Windows 核验真实受保护 DACL，POSIX 保持 0600 检查。
- MCP 与 SSH 验证真实 PID 退出，SSH 合成 child 使用配套生命周期，防止合成 PID 进入系统终止器。
- 订阅 worker 的关闭可等待真实进程及句柄释放，并覆盖正在退休的 worker。
- Shell 从实际后台输出等待启动标记；native_ops 等待真实 spawn 事件后验证禁用取消。

## 证据与复现

- [后端全量日志](验收资料/20261026-windows-regression/full-backend.txt)
- [原 17 项逐项核验](验收资料/20261026-windows-regression/full-backend-result.json)
- [正式安装 UI 记录](验收资料/20261026-windows-regression/installed-ui-result.json)
- [正式安装 API smoke](验收资料/20261026-windows-regression/installed-api-smoke.json)
- [真实本地模型调用](验收资料/20261026-windows-regression/installed-real-model-result.json)
- [安装哈希验证](验收资料/20261026-windows-regression/installed-backend-result.json)
- [本轮回归修复源码哈希](验收资料/20261026-windows-regression/regression-changes.json)

```sh
npm --prefix ts ci
npm --prefix ts run check
npm --prefix webapp ci
npm --prefix webapp run typecheck
npm --prefix webapp run build
npm --prefix ts run build
```

桌面 UI 复现脚本在证据目录中。运行 `desktop-e2e.mjs <Xueness.exe>` 使用独立数据和 loopback fixture；真实模型脚本另外要求 `XUENESS_ACCEPTANCE_PROVIDER_FILE` 指向本机隔离的本地提供者配置。未上传用户会话、模型密钥、登录状态、测试浏览器 profile 或安装目录备份。

前端 1,735 项通过、桌面宿主 113 项通过/6 项既有跳过来自本次前端/宿主修复后的先前验证；本轮后端修复后重新执行上述后端全量、安装 API、13 组 UI 及真实本地模型调用。其余云端提供者和跨平台机器没有在这次 Windows 本机实测中覆盖。

原始输入压缩包 SHA-256：`35bc57dc37d1912d6bff9dd0b85546b3667ba16cc4e94f32b031bd6ec358c206`。
