# Seagull 研究技能

2026-10-23：根据用户选择，将本机六项 Seagull 技能适配到 Xueness 的 `skills` 插件。它们随应用内置，沿用现有技能发现、按需加载和来源覆盖机制。

| 技能名 | 用途 |
| --- | --- |
| seagull-game-security | 游戏作弊路径、反作弊信号与防护研究 |
| seagull-lab | 可复现研究目录、原始证据哈希与操作记录 |
| seagull-license-security | 授权、激活、订阅和设备绑定安全分析 |
| seagull-memory | 内存、转储、指针链与运行时结构分析 |
| seagull-pentest | 应用、API、网络与身份系统安全验证 |
| seagull-reverse | 二进制、固件与协议逆向分析 |

在聊天中使用 `/skills` 查看可用技能，或在任务中指定技能名称。模型通过现有 `Skill` / `skill_read` 工具按需读取正文；返回结果包含技能的实际目录，脚本路径相对于该目录解析。关闭“技能”功能插件后，不再向模型提供技能工具和目录。

项目 `.xueness/skills`、兼容项目 `.zcode/skills`、用户状态目录 `skills` 以及资源技能的同名条目，均可覆盖内置版本。此次安装不覆盖用户技能，也不修改本机 Codex 原文件。

## 配套脚本

本机原始六项技能主要是说明文件，没有附带它们提到的脚本与参考目录。本次缩短了目录描述，移除了不存在的参考资源引用，并补齐实际使用的三个 Python 标准库脚本：

- `seagull-lab/scripts/new_case.py <name> --root <directory>`：建立案例目录、空白证据与命令记录以及 JSON manifest；已存在的案例不会被覆盖。
- `seagull-lab/scripts/hash_artifact.py <file> [<file> ...]`：输出文件绝对路径、实际读取字节数和 SHA-256 的 JSON，只读文件。
- `seagull-reverse/scripts/triage_binary.py <artifact>`：只读计算哈希、识别 PE / ELF / Mach-O / ZIP 头信息。它不会执行样本或替代反汇编工具，未知字段为 `null`。

执行这些脚本需要 Python 3（本机已安装），不需要第三方 Python 包。IDA、Ghidra、Frida、Volatility 等专业工具按研究任务使用工作区中已有的工具；这些外部工具并未随技能安装。

原始说明来自用户本机的同名 skill；适配副本位于 `ts/plugins/skills/bundled/`。原目录中的历史 `.bak` 文件未随应用分发。GitHub 发布继续暂缓。
