# 新增功能的插件开发流程

Xueness 的固定开发规则是：**每项产品功能归属于插件，并在插件面板中显示；之后添加功能也遵守这一规则。** 相关功能可以扩展已有插件，无需为每个函数创建一个包。独立领域应建立独立插件。

## 实现和登记

后端业务实现放在 `xueness/bundled_plugins/<id>/`，入口 `plugin.py` 贡献 `register_cli`、`execute_cli`、`dispatch`、`tools` 或运行能力；主入口只负责统一分发。工具采用 `BuiltinTool`，批准 subject 与实际 Gate 检查共用同一规范化值。新的前端实现放在 `webapp/src/plugins/<id>/`，通过静态注册表和 `effective` 状态挂载。

每次新增用户能力，必须在所属 `manifest.json` 追加功能条目。例如，下面是功能登记示例，并非额外的运行入口：

```json
{
  "features": [
    {"id": "sessions.fork", "name": "历史分叉", "nameEn": "History forks"}
  ],
  "modules": ["forking"],
  "frontendModules": ["plugins/sessions/ForkSessionDialog.tsx"]
}
```

`modules` 列出包内全部实际 Python 业务模块，排除入口 `plugin.py` 和 `__init__.py`；嵌套模块使用点分隔名称。`frontendModules` 路径相对于 `webapp/src/`。历史跨插件纯展示文件可使用 `XuenessPanels.tsx#DirectoryBrowser` 指定导出归属；新业务组件应使用插件目录。

创建新插件时，还需登记后端 `PLUGIN_IDS`、前端 `XUENESS_PLUGIN_REGISTRY`、依赖、真实工具/命令/面板/资源，并更新 [架构功能清单](docs/xueness-plugin-architecture.md)。共享 `capabilities` 面板可由多个资源插件贡献，实际工具、CLI 命令和子功能 ID 不能重复归属。没有单独 Web 面板的 CLI/工具插件，也必须出现在完整 catalog 中。通常从「设置 → 插件」进入；settings 关闭时从账户菜单中的「插件管理」进入，全部插件关闭后仍能查看及恢复。

## 禁用与资源释放

检查前端挂载和 effect、服务端工具/CLI/HTTP 的实际生效状态。组合界面须逐项检查所有参与插件；例如关闭 diagnostics 应停止本机资源采样，不能连带停用独立 providers 功能。禁用依赖只阻塞依赖者，不自动改写开关。

轮询、子进程、连接和后台任务必须有明确停止与卸载路径；禁用后不启动新工作。正在发生的外部副作用不会因禁用而自动撤回。运行入口和直接工具调用必须绑定相同状态目录，不能通过未绑定的旧兼容 API 绕过持久开关。

批准、数据边界和凭据隔离由共享内核维持，不可为了拆插件而降低这些限制。功能插件是可信构建代码；扩展市场的 manifest 是数据，不能作为可执行插件入口。

## 验收与交付

1. 运行 `python3 tools/check_plugin_architecture.py`。它检查包/allowlist/前端 ID、模块与前端归属、双语功能清单、依赖、唯一贡献和面板一致性。
2. 运行 `python3 -m unittest tests.test_plugin_architecture -q`，其中还检查实际 CLI parser、工具归属及持久禁用的调用边界。
3. 对功能行为运行适当回归；后端行为改动跑 `python3 -m unittest discover -s tests -q`。前端改动跑 `npm --prefix webapp test`、`npm --prefix webapp run typecheck`、`npm --prefix webapp run build`。
4. 用隔离状态和最新构建，核验插件卡片及子功能可搜索、禁用/阻塞项仍可见、功能关闭后停止请求/服务；前端至少核验桌面与窄屏。
5. 更新使用说明和功能清单，再准备本地发布包。`tools/prepare_release.py` 再次执行结构门禁并把开发约束一并打包。

结构检查能发现漏登记或注册表漂移，不能替代对语义、权限、动态执行与生命周期的审查。不得只改检查白名单、填空壳功能名或添加卡片来宣称完成插件拆分。

共享基础设施的允许范围见 [AGENTS.md](AGENTS.md)。添加共享例外必须记录理由并经架构审查；默认应放进业务插件。

## 桌面宿主与平台适配

桌面产品集成属于 `desktop` 插件。Electron 业务模块在 `desktop/src/`，由 desktop manifest 的 `desktopModules` 精确登记；Python 对应实现位于 `xueness/bundled_plugins/desktop/`，界面位于 `webapp/src/plugins/desktop/`。结构门禁同样检查 Electron 模块归属。

窗口、私有后端连接和插件管理是桌面入口的恢复基础设施，类似 Web HTTP 宿主；禁用 desktop 时它们仍提供其它插件和插件恢复入口，原生目录选择和桌面状态 API 则关闭。不能将其它桌面业务借此放入宿主。跨平台文件锁是已有 lease/写锁基础设施的实现；Shell、终端、工作流和机器指标的系统差异必须留在各自插件。
