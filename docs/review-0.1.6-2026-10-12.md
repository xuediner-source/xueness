# 0.1.6 改动审查与平台统一

审查范围包括 17b218e 之后的七个本地提交、212 项功能的插件登记、执行边界和新功能回归。实现仍属于对应的 bundled plugin；Store 原子更新和结算上下文属于已有 journal 与通用生命周期基础设施。用户这次明确要求全量测试，取代上一次快速补齐阶段的减测要求。

## 修复的实际问题

- 自动命名：手动改名与自动标题发布改用同一 journal 临界区，手动标题优先；请求前重新核对插件状态。结算使用本轮实际模型及宿主授权，禁止回退到全局默认或环境模型；FakeProvider、无授权、轻量和子会话不启动命名请求。正常 CLI 和 Web 真实模型绑定仍可自动命名。
- 子会话：关闭与新建/恢复原子协调，取消后有界等待子 worker 完成最终保存并释放租约；超时明确报告，不能在父执行返回后留下未结算的 child 写入。
- journal：分页 cursor 必须带第一页的 message_revision；编辑或压缩导致修订变化时返回 409，不能仅凭仍在范围内的旧数字游标读取错位页。
- 工作流库：同名创建、覆盖和读取复用每模板跨进程锁，两个 overwrite=false 创建者不能同时成功；原始状态路径及运行期目录替换均检查 reparse point，文件私有保护继续生效。
- doctor：不可写或不存在的工作区、显式 ping 失败影响整体成功码；探针失败也在 finally 中清理临时文件。
- 桌面：通知点击在受信任主 renderer 就绪后恢复目标会话，覆盖 macOS 最后窗口已关闭的情况；宿主独立检查插件状态，禁用后清除待发送命令并拒绝旧通知。Mac 原生 File 菜单补齐 Cmd+W。
- 会话界面：压缩标记识别只有旧工具输出被归档的情况；市场清单安装、资源清单启用、功能插件启用分别说明，保留现有开关。六项清单已安装但禁用的情形已在真实生产构建中核验。
- Web 宿主启动：Mac 原生线程栈确认 stdlib HTTPServer.server_bind 在 socket.getfqdn 反向 DNS 上阻塞，导致真实模块入口无法在 10 秒内就绪；托管服务器改为直接绑定并使用实际 socket 地址作为 server_name/server_port，避免本地启动依赖 DNS。Host/Origin、绑定地址和远程访问授权仍由既有宿主校验决定。

## 订阅中心 HTTP 400

本机 reference fdea01871c514893 对应订阅桥接返回的 HTTP 400。现有诊断不保存上游响应正文，因此不能把某一个具体上游错误原因宣称为已实测确认。

已补齐 Antigravity 工具声明适配：JSON Schema 转为 Gemini Schema 的类型枚举与支持字段，处理本地引用、可空字段和无参数函数；原始主机校验 schema 不修改。订阅 worker 同时遵守本轮绝对 deadline，已过期的请求不启动 worker，超时只 abort 该 request ID，避免命名等短请求落入默认十分钟等待。

协议验证使用离线响应及伪凭据。没有用实际订阅账号发送生成请求；安装新版后仍需要真实账号重试确认该 reference 对应的问题已经消失。参考 [Google FunctionDeclaration/Schema](https://ai.google.dev/api/generate-content)；Cloud Code 的实际协议由仓库已有可信适配器处理。

## 验证与构建

全量覆盖包括根目录 Python tests、webapp tests、desktop Node tests、desktop Python tests、订阅 Node 协议测试、类型检查、插件结构、生产构建和浏览器交互。Windows 隔离状态夹具不验证命名时显式关闭该异步功能，命名专测继续覆盖真实适配器绑定及手动改名竞态；不忽略拆除异常，也不靠重试将失败判为通过。

本地完整集合按原始 unittest discovery 收集并在独立进程执行，保留标准类/模块 fixture 和平台 skip；测试辅助脚本位于审查目录，不属于产品。GitHub full 模式仍使用标准 unittest discover 命令，对 Windows x64、Mac Intel x64、Mac Apple Silicon arm64 原生运行器执行完整检查、冻结后端、打包及真实应用启动检查。

首次原生全量暴露并修正额外平台夹具差异：调度任务明确使用生成时间戳的上海时区；Linux 路径锁断言显式模拟 Linux；Windows 最近会话时间戳改为秒级间隔，避免 NTFS 纳秒舍入平局；可选 symlink/FIFO 检查独立于通用文件安全断言，FIFO 仅在平台具备该能力时运行；OEM 测试选择当前编码能表示的非 ASCII 样本，保留真实 PowerShell UTF-8 输出检查；`/init` 预期路径与实际工作区 resolve 契约一致。Web 模块启动夹具明确直连 loopback、将输出写入隔离日志并报告失败诊断，仍保留 10 秒预算；Windows 正常及故意无效代理环境均通过，Mac 结果以原生 CI 为准。这些改动没有调整产品权限、默认时区、路径锁或 shell 解码行为。

后端首次本地完整 discovery 收集 2867 项，四个隔离进程均正常退出；标准 unittest 结果为 2851 项、0 失败、0 错误、90 项 skip。16 项收集数与运行报告数的差额来自缺少可选外部 MCP 环境时的类级 setUpClass skip，不是遗漏执行。前端验证为 997 项、typecheck、设计与 bundle 门禁；桌面 Node 为 108 项（本机 6 项平台 skip），桌面 Python 9 项；订阅协议 24 项、Python 15 项。浏览器交互四个验证器全部通过；1440px 和 390px 的八张插件状态截图没有横向溢出、浏览器错误或非 loopback 请求。原生构建结果另存于本地证据目录及对应 GitHub Actions 运行记录。

本地证据目录：E:/models/apps/xueness-review-20261012。用户会话、工作区、账号凭据与插件开关不参与验收状态，关机脚本没有恢复或执行。
