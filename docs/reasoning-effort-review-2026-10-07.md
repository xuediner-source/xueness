# 推理强度按钮验收记录

本次功能扩展归属 `sessions.runtime_model_switch`，供应商能力识别归属既有 `providers` 插件。未新增独立业务入口，也未提交或推送仓库。

## 交互与参数

- 编写器仅显示脑形按钮及当前档位，点击后打开滑块弹层；Escape、外部点击可收起。
- 拖动只预览，松开后应用；支持方向键、Home/End，恢复默认时省略推理强度参数。
- 仅展示供应商实际声明或已确认的档位。未知能力提示配置，不凭空提供 Ultra。
- 火山方舟 Coding Plan 的 `deepseek-v4.1-flash` 支持低、中、高；识别限定官方 HTTPS 主机和 Coding Plan 路径，显式声明优先。
- 真实运行仍使用现有模型选择、默认配置、准备请求与运行请求链路。

## 验证

- 前端 819 项测试通过，类型检查和生产构建通过。
- 后端全套 2270 项：通过，41 项按环境条件跳过；插件结构门禁和 26 项架构测试通过。
- 生产构建覆盖标准/轻量模式、明/暗主题及 1280/420px 共八种布局。验证脚本拦截推理请求，不产生模型费用；真实准备请求与截获运行请求均包含所选档位。
- 独立真实方舟接口探测确认低、中、高均接受请求并返回输出及用量。该探测只验证兼容性，不作为速度或质量评测。
- Mac 打包冒烟通过，2039 个应用文件与构建逐一校验一致；已覆盖 `/Applications/Xueness.app`，版本仍为 0.1.5。
- 安装后原生界面核验：点击按钮展开弹层，End 切至高档、Home 恢复默认、Escape 收起并返回按钮焦点。用户会话和模型配置保留。
- Windows 未在本机执行原生验证；此次交互使用两端共享前端。

## 参考

独立实现交互，参考 [dsh-reasoning-slider](https://github.com/qjcnmd/dsh-reasoning-slider) 和 [DSH-Claude-Style-Reasoning-Slider](https://github.com/MEMZ-JZY/DSH-Claude-Style-Reasoning-Slider) 的供应商档位适配与滑块行为，未引入外部运行时。

本机安装备份：`/Users/xuediner/code/Xueness.app.bak-20261007-153342-before-effort-slider`。
