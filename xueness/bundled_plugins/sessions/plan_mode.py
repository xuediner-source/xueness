"""``plan`` 权限模式的归属实现：会话计划草稿与双语拒绝说明。

计划模式仍由内核 Gate 执行，本模块只提供 sessions 插件拥有的策略：四种
权限模式的唯一取值、草稿文件落在状态目录的哪个位置、什么样的写入目标算
这份草稿、远程执行主体的形状，以及被拒时回传给模型的提示。草稿不在工作区
内，因此写入它不会改动项目文件。

``PERMISSION_MODES`` 是 build/edit/yolo/plan 的单一来源。内核 ``mode``
仍只有 plan|build，那是另一套更硬的上限，不要并进这个元组。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from ...resources import _is_link

#: 与内核 Gate、HTTP、CLI、app-server 和前端共用的权限模式取值。
#: ``plan`` 是只读规划模式，唯一的写例外是本会话的计划草稿。
PERMISSION_MODES = ("build", "edit", "yolo", "plan")
DRAFT_DIRECTORY = "plan-drafts"
_SESSION_ID = re.compile(r"[0-9a-f]{32}")


def is_permission_mode(value) -> bool:
    return isinstance(value, str) and value in PERMISSION_MODES


def permission_mode_error() -> str:
    """校验失败文案。名称从 ``PERMISSION_MODES`` 拼出，避免再写一份元组。"""
    quoted = ", ".join(repr(mode) for mode in PERMISSION_MODES[:-1])
    return "permission_mode must be %s, or %s" % (quoted, repr(PERMISSION_MODES[-1]))


def is_remote_exec_subject(subject) -> bool:
    """远程 SSH 执行的批准主体，而不是普通 argv 或浏览器动作。

    形状与 WebGate 原来的判断一致：JSON 对象同时带有字符串 ``connection``、
    字符串 ``connection_digest`` 和列表 ``argv``。本地 shell 的 argv 数组、
    以及只含 ``action``/``url`` 的浏览器主体都不是远程执行。不要把 argv 以
    ``ssh`` 开头当成远程 —— 那会误伤普通命令。
    """
    if not isinstance(subject, str) or not subject:
        return False
    try:
        details = json.loads(subject)
    except (ValueError, TypeError):
        return False
    return (isinstance(details, dict)
            and isinstance(details.get("connection"), str)
            and isinstance(details.get("connection_digest"), str)
            and isinstance(details.get("argv"), list))


def draft_path(state_dir, session_id: str) -> Path:
    """本会话专属的计划草稿路径；被链接的草稿目录一律拒绝。"""
    if not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
        raise ValueError("invalid session id")
    state = Path(state_dir)
    directory = state / DRAFT_DIRECTORY
    if _is_link(state) or _is_link(directory):
        raise ValueError("plan draft directory must not be a link or reparse point")
    return (directory / (session_id + ".md")).resolve()


class DraftPolicy:
    """Gate 使用的会话草稿凭据：命中判定与拒绝文案都由 sessions 插件决定。"""

    def __init__(self, path: Path):
        self.path = Path(path)

    def matches(self, subject) -> bool:
        """纯字符串判定：只有绝对路径且规范化后正是这份草稿才算命中。

        不做 realpath，也不接受相对路径 —— 相对路径属于工作区 jail，让 ``path_in``
        继续管它。判不中就当普通工作区写入处理，宁可多问一次批准。
        """
        if not isinstance(subject, str) or not subject:
            return False
        target = Path(subject)
        if not target.is_absolute():
            return False
        return _key(target) == _key(self.path)

    def denial(self, kind: str) -> str:
        """被拒原因需要双语且可操作：先出计划，唯一可写的是这份草稿文件。"""
        return (f"{kind} denied：当前是计划模式（Plan mode），只允许读取与搜索；"
                f"请先写出计划并保存到本会话的计划草稿文件 {self.path}（此模式下唯一可写路径）。"
                "需要改动工作区或执行命令时，请让操作员切换到 build/edit/yolo 权限模式。"
                f" / Plan mode is read-only: write the plan to this session's draft file {self.path} "
                "— the only writable path in this mode — and ask the operator to switch to build, "
                "edit or full access before changing workspace files or running commands.")


def _key(path: Path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def draft_policy(state_dir, session_id: str) -> DraftPolicy:
    return DraftPolicy(draft_path(state_dir, session_id))

