# Xueness 0.1.8 · Z5 阶段交付

Z5 MCP、配置与 hooks 的本阶段适配完成，基于 Z4。主代理决定范围、实现与验收；按用户最新设置，GPT-6-Luna / max 子代理仅执行指定模块及验证。

- settings：数据配置深合并、来源追踪、脱敏候选审阅、用户层保存、当前项目根与精确摘要信任/撤销；实际接线 shell 与 MCP。配置不执行脚本、不授予 hook 信任。
- hooks：新增原生项目 config 来源，逐次派发核验信任与撤销；additionalContext、批准前 updatedInput 和一次 Stop 继续接入真实请求。保留 process/argv 与独立开关、信任和 Gate。
- MCP：激活内连接 lease/引用计数、owner/cwd/config 隔离、取消且不重放、工具目录通知刷新、能力约束下的资源订阅、只读运行端口和持久元数据活动。现有 stdio/HTTP/SSE、手动 OAuth 与 elicitation 保留。
- catalog/manifest 的中英文 features、实际模块和 HTTP 归属同步；宿主只装配，未新增插件或扩大 allowlist。修复 Z4 已存在的授权计划草稿被工作区文件快照阻断的问题，草稿不进入工作区回退，权限边界保持。

Windows / Node24.19。定向回归按最终用例去重为67 tests、64 pass、3 skipped、0未解决失败：宿主6文件21 tests/19 pass/2 skipped；MCP5文件25/24/1；hooks2文件13/13；配置1文件4/4；文件回退1文件4/4。另有整体跳过的 POSIX hooks 与退役 Python 对照 suite，不计为通过。宿主首次发现草稿失败，在 Z4 重现后修复，只重跑该用例和4项文件回退；补测1项旧MCP资源与新层的传输别名、数组、env、cwd、禁用及字段校验合并。原失败日志与修复日志均保留，不重复累计。

类型、行数（964 TS/最大400）、插件（30/406）、后端构建（677 JS）和搬迁空 PATH 检查通过。实际 ApplicationApi/FrontDoor source/built 各4场景、4次loopback模型请求通过：待信任配置审阅无连接、独立 hook 信任、真实项目 shell、参数重写、上下文注入、运行中撤销、一次 Stop 继续、MCP资源订阅/脱敏持久活动、取消零重放和插件门禁。最终构建复用 Z3 的4场景、3次loopback请求，文件/会话回退、SQLite无损导出及分叉继续通过。

原始日志和 JSON 在 `验收资料/验证记录/z5-*`。Web源码不变，166个dist文件与Z4逐项hash相同；未重复无关全套或前端构建。Linux/macOS原生、安装器、Docker、CI未实测。无真实/收费模型调用、提交、推送或发布。

使用、配置优先级、HTTP取消开关、激活内连接池、hook输出与信任范围见 [Z5 使用说明](docs/engine-z5.md) 和 [HANDOVER §46](ts/HANDOVER.md)。完整包及相对Z4的零删除补丁应用见 [PATCH-Z5.md](PATCH-Z5.md)。下一阶段为Z6，Z6–Z8尚有三个阶段，早期内部规模约8–11块，不能当作固定工期；整个引擎尚未完成。
