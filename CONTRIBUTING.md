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

`modules` 列出包内全部实际 Python 业务模块，排除入口 `plugin.py` 和 `__init__.py`；嵌套模块使用点分隔名称。`frontendModules` 路径相对于 `webapp/src/`。新业务组件应直接放在所属插件目录；确需共享纯展示文件时才按导出符号声明归属，并记录共享理由。

创建新插件时，还需登记后端 `PLUGIN_IDS`、前端 `XUENESS_PLUGIN_REGISTRY`、依赖、真实工具/命令/面板/资源，并更新 [架构功能清单](docs/xueness-plugin-architecture.md)。共享 `capabilities` 面板可由多个资源插件贡献，实际工具、CLI 命令和子功能 ID 不能重复归属。没有单独 Web 面板的 CLI/工具插件，也必须出现在完整 catalog 中。通常从「设置 → 插件」进入；settings 关闭时从账户菜单中的「插件管理」进入，全部插件关闭后仍能查看及恢复。

## 禁用与资源释放

检查前端挂载和 effect、服务端工具/CLI/HTTP 的实际生效状态。组合界面须逐项检查所有参与插件；例如关闭 diagnostics 应停止本机资源采样，不能连带停用独立 providers 功能。禁用依赖只阻塞依赖者，不自动改写开关。

轮询、子进程、连接和后台任务必须有明确停止与卸载路径；禁用后不启动新工作。正在发生的外部副作用不会因禁用而自动撤回。运行入口和直接工具调用必须绑定相同状态目录，不能通过未绑定的旧兼容 API 绕过持久开关。

批准、数据边界和凭据隔离由共享内核维持，不可为了拆插件而降低这些限制。功能插件是可信构建代码；扩展市场的 manifest 是数据，不能作为可执行插件入口。

## 验收与交付

1. 运行 `python3 tools/check_plugin_architecture.py`。它检查包/allowlist/前端 ID、模块与前端归属、双语功能清单、依赖、唯一贡献和面板一致性。
2. 运行 `python3 -m unittest tests.test_plugin_architecture -q`，其中还检查实际 CLI parser、工具归属及持久禁用的调用边界。
3. 对功能行为运行适当回归；后端行为改动跑 `python3 -m unittest discover -s tests -q`。前端改动跑 `npm --prefix webapp test`、`npm --prefix webapp run typecheck`、`npm --prefix webapp run build`。
4. 用隔离状态和最新构建，核验插件卡片及子功能可搜索、禁用/阻塞项仍可见、功能关闭后停止请求/服务；前端至少核验桌面与窄屏。构建会自动运行 `check:design`（未定义变量、主题单源及基础文本对比度）和 `check:bundle`（启动静态依赖图 gzip 文件预算）；后者不等于真实网络时延或运行性能测量。

插件目录的原生折叠交互回归使用 `npm --prefix webapp run test:browser`。它在临时目录和随机 loopback 端口中渲染真实组件，禁止 API/外部请求，不读取用户状态。默认使用本机 Chrome；可通过 `PLAYWRIGHT_CHANNEL` 选择已安装的 Playwright 浏览器通道。
5. 更新使用说明和功能清单，再准备本地发布包。`tools/prepare_release.py` 再次执行结构门禁并把开发约束一并打包。

结构检查能发现漏登记或注册表漂移，不能替代对语义、权限、动态执行与生命周期的审查。不得只改检查白名单、填空壳功能名或添加卡片来宣称完成插件拆分。

共享基础设施的允许范围见 [AGENTS.md](AGENTS.md)。添加共享例外必须记录理由并经架构审查；默认应放进业务插件。

资源存储边界继续由既有共享 `resources.py` 维护：检查状态目录、resources 父目录与各 kind 目录的实际文件条目，拒绝符号链接及 Windows reparse point（包括 junction），不能先 resolve 再把重定向后的目录当成新的安全根。各资源插件仍实现加载、渲染与执行，并先检查原有 Gate 和插件开关；共享辅助函数不提供新用户能力或授权。

资源存储的原子 JSON 写入默认私有：POSIX 使用 0600；Windows 在临时文件写入任何数据前，对同一已打开文件对象设置 protected DACL，只允许文件 owner、SYSTEM 与本地 Administrators 访问，拒绝继承父目录的宽松权限。提供者、OAuth、搜索凭据、共享会话 journal 与导出复用这一存储保护，权限设置失败必须停止写入并清理临时文件。该保护属于已有共享存储，不是新的授权或业务入口，也不修改系统安全策略。

会话队列同样在写入前复用私有文件保护。浏览器导入资料及持久 profile 使用既有共享存储中的私有目录保护：POSIX 对无链接目录句柄设置 0700，Windows 对实际已打开且非 reparse point 的目录设置 protected DACL，并为后续 Chromium/Node 文件提供仅 owner、SYSTEM、Administrators 可继承的权限。资料复制先保护空 staging 目录及文件，再写入个人数据；权限失败不启动浏览器或替换既有资料。目录与文件复用同一 Windows ACL 实现，属于已有存储保护，不新增用户能力或共享白名单。继承行为参考 [Windows SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)。

## 桌面宿主与平台适配

桌面产品集成属于 `desktop` 插件。Electron 业务模块在 `desktop/src/`，由 desktop manifest 的 `desktopModules` 精确登记；Python 对应实现位于 `xueness/bundled_plugins/desktop/`，界面位于 `webapp/src/plugins/desktop/`。结构门禁同样检查 Electron 模块归属。

窗口、私有后端连接和插件管理是桌面入口的恢复基础设施，类似 Web HTTP 宿主；禁用 desktop 时它们仍提供其它插件和插件恢复入口，原生目录选择和桌面状态 API 则关闭。不能将其它桌面业务借此放入宿主。跨平台文件锁是已有 lease/写锁基础设施的实现。会话租约在打开后校验：POSIX 用 `O_DIRECTORY|O_NOFOLLOW` 打开锁目录再相对打开锁文件，Windows 在未跟随的目录句柄上相对创建并拒绝 reparse point。路径是否为同一文件，以及命令、技能、钩子是否仍在 jail 内，只走 `write_lock` 的主机路径比较：Windows 与 macOS 忽略大小写，Linux 保持区分。Shell、终端、工作流和机器指标的系统差异必须留在各自插件。

`process_runtime.py` 是进程创建的共享基础设施例外：Windows 冻结后端的 DLL 搜索目录是进程全局状态，多个插件必须共用同一把锁，在创建外部进程时暂时恢复系统搜索路径，创建后立即还原。Windows 子进程的最小环境还需保留固定 allowlist 内的系统、架构、用户目录与 PowerShell 模块路径，使 .NET/PowerShell 能启动；不会追加模型密钥或其它私密环境变量。同一模块也是 Windows 与 macOS 进程树回收的唯一平台 helper。POSIX（含 macOS）只对调用方用 `start_new_session` 创建的会话 `killpg`，先 SIGTERM 再 SIGKILL；Windows 只对调用方持有的整数 pid 执行 `taskkill /T /F`，参数是 argv 列表，不经过 shell。超时、取消和网关退出走这条路径，避免只杀掉直接子进程后留下孙进程。已回收的 pid 不再发信号，也不按裸 pid 扫描全机。桌面宿主的 kill-on-close Job Object 和 MCP 的挂起创建 Job 仍留在各自插件。子进程文本管道在调用方未指定时使用 UTF-8 与 `errors=replace`，显式 `encoding` 或 `errors`（含 `strict`）保持不变，使同一字节序列在 Windows 与 macOS 上得到同一文本。它不检查或授予业务权限；调用插件仍先执行原有 Gate 与开关检查。不能为不同插件复制互不协调的 DLL 目录修改器或第二套进程树终止器。参考 [PyInstaller 外部进程要求](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html#launching-external-programs-from-the-frozen-application)。

## 前端共享焦点基础设施

`plugins/shared.tsx` 的 `useModalFocusScope` 和 `shouldDismissModalOnEscape` 属于基础 UI：只处理可见模态窗口的焦点、Tab、输入法保护与清理，不读取产品数据、发起请求、执行动作或授予权限。各插件仍持有确认状态、业务回调与开关边界。它统一已有跨插件对话框的键盘行为，避免各插件重复不完整的焦点陷阱；未扩大结构门禁共享白名单。独立产品组件必须物理放在所属插件目录，不能仅登记顶层文件绕过此要求。

`xuenessShortcutDisplay.ts` 是共享基础 UI 的显示例外：它只把已经解析好的快捷键文本转换为当前平台的 ⌘/Ctrl、⌥/Alt 与 ⇧/Shift 标签，供侧栏和 settings 快捷键面板复用。它不监听键盘、不读取或保存快捷键配置、不执行操作，也不判断插件或权限；绑定配置和实际动作仍归各自插件。结构门禁单独登记此文件，不能借此放入新的快捷键业务。
