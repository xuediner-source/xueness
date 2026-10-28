# dsh-context → Xueness 上下文透镜

- 上游：[bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)
- 版本：0.77.0；固定提交：`7ddaae4cae5aef0fe3d7fbe3ca28029bbe598f4b`
- 许可证：Apache-2.0，全文保留在 [LICENSE.dsh-context](LICENSE.dsh-context)。
- 原生插件：`context_lens`，中文名“上下文透镜”，面板 `context-lens`。

| 上游能力/来源 | 本地实现与范围 |
| --- | --- |
| `src/shared/estimate.ts` | 实际适配为 `src/upstream-estimate.ts`，保留字符/4及块开销算法。属于组成估算，不代替供应商用量或宿主预算。 |
| `src/shared/fileOps.ts` | 实际适配为 `src/upstream-fileOps.ts`，修改类型导入。用成功的 Xueness 工具调用推导文件读写/搜索和行数变化估算。 |
| 上下文组成与浏览 | 按 DSH 仪表盘布局实现的原生双列卡片、Token/耗时环图、容量、DNA 趋势与七类分组浏览；会话顶栏直接进入。详见 `docs/context-dashboard-and-header-2026-10-28.md`。 |
| 用量与活动 | 直接使用已存供应商报告；缺失显示未知。缓存属于输入子集。命令执行耗时和含审批等待的工具历时分列。 |
| Fleet/代理视图 | 展示记录能够确认的父子会话关系；没有移植上游代理通信、任务调度、跨宿主导航服务。 |
| 请求偏好 | 原生设置 API 保存记录开关、系统提示前缀/后缀；下一次请求和子代理请求读取相同配置。 |
| 生命周期 | allowlist 内置插件、功能目录、依赖开关、原生 API；关闭后不再开始采集、轮询或贡献提示。 |

上游依赖 DeepSeek Harness/Cordis 的注册、运行时投影和界面协议，不能直接作为 Xueness 可执行插件加载。本适配没有复制整个运行时，也没有引入动态加载任意第三方代码的入口。前端 React/CSS、HTTP 和 Xueness 会话集成为本项目实现。

请求记录位于会话的 `context_lens_requests`，保留最近 160 次的时间、模型、类别估算、内容指纹和长度，不重复保存请求全文；单项浏览预览最多 12,000 字符，工具详情最近 800 项。历史供应商用量仍统计所有已存记录。安装前没有组成快照，不能追溯构造完整历史请求。当前内容浏览器展示现存 journal；请求记录是扩展执行时的宿主请求视图，不能当作供应商实际接收的逐字节报文。没有移植上游价格表，也不编造费用或缺失 Token。
