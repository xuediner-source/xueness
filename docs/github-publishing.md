# GitHub 仓库上传说明

2026-10-01，项目所有者先授权新建 GitHub 仓库并上传完整项目，随后明确授权公开仓库，以及将 Windows、macOS 安装包和源码一起上传 GitHub。仓库为 [xuediner-source/xueness](https://github.com/xuediner-source/xueness)，桌面版统一从 [Releases](https://github.com/xuediner-source/xueness/releases) 获取。

## 上传范围

上传当前 Python 后端、全部 28 个可信功能插件和 142 项子功能、React 前端源码与预构建资产、桌面宿主及三平台构建脚本、测试及 MCP 测试服务器、开发工具、项目文档与文字审查记录、安装脚本、容器配置、许可证和第三方声明。`webapp/dist` 随仓库保存，克隆后可直接使用 Python 运行界面。

不上传本机 `.state`、`.xueness-data`、`.web-runs`、模型配置与密钥、环境文件、依赖安装、缓存、日志、备份、集成实验独立仓库及历史验收截图。首页的 `docs/images/` 仅包含品牌图及新建隔离状态目录所截取的真实界面，不包含用户会话或配置。阶段文档中的其它截图链接指向本机 QA 记录，不是运行或构建依赖。

## 历史与验证

新仓库从审查过的当前文件快照建立初始提交，不携带本机旧 Git 历史。旧历史包含已移除的原版机壳等内容，本机历史和未提交工作保留，不重置或删除用户数据。

上传前对文件名和内容扫描凭据、私钥及运行状态，保留第三方声明；检查插件归属、安装和打包约束。上传后核对远端提交及 Git 树，确保源码、插件、规则和预构建资产完整。

桌面二进制使用原生 Windows x64、macOS Intel x64 和 Apple Silicon arm64 runner 构建，完成冻结后端及打包界面验收后作为 Release 资产上传。每版提供 SHA-256 校验和与构建来源；文档改动与安装包的实际构建提交分别记录，不以更新首页替代重新验证程序。安装包未签名或公证的限制会在下载页说明。

源码上传、手动 CI 构建与 `tools/prepare_release.py` 均不会自动发布；本次 Release 和公开可见性由项目所有者的明确授权单独执行。没有发布容器镜像或部署公网服务。后续新功能继续遵循 `AGENTS.md` 与 `CONTRIBUTING.md`，必须属于插件并显示在功能插件面板。

## 2026-10-02 前端复核更新

本轮在远端 main 的独立公开历史上提交前端交接收尾及其依赖的已保存后端接口，不从旧开发 checkout 推送历史。当前源码版本为 0.1.1，已发布桌面安装包仍为 0.1.0；源码更新不代表旧安装包已经更新。详细复核和真实验证结果见 [前端复核记录](frontend-review-2026-10-02.md)。

## 2026-10-04 0.1.2 更新发布

项目所有者授权发布 0.1.2，用于已有 0.1.1 客户端接收更新。此版包含前端优化和异步子代理协调，完整验证记录见 [前端优化](frontend-optimization-2026-10-04.md)与[子代理协调](xueness-subagent-coordination.md)。

三平台安装包从同一 Git 提交通过原生 runner 构建。Release 必须包含 Windows `latest.yml`、匹配的 NSIS 安装器及 blockmap，统一合并三平台 SHA-256 清单；不能只推源码或只上传安装器。未签名 Mac 使用对应架构 DMG 的应用内下载及校验，下载完成后仍由用户替换应用。0.1.0 客户端没有更新器，需要先手动升级；Windows 便携版不支持原地更新。实际已发布版本与构建提交以 Releases 中的构建来源文件为准。


本次发布由所有者明确允许先上传包、随后在 Windows 电脑上排查更新。仅此发布使用 `skip_windows_update_smoke=true`；该工作流输入默认关闭，其它插件、后端、前端、打包启动检查仍执行。Windows 安装包能构建和启动，并曾在隔离源完成新版下载及校验，但安装后重启的完整更新验收尚未通过，不能将本次绿色构建当作此项通过的证据。后续 Windows 接手任务见 [Windows 更新交接提示词](windows-updater-handoff.md)。

## 2026-10-05 0.1.3 更新发布

项目所有者在 PR #1 修复并合并后明确授权发布。本次发布为 [v0.1.3](https://github.com/xuediner-source/xueness/releases/tag/v0.1.3)，安装包和源码归档均来自 `610b04ed58e9adf07f34bc7f0c6e79b72590050c`，原生三平台构建为 [37301500839](https://github.com/xuediner-source/xueness/actions/runs/37301500839)。此版包含 27 插件、139 项功能、10 项独立审查修复及插件档位界面调整。

Windows x64、Mac Intel x64 和 Apple Silicon arm64 构建全部通过，包括冻结后端、真实 PTY/ConPTY、打包界面启动与关闭清理。Windows 没有跳过更新演练：隔离安装版 0.1.3 从 loopback 下载合成的 0.1.4 包，完成安装和重启；实际证据为 `stage=verified`、`preserved=true`，测试会话与配置内容哈希保持一致。这验证安装更新链路，不代表用户电脑上的更新已被代为执行。

发布包含 17 个资产，Windows 的 `latest.yml`、NSIS 与 blockmap 对齐版本、大小和 SHA-512；两份 Mac 元数据合并为一份 `latest-mac.yml`。重新生成统一 `SHA256SUMS.txt`，覆盖源码、安装包、更新元数据与构建来源文件。所有 GitHub 资产的大小和 SHA-256 与本地核对一致后才把草稿公开为 latest。

公开源上线后，用生产 Mac 更新协调器读取真实 GitHub API，确认 arm64/x64 的 0.1.2 版本检查均发现 0.1.3 并找到匹配的可信 DMG 与哈希；Windows 公共更新元数据也指向 0.1.3 安装器。仓库中英文首页的下载链接同步更新。安装包构建提交与随后更新下载说明的文档提交分开记录，未重写构建来源或替换用户已有应用及状态。


## 2026-10-06 0.1.4 更新发布

项目所有者的起始页与更新截图反馈作为已授权发布任务的接续处理。最新稳定版为 [v0.1.4](https://github.com/xuediner-source/xueness/releases/tag/v0.1.4)，最终安装包与源码归档来自 `d1baaa96fc8e15a773cc2cb4042b70cdb7d207ab`，三平台原生构建为 [37350760901](https://github.com/xuediner-source/xueness/actions/runs/37350760901)。同轮较早的界面构建未用于本次发布。

起始页去掉重型入口卡片，改为居中的紧凑按钮。空历史分组完全隐藏；有记录后显示列表，单组占用可用宽度，双组桌面并排、窄屏堆叠。Mac 下载器改用实际 Electron 请求流，每次重定向先验证可信目标，修复 `Redirect was cancelled`；更新设置增加实际下载字节、速度和估算剩余时间。归属仍为 `sessions.start_page` 与 `updates.desktop`，保持 27 插件、139 项功能。详细边界见 [本轮复核](update-and-startpage-review-2026-10-06.md)。

最终三平台均通过插件门禁、冻结后端、打包工作台与关闭清理；Windows 公共 GitHub 安装器下载检查通过，未跳过 NSIS 更新演练。实际隔离安装版 0.1.4 从 loopback 下载并安装合成 0.1.5，完成重启，证据为 `stage=verified`、`preserved=true`；配置和会话的前后 SHA-256 一致。发布前核对这些实际证据和构建提交，再生成构建来源文件。该演练没有使用用户会话或配置。

发布仍含 17 个资产：两种 Mac 架构的 DMG/ZIP 与 blockmap、Windows NSIS/便携 ZIP、Windows 和合并后的 Mac 更新元数据、源码、构建来源与校验清单。所有资产的 GitHub 大小与 SHA-256 均和本地一致；远端标签剥离后的提交、Release 目标及构建来源都指向上述源码。大文件上传中断后按文件恢复，草稿未在资产不齐全时公开。

公开为 latest 后，使用实际 Electron 44.5.1 与生产 Mac 下载协调器完整取得 0.1.4 arm64 DMG，150974671 字节，SHA-256 为 `b185bf361d1b0052c6c373fcb311d05ac0c6ad981b7f91264628b91a78f2c2b3`，再次校验通过。Mac 上的真实 NSISUpdater / ElectronHttpExecutor 也从公共更新源下载了 0.1.4 Windows 安装器，127131710 字节，内置 SHA-512 校验通过；这个公开源测试使用隔离 Windows adapter，没有执行安装器，不能当作用户 Windows 电脑的速度或安装测量。原生 Windows 安装更新证据来自前述 CI 演练。

这台 Mac 的 `/Applications/Xueness.app` 已替换为最终界面的 0.1.4 并打开，替换期间既有配置内容保持一致，旧应用备份保留。受旧下载器错误影响的其它 Mac 客户端仍需替换一次应用；未签名 Mac 之后仍需在 Finder 完成 DMG 中的应用替换。Windows 便携版不支持原地更新，用户 Windows 0.1.1 慢速的网络原因尚未确定，本次没有宣称普遍提速。中英文首页已切换到 0.1.4 下载链接；随后文档提交与二进制实际构建提交分别记录。
