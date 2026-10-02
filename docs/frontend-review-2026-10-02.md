# 前端交接复核与收尾（2026-10-02）

本轮复核 Claude/Gemini 交接中列出的实际源码，并补齐 F-04、F-09 和 Batch C。原始 19 项完整审计报告与逐文件迁移表未在此工作区找到；组件归属依据当前可信插件 manifest、实际导出和架构门禁重新核对，不能将交接中的测试数量当作本轮验证结果。

## 修复范围

| 项目 | 实际处理 |
| --- | --- |
| F-04 | 将三个 composer-toolbar 的 680px 块及 conversation-refresh 中的 composer 窄屏规则归并到 composer-toolbar 单一块，保留省略号、弹层定位及按内容分组布局。 |
| F-09 | 将独立产品组件迁入所属插件，拆分多插件产品实现，更新 imports、测试和 frontendModules。插件管理恢复入口、共享基础 UI 与容器保持基础设施职责。具体归属见插件架构说明。 |
| F-14 / F-17 | 补齐对话框可访问名称、modal 语义、输入法安全 Escape、焦点 containment 与关闭后返回；已处理的 Escape 不再关闭背后的侧栏。 |
| F-15 | 为异步刷新、动作与轮询增加卸载/生命周期代数保护，忽略过期响应；诊断导出 URL 定时释放并在卸载时清理，支持 StrictMode effect 重放。 |
| F-16 | 旧侧栏的 899px 规则并入 900px 规则，与 Shell 的 matchMedia 边界一致。 |
| F-18 | PTY 不上报零尺寸或非整数尺寸，保留可恢复轮询退避及 malformed base64 容错。 |
| F-19 | 有名称的 SVG 输出原生 title 和唯一 aria-labelledby；装饰图标保持 aria-hidden。 |
| OAuth 实际响应 | MCP 无 Token 到期时间时后端返回 expiresAt:null；前端接受该值作为未报告，保留无到期时间授权的状态与撤销入口。 |
| 新 favicon | Python 静态资源白名单补充 xueness-mark.svg，避免开发服务器可见但生产宿主 404。 |

交接已有修复继续保留：remote 使用共享 CSRF API client；workflow/MCP 输入 JSON 校验；composer 的 IME Escape/箭头保护；工具菜单关闭后焦点返回触发按钮；英文静态界面词典与 diagnostics 参数化文案。

真实界面复核另发现设置侧栏的「网络搜索」「应用更新」及说明未翻译，已补齐词典，并增加覆盖全部已安装设置分类的英文回归。

## 发布范围与验证边界

GitHub 使用独立公开快照历史，本机旧开发 checkout 仍保留未提交工作。本轮沿远端当前 main 在隔离 clone 中整理与提交，不覆盖旧开发历史。前端依赖上一轮已保存但未上传的搜索、完成检查、兼容诊断和更新接口，随对应后端、桌面模块、测试与说明一起同步，不能只上传调用不存在接口的界面。

验证使用隔离状态、固定 HTTP/模型 fixture 和本机浏览器，不调用收费模型，不读取或更改用户会话、密钥、工作区与插件开关。输入法测试使用 composition/keyCode 浏览器事件和回归，不能宣称人工操作 Windows 中文输入法；本机无 Windows NInfer，因此不声明它的实测性能。当前 Windows/macOS 安装包的原生构建与更新资格以对应 GitHub workflow 的实际结果为准，源码上传不是客户端安装完成。

## 最终验证

- 插件结构门禁通过；插件架构回归 15 项通过。当前目录为 27 个插件、96 项功能；23 个独立组件实现物理迁入所属插件，已在架构说明逐项列出，多余转发外壳删除。
- 后端全套运行 1262 项，26 项按环境/互操作条件跳过，其余通过。网络拒绝用例仍产生既有 HTTPError ResourceWarning，断言未失败。
- 前端 416 项通过；TypeScript、生产构建通过。构建仍提示既有大 chunk，未将这一提示当作性能达标证据。
- 桌面模块 30 项通过；本机 macOS Electron 源码模式实际启动，集成标题栏、隔离的 renderer 和 27 张插件卡片检查通过。
- 系统 Chrome 加载 Python 宿主提供的最新生产构建，1280/420/899/900/901px 各检验亮暗主题，无横向溢出，420px composer 两组工具同排，900px 侧栏边界一致。另检验输入法事件与普通 Escape、popover/重命名/诊断模态焦点、英文设置导航及 MCP/diagnostics/remote/workflows 面板、生产 favicon 返回 200；无 pageerror。
- 终端、远程、MCP、工作流和诊断面板通过浏览器延迟响应后卸载检查，未产生卸载后的链式刷新/轮询。

完整审计记录留在本文件；提交从远端公开历史整理，用户原开发 checkout 与本地配置保留。
