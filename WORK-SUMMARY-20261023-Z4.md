# Xueness 0.1.8 · Z4 阶段交付

Z4 执行适配完成，基于 Z3；本次按要求连续完成 Z3、再完成 Z4。主代理确定范围、实现取舍和验收，GPT-6-Luna / max 执行三个指定分支。

- shell：可选 Bash/Git Bash、授权后懒加载初始化快照、按内容缓存启动脚本、直接 argv 与 Windows batch 桥接，接入原后台任务生命周期。默认 Windows PowerShell 不变，配置有实际 GET/POST 入口。
- files：工作区文件系统适配，UTF-8 行范围扫描和字节范围读取，取消、完整 SHA、替换前版本校验与原子 create-only；Read/Write/Edit 接线，新增受会话根与插件开关约束的 file-bytes API。
- network：HTTP 升级、最多五次逐跳验证的 HTTPS GET 跳转、统一预算和取消、全文结果与配置隔离缓存、持久 NetworkRequest 活动。保留全部 DNS 地址校验与固定连接；搜索 POST 不跟随跳转。
- 修复 providers 漏登记 `tool_result_read`，实际 PluginHost 和生命周期工具目录均可使用全文分页。新功能和模块登记于现有插件，宿主只接线，无新插件包或构建 allowlist 扩展。

Windows / Node 24.19 实测。宿主相关 7 个文件：32 tests / 31 pass / 1 退役 Python 对照 skipped / 0 fail。执行分支分别验证文件范围/读写 39 pass、1 POSIX-only skip（受影响 3 文件随后 11/11）；shell/exec 10/10；network 10 pass、1 历史 Python skip。双引号与 batch 路径引用收口后仅重跑受影响的 9 项并通过。重复运行不累加为新测试。原始宿主/shell 日志及 source/built JSON 在 `验收资料/验证记录/z4-*`。

类型、行数（953 TS 文件，最大400行）、插件（30/399）、后端构建（669 JS）与搬迁空 PATH 检查通过。真实 ApplicationApi/FrontDoor source/built 各4场景、3次loopback模型请求通过，含真实 Git Bash、文件 API/开关、两次受控逐跳请求与缓存、28820字符全文分页、5个持久网络活动和 query 排除。

另在最终构建上复用 Z3 的4场景验收，确认 SQLite 无损导出、分叉、真实 Write 快照及文件/对话回退继续通过（3次loopback请求，零副作用重放）。

Web 源码无改动，166 个 dist 文件与 Z3 逐项 hash 相同；未重跑无关全套或前端构建。Linux/macOS 原生未实测；Git Bash 不等同 Linux 原生。未调用公网或真实/收费模型、未提交/推送/发布。

完整包及相对 Z3 的零删除补丁应用见 [PATCH-Z4.md](PATCH-Z4.md)，使用、乐观版本检查与硬链接 create-only 等边界见 [Z4 说明](docs/engine-z4.md) 和 [HANDOVER §45](ts/HANDOVER.md)。下一阶段为 Z5；Z5–Z8 仍有四个阶段，整个引擎尚未完成。
