# 归档会话管理与侧栏对齐

「任务」菜单中的「已归档」现在为每条记录提供「恢复」和垃圾桶按钮。垃圾桶先打开带会话名称的「永久删除归档会话？」确认框；取消、Esc 或点遮罩都不会发出删除请求。确认后删除该归档会话 journal 及其 `.json.bak` 恢复副本，不再提供恢复；工作区文件和运行诊断证据保留。删除失败会保留记录及错误提示，可取消后刷新列表再操作。恢复仍将会话放回任务列表。

能力归属已有 `sessions` 插件，新增稳定功能 ID `sessions.archived_delete`。`ArchivedSessions.tsx` 持有加载、恢复、确认、删除及卸载取消；容器只负责挂载和刷新活动列表。禁用 sessions 后不挂载、不发请求，后端所有相关路由沿用插件门禁、Host/Origin 与 CSRF 校验。

- `GET /api/sessions/archived` 为每条记录增加 `revision`（已归档 journal 原始字节的 SHA-256）。
- `DELETE /api/sessions/archived/<sid>` 必须提交 `{confirmed:true, expectedRevision:<revision>}`，成功返回 `{id, deleted:true, permanent:true}`。使用和恢复相同的运行租约，以及 live/archive journal 写锁。恢复后重新归档或归档记录变化时，旧确认返回 409；运行中、跨窗口占用、live 文件冲突均拒绝。404 表示记录已不在归档中。删除不自动重试。
- 原有 `DELETE /api/sessions/<sid>` 保持可恢复的归档语义；活动会话不能通过永久删除路由删除。只删除已校验的单个 journal 及固定名称恢复副本，拒绝无效 ID、身份不匹配、符号链接和 Windows junction/reparse point。先删副本、后删主归档，清理失败仍保留可见归档供重试；不递归删除工作区、状态目录或锁文件。

侧栏快捷动作图标改为固定尺寸并在行内居中，文字和快捷键使用一致的行框，长名称省略且不挤压快捷键。经典与 Claudex 外观均生效，行高支持用户大字号设置；只调整展示，快捷键绑定不变。

验收使用隔离会话和 `allow_real=False`，不删除用户现有归档，不调用收费模型。回归覆盖确认、版本冲突、恢复、跨进程锁、插件开关、CSRF/Origin、备份清理失败及路径重定向；最新构建还核验桌面、窄屏、主题和键盘焦点。
