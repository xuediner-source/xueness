"""Read-only git panel API for the Xueness workbench.

When a session workspace happens to be a git repository, the Git panel shows
the current branch and working-tree state, the *real* working-tree diff (as
opposed to the journal-derived intent diff), and recent commits. Everything
here is strictly read-only:

* The argv whitelist below only ever runs ``status`` / ``diff`` / ``log``
  behind ``--no-optional-locks``. There is no code path that can add, commit,
  checkout, restore, stash, push, pull, fetch, merge, rebase, clean or reset —
  mutating the workspace is the approval-gated tool layer's job, never this
  panel's.
* Every command runs through ``subprocess.run`` with an argv array (no shell),
  a hard 10s timeout, and ``cwd`` pinned to the session workspace root.
* Error bodies are fixed strings: stderr text (which contains local paths) is
  printed to the server log only, never echoed to the browser.

Routes (``GET`` only)::

    GET /api/sessions/<32-hex sid>/git/status
        -> {"branch": str, "entries": [{"code": "XY", "path": str}], "clean": bool}
    GET /api/sessions/<32-hex sid>/git/diff
        -> {"stat": str, "patch": str, "truncated": bool}
    GET /api/sessions/<32-hex sid>/git/log
        -> {"commits": [{"hash", "short", "author", "date", "subject"}]}

Standard library only.
"""
from __future__ import annotations

import os
import re
import subprocess

GIT_TIMEOUT = 10  # seconds; a hung git must not pin a request thread
MAX_PATCH_CHARS = 200_000  # hard cap on the patch text sent to the browser
SID_RE = re.compile(r"[0-9a-f]{32}")
VERBS = ("status", "diff", "log")


class GitApiError(Exception):
    """Typed failure so ``dispatch`` can map it onto a fixed (status, body)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _run_git(root: str, argv: list, *, empty_repo_ok: bool = False) -> subprocess.CompletedProcess:
    """Run one read-only git command inside the workspace; map failures to errors.

    ``empty_repo_ok`` lets ``log`` accept the "no commits yet" exit instead of
    reporting it as a failure: an empty repository is a valid panel state, not
    an error.
    """
    try:
        # git 只读本地命令（status/diff/log 不联网、不拉取），继承进程环境即可。
        proc = subprocess.run(
            ["git", *argv],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT,
            env=dict(os.environ),
        )
    except FileNotFoundError:
        # At this point the workspace root is known to exist, so a missing
        # executable is the only realistic cause: git is simply not installed.
        raise GitApiError(501, "git 不可用：运行环境未安装 git")
    except subprocess.TimeoutExpired:
        print(f"[git_api] git {argv} timed out after {GIT_TIMEOUT}s", flush=True)
        raise GitApiError(400, "git 命令失败")
    except OSError as exc:
        print(f"[git_api] git {argv} failed to start: {exc}", flush=True)
        raise GitApiError(400, "git 命令失败")
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        # ``git diff`` phrases it as "warning: Not a git repository..." (rc 129,
        # usage dump attached); ``git status``/``log`` as "fatal: not a git
        # repository" (rc 128). Match case-insensitively on purpose.
        if "not a git repository" in stderr.lower():
            raise GitApiError(404, "该工作区不是 git 仓库")
        if empty_repo_ok and "does not have any commits" in stderr:
            return proc  # caller reads stdout (empty) -> commits=[]
        # Details stay server-side: stderr carries absolute local paths.
        print(f"[git_api] git {argv} rc={proc.returncode}: {stderr[:500]}", flush=True)
        raise GitApiError(400, "git 命令失败")
    return proc


def _parse_branch(head: str) -> str:
    """Branch name from the ``## `` line of ``status --porcelain=v1 -b``."""
    head = head.strip()
    if "HEAD (no branch)" in head:
        return "HEAD (detached)"
    if head.startswith("No commits yet on "):
        return head[len("No commits yet on "):].strip()
    # ``## main...origin/main [ahead 1]`` -> ``main``
    return head.split("...", 1)[0].split()[0] if head.split() else ""


def _git_status(root: str) -> dict:
    proc = _run_git(root, ["--no-optional-locks", "status", "--porcelain=v1", "-b"])
    lines = (proc.stdout or "").splitlines()
    branch = ""
    entries: list[dict] = []
    for index, line in enumerate(lines):
        if not line:
            continue
        if index == 0 and line.startswith("##"):
            branch = _parse_branch(line[2:])
            continue
        # Porcelain v1 rows are ``XY <path>``; keep the path verbatim (a rename
        # stays ``old -> new``) so the panel never reinterprets git's output.
        entries.append({"code": line[:2], "path": line[3:]})
    return {"branch": branch, "entries": entries, "clean": len(entries) == 0}


def _git_diff(root: str) -> dict:
    stat = _run_git(root, ["--no-optional-locks", "diff", "--stat"]).stdout or ""
    patch = _run_git(root, ["--no-optional-locks", "diff", "-U3"]).stdout or ""
    truncated = False
    if len(patch) > MAX_PATCH_CHARS:
        # No --binary on purpose: binary blobs would arrive as mojibake; the
        # default output already reduces them to one "Binary files differ" line.
        patch = patch[:MAX_PATCH_CHARS]
        truncated = True
    return {"stat": stat, "patch": patch, "truncated": truncated}


def _git_log(root: str) -> dict:
    argv = [
        "--no-optional-locks", "log", "-n", "20",
        "--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e",
    ]
    proc = _run_git(root, argv, empty_repo_ok=True)
    commits: list[dict] = []
    for record in (proc.stdout or "").split("\x1e"):
        fields = record.strip("\n").split("\x1f")
        if len(fields) != 5 or not all(fields):
            continue  # 解析失败的条目跳过，不让一条脏数据弄垮整个面板
        commits.append({
            "hash": fields[0],
            "short": fields[1],
            "author": fields[2],
            "date": fields[3],
            "subject": fields[4],
        })
    return {"commits": commits}


_HANDLERS = {
    "status": _git_status,
    "diff": _git_diff,
    "log": _git_log,
}


def dispatch(method: str, parts: list, query: dict, data: dict, ctx: dict):
    """Handle ``GET /api/sessions/<sid>/git/<verb>``; ``None`` means "not ours".

    The route owns exactly ``["api", "sessions", <32-hex sid>, "git", verb]``
    with ``verb`` in ``{"status", "diff", "log"}``. Anything else (other shapes,
    other verbs, unknown methods on unclaimed paths) falls through as ``None``;
    a *claimed* path with a non-GET method is a 405.
    """
    if not isinstance(parts, list) or len(parts) != 5:
        return None
    if parts[0] != "api" or parts[1] != "sessions" or parts[3] != "git":
        return None
    sid, verb = parts[2], parts[4]
    if verb not in VERBS:
        return None
    if method != "GET":
        return 405, {"error": "method not allowed"}
    if not isinstance(sid, str) or not SID_RE.fullmatch(sid):
        return None
    try:
        session = ctx["store"].load(sid)
    except (OSError, ValueError, KeyError):
        return 404, {"error": "session not found"}
    root = session.get("root") if isinstance(session, dict) else None
    # A workspace root that is not an existing directory cannot be a git
    # repository either, so the honest answer is the same not-a-repo state.
    if not isinstance(root, str) or not root or not os.path.isdir(root):
        return 404, {"error": "该工作区不是 git 仓库"}
    try:
        return 200, _HANDLERS[verb](root)
    except GitApiError as exc:
        return exc.status, {"error": exc.message}
