# Xueness 开发与构建

每项用户功能都由插件提供，在功能插件面板中显示归属。后端位于 `ts/plugins/<id>/`，前端位于 `webapp/src/plugins/<id>/`；同步登记 catalog、manifest 的功能、模块、依赖、工具及面板。容器只协调状态、布局与挂载。

共享基础设施包括存储与 journal、租约与写锁、工具注册和分派、权限与审批协议、通用预算、插件管理、HTTP 安全和基础 UI。新增业务不能借基础设施名义放入主服务器、CLI 或 Agent 内核。确需新增共享接缝时，说明理由并更新架构说明。

插件必须通过构建 allowlist 加载；状态、目录和资源清单不能引入可执行代码。能力只有在所属插件及依赖 effective 时生效；禁用后停止新的请求、轮询、子进程和任务。HTTP/CLI 必须绑定当前状态目录，不能绕过持久插件开关。

权限模式以 [权限说明](docs/xueness-permission-modes.md) 和当前实现为准。完全访问跳过应用内审批与工作区路径限制；插件生命周期、HTTP 身份、系统权限和工具数据完整性仍独立生效。文件修改保留编码、版本检查和原子写入。

保留用户未提交更改、会话、工作区、模型设置和账户配置。验证使用隔离数据。没有当前任务授权时不提交、推送、发布、发送消息或使用收费模型。不要把测试夹具统计冒充真实模型性能。

生产文件默认不超过 400 有效行；已有前端例外按登记上限只减不增。不要扩大白名单来绕过功能归属或行数门禁。Windows/macOS/Linux 的命令、终端与路径差异留在对应插件或既有平台基础设施；子进程取消和超时继续回收所属进程树。

公开仓库提供应用、构建和使用所需文件。单元测试、测试 CI、浏览器回归、验收与压测证据位于 [私有验证库](https://github.com/xuediner-source/xueness-private-tests)。在该库的源码副本恢复测试镜像，按改动运行相关回归；使用其 README 中的命令，不向公开工作树重新添加测试材料。

公开工作树的构建检查：

```sh
npm ci --prefix ts
npm ci --prefix webapp
npm --prefix ts run check
npm --prefix webapp run typecheck
npm --prefix webapp run build
npm --prefix ts run build
```

前端构建会更新可选插件资源 pin，随后再构建 TypeScript 后端。桌面打包依照 `desktop/package.json` 的平台命令执行；保留原生构建架构检查和安装包校验和生成。测试与界面复核依改动范围和当前用户要求执行，不默认重复整套测试。
