"""Clone a repository into an authorized directory (``git.clone``).

This is the only git verb in the plugin that reaches the network, so it is
narrower than ``git clone`` on a shell:

* Only ``https://``, ``ssh://`` and scp-style ``[user@]host:path`` remotes are
  accepted. ``file://``, ``ext::``, local paths and anything starting with ``-``
  are refused before a subprocess exists, and ``protocol.ext.allow=never`` goes
  on the command line too so a remote cannot re-enable a transport.
* The destination is a new (or still empty) directory inside a workspace root the
  host already authorized: the operator-configured roots over HTTP, the parent the
  operator just typed on the command line over CLI (pinnable with ``--root``).
* Every call needs an explicit ``confirmed`` and runs a fixed argv array under a
  hard timeout. git's stderr stays in the server log; the browser only ever sees
  a fixed reason, never a local path it did not already know.

A successful clone is recorded through the settings plugin's existing "recent
directory" preference, so the new project shows up in the workspace picker and on
the start page without a second list of grants.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

from ... import plugin_runtime
from ...process_runtime import run_external

#: A hung network clone must not pin a request thread.
CLONE_TIMEOUT_SECONDS = 300
MAX_URL_CHARS = 2048
MAX_DEST_CHARS = 4096
CLONE_KEYS = frozenset({"url", "dest", "confirmed", "root"})

_HOST = r"[A-Za-z0-9](?:[A-Za-z0-9.-]{1,253}[A-Za-z0-9])?"
_HTTPS_URL = re.compile(rf"https://{_HOST}(?::[0-9]{{1,5}})?/[!-~]+\Z")
_SSH_URL = re.compile(rf"ssh://(?:[A-Za-z_][A-Za-z0-9_.-]{{0,63}}@)?{_HOST}(?::[0-9]{{1,5}})?/[!-~]*\Z")
#: scp-style ``git@host:path``. The host needs at least two characters so a
#: Windows drive letter can never read as a remote.
_SCP_HOST = r"[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]"
_SCP_URL = re.compile(rf"(?:[A-Za-z_][A-Za-z0-9_.-]{{0,63}}@)?{_SCP_HOST}:[A-Za-z0-9._~/+][A-Za-z0-9._~/+-]*\Z")
_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z")


class CloneError(ValueError):
    """An expected clone refusal, with the status the API should report."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


#: Test-only indirection: a fixture can point an **already validated** remote at a
#: local repository so the real subprocess and registration path is exercised
#: without widening the accepted URL forms. Production never assigns to it.
URL_TRANSPORT = None


def enabled(state_dir) -> bool:
    """The clone surface works only while the git plugin is effective."""
    try:
        return plugin_runtime.is_enabled(state_dir, "git")
    except (OSError, ValueError, KeyError):
        return False


def suggested_name(url) -> str:
    """Project name for a remote, used as the default destination basename."""
    if not isinstance(url, str):
        return ""
    value = url.strip().rstrip("/")
    if not value:
        return ""
    if "://" in value:
        remainder = value.split("://", 1)[1]
        value = remainder.split("/", 1)[1] if "/" in remainder else ""
    elif ":" in value.split("/", 1)[0]:
        value = value.split(":", 1)[1]
    tail = value.rsplit("/", 1)[-1]
    if tail.endswith(".git"):
        tail = tail[:-4]
    return tail if _SAFE_NAME.match(tail) else ""


def validated_url(url) -> str:
    """Return the remote to clone, or raise with the reason it is refused."""
    if not isinstance(url, str):
        raise CloneError("仓库地址必须是文本")
    value = url.strip()
    if not value or value != url:
        raise CloneError("仓库地址不能为空或含首尾空白")
    if len(value) > MAX_URL_CHARS:
        raise CloneError("仓库地址过长")
    if value.startswith("-") or any(char in value for char in "\0\r\n\t "):
        raise CloneError("仓库地址含非法字符")
    if "://" in value:
        scheme = value.split("://", 1)[0].lower()
        if scheme == "https":
            if _HTTPS_URL.match(value):
                return value
            raise CloneError("https 地址不合法（不支持内嵌凭据、端口外的冒号或空白）")
        if scheme == "ssh" and _SSH_URL.match(value):
            return value
        raise CloneError(f"不支持的仓库地址协议：{scheme}（仅支持 https 与 ssh）")
    if _SCP_URL.match(value):
        return value
    raise CloneError("仓库地址需是 https://、ssh:// 或 user@host:path 形式的远程仓库")


def _is_broad_directory(path: Path) -> bool:
    """Refuse filesystem anchors instead of granting the whole machine."""
    try:
        anchors = {Path("/").resolve(), Path.home().resolve(),
                   Path(tempfile.gettempdir()).resolve(), Path(path.anchor).resolve()}
        if path in anchors:
            return True
        if os.name != "nt" and len(path.parts) <= 2:
            return True
        return path.is_mount()
    except (OSError, RuntimeError, ValueError):
        return True


def _allowed_roots(ctx: dict) -> tuple[Path, ...]:
    from ..settings.workspaces_api import allowed_roots
    try:
        return tuple(allowed_roots(ctx))
    except (OSError, RuntimeError, ValueError, KeyError):
        return ()


def validated_destination(dest, ctx: dict, root=None) -> Path:
    """Canonicalize the destination; ``root`` optionally pins its parent."""
    if not isinstance(dest, str):
        raise CloneError("目标目录必须是文本")
    raw = dest.strip()
    if not raw or raw != dest or len(raw) > MAX_DEST_CHARS or "\0" in raw:
        raise CloneError("目标目录不合法")
    if raw.startswith("-"):
        raise CloneError("目标目录不能以 - 开头")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise CloneError("目标目录必须是绝对路径")
    if any(part in (".", "..") for part in candidate.parts):
        raise CloneError("目标目录不能包含 . 或 ..")
    name = candidate.name
    if not _SAFE_NAME.match(name) or name == ".git":
        raise CloneError("目标目录需要一个合法的项目名")
    try:
        parent = candidate.parent.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise CloneError("目标目录的上级目录不存在") from None
    if not parent.is_dir():
        raise CloneError("目标目录的上级目录不是文件夹")
    if _is_broad_directory(parent):
        raise CloneError("请选择一个项目文件夹作为上级目录，而不是系统根目录")
    if not os.access(parent, os.W_OK | os.X_OK):
        raise CloneError("目标目录不可写")
    if root is not None:
        # Misuse guard, same shape as rewind: a declared pin must be the parent.
        if not isinstance(root, str) or not 0 < len(root) <= MAX_DEST_CHARS:
            raise CloneError("root 不合法")
        try:
            pinned = Path(root).expanduser().resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            raise CloneError("root 目录不存在") from None
        if pinned != parent:
            raise CloneError("--root 与克隆目标的上级目录不一致", 403)
    roots = _allowed_roots(ctx)
    if not any(parent == base or parent.is_relative_to(base) for base in roots):
        raise CloneError("目标目录不在已授权的工作区内", 403)
    target = parent / name
    if target.is_symlink():
        raise CloneError("目标目录是符号链接，已拒绝")
    if target.exists():
        if not target.is_dir():
            raise CloneError("目标路径已存在同名文件", 409)
        try:
            occupied = next(target.iterdir(), None)
        except OSError:
            raise CloneError("目标目录不可读", 409) from None
        if occupied is not None:
            raise CloneError("目标目录已存在且不为空", 409)
    return target


def _remember(ctx: dict, target: Path) -> None:
    """Record the new project through the settings plugin's own preference."""
    from ..settings.workspaces_api import remember_directory
    try:
        remember_directory(ctx, str(target))
    except (OSError, RuntimeError, ValueError, KeyError):
        # The clone itself succeeded; a lost preference must not pretend otherwise.
        print(f"[git.clone] cannot register {target} as a recent workspace", flush=True)


def clone_repository(url, dest, ctx: dict, *, confirmed=None, root=None,
                     timeout: int = CLONE_TIMEOUT_SECONDS) -> dict:
    """Clone ``url`` into ``dest`` and register the result as a workspace."""
    state_dir = ctx.get("state_dir")
    if state_dir is None or not enabled(state_dir):
        raise CloneError("plugin disabled or dependency unavailable: git", 403)
    if confirmed is not True:
        raise CloneError("请确认后再克隆仓库")
    remote = validated_url(url)
    target = validated_destination(dest, ctx, root)
    argv = ["git", "-c", "protocol.ext.allow=never", "clone", "--",
            URL_TRANSPORT(remote) if URL_TRANSPORT else remote, str(target)]
    # No prompts of any kind: a credential or host-key question would otherwise
    # hang the request thread. Key-based ssh keeps working under BatchMode.
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "",
           "SSH_ASKPASS": "", "GIT_PAGER": "cat", "LC_ALL": "C"}
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    try:
        proc = run_external(
            subprocess.run, argv, cwd=str(target.parent), env=env,
            stdin=subprocess.DEVNULL, capture_output=True, text=True,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    except FileNotFoundError:
        raise CloneError("git 不可用：运行环境未安装 git", 501) from None
    except subprocess.TimeoutExpired:
        raise CloneError(f"克隆超时（超过 {timeout} 秒）", 409) from None
    except OSError:
        raise CloneError("克隆未能启动", 400) from None
    if proc.returncode != 0:
        # stderr carries the remote and local paths: log it, never echo it.
        print(f"[git.clone] git clone rc={proc.returncode}: "
              f"{(proc.stderr or '').strip()[:500]}", flush=True)
        raise CloneError("克隆失败：无法访问该仓库或仓库内容无法检出", 409)
    if not target.is_dir():
        raise CloneError("克隆未能写入目标目录", 409)
    _remember(ctx, target)
    return {"cloned": str(target), "root": str(target), "url": remote}


def dispatch(method, parts, query, data, ctx):
    """``POST /api/git/clone``; ``None`` means "not ours".

    The host maps the ``git/clone`` family to this plugin, applies Host/Origin/
    CSRF and refuses the call while git is disabled; ``clone_repository`` re-reads
    the switch because the CLI reaches the same function.
    """
    if not isinstance(parts, list) or len(parts) != 3 or parts[:2] != ["api", "git"]:
        return None
    if parts[2] != "clone":
        return None
    if method != "POST":
        return 405, {"error": "method not allowed"}
    if not isinstance(data, dict) or set(data) - CLONE_KEYS or "confirmed" not in data:
        return 400, {"error": "expected url, dest and confirmed"}
    root = data.get("root")
    if root is not None and (not isinstance(root, str) or not 0 < len(root) <= MAX_DEST_CHARS):
        return 400, {"error": "invalid root"}
    try:
        return 200, clone_repository(data.get("url"), data.get("dest"), ctx,
                                     confirmed=data.get("confirmed"), root=root)
    except CloneError as exc:
        return exc.status, {"error": str(exc)}
    except (OSError, ValueError, KeyError):
        return 400, {"error": "cannot clone repository"}
