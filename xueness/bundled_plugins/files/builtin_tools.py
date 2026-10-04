"""Xueness-owned builtin tool registry: the typed seam behind ``core.execute``.

Why this exists: the base tool table (schemas) and the ``execute`` dispatch were
one hardwired block inside ``core.py``. The four opt-in capabilities already had
a plugin seam (:mod:`xueness.plugins`), but the *base* tools -- the ones every
run has -- did not: adding or retyping a tool meant editing a schema list and an
if/elif chain in the same file, and nothing tied the two together.

This module is the base counterpart to that capability seam. Each builtin tool
is one :class:`BuiltinTool` value carrying its name, description, JSON schema,
required arguments, the Gate "kind" it must be authorised under, and the handler
that runs it. :func:`tool_schemas` derives the provider-facing schema list from
the same entries that :func:`dispatch` routes to, so a tool cannot be advertised
without a handler or handled without a schema.

Hard boundaries (deliberately *not* a general plugin system):

* **No arbitrary code.** The registry is a static table owned by this repo. There
  is no entry point that imports a module named by data, no ``__import__`` on a
  user string, no ``eval``/``exec`` of plugin code, and no dynamic discovery.
  Adding a tool is a code change reviewed like any other.
* **Deny-by-default is untouched.** Handlers call ``Gate.check`` themselves, so
  the plan-mode denial and the one-shot approval lookup keep running inside the
  tool call where they always did. ``dispatch`` never grants anything; it only
  routes.
* **Stable error contract.** ``dispatch`` keeps the exact outer guard from the
  old ``execute``: a tool that raises OSError/ValueError/KeyError/PermissionError
  /TimeoutExpired still degrades to ``{"ok": False, "error": ...}`` with
  ``PermissionError`` reported as ``"denied"``. Unknown names still raise
  ``ValueError("unknown tool")`` -> ``{"ok": False, "error": "ValueError"}``.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from ...write_lock import DEFAULT_LOCKS, owner_for
from ...tool_contract import BuiltinTool
from ...resources import _is_link

#: Caps for the read-only search tools.
MAX_GLOB_HITS = 200
MAX_GREP_HITS = 200
MAX_GREP_PER_FILE = 20
#: Session-scoped todo cap and the only accepted statuses.



def path_in(root: Path, name: str) -> Path:
    target = (root / name).resolve()
    if not target.is_relative_to(root.resolve()):
        raise PermissionError("path outside workspace")
    return target


def _walk_files(root: Path, base: Path):
    """Yield resolved-inside files under base in deterministic sorted order.

    Never follows symlinked directories; skips entries resolving outside root.
    """
    resolved_root = root.resolve()
    stack = [base]
    while stack:
        current = stack.pop(0)
        try:
            entries = sorted(current.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for entry in entries:
            try:
                if (entry.is_symlink()
                        or getattr(entry.lstat(), "st_file_attributes", 0) & 0x400):
                    resolved = entry.resolve()
                    if not resolved.is_relative_to(resolved_root):
                        continue
                    if resolved.is_dir():
                        continue  # never descend through symlinked dirs
                    if resolved.is_file():
                        yield resolved
                    continue
                if entry.is_dir():
                    stack.append(entry)
                elif entry.is_file():
                    yield entry.resolve()
            except OSError:
                continue


def glob_search(root: Path, pattern: str, base: str = ".") -> dict:
    from fnmatch import fnmatch as _fnmatch
    from pathlib import PureWindowsPath
    if not isinstance(pattern, str) or not pattern.strip() or len(pattern) > 1024:
        raise ValueError("pattern must be a nonempty string")
    normalized_pattern = pattern.replace("\\", "/")
    windows_pattern = PureWindowsPath(pattern)
    if (Path(pattern).is_absolute() or normalized_pattern.startswith("/")
            or windows_pattern.drive
            or any(part == ".." for part in normalized_pattern.split("/"))):
        raise ValueError("pattern must be relative")
    target = path_in(root, base)
    if not target.is_dir():
        raise ValueError("not a directory")
    rels: list = []
    for resolved in _walk_files(root, target):
        rel = resolved.relative_to(root.resolve()).as_posix()
        if _fnmatch(rel, pattern) or _fnmatch(resolved.name, pattern):
            rels.append(rel)
    rels = sorted(set(rels))
    return {"ok": True, "pattern": pattern, "output": rels[:MAX_GLOB_HITS],
            "truncated": len(rels) > MAX_GLOB_HITS, "count": len(rels)}


def grep_search(root: Path, pattern: str, base: str = ".", include: str | None = None) -> dict:
    from fnmatch import fnmatch as _fnmatch
    if not isinstance(pattern, str) or not pattern or len(pattern) > 1024:
        raise ValueError("pattern must be a nonempty string")
    try:
        regex = re.compile(pattern)
    except re.error:
        raise ValueError("invalid regex")
    target = path_in(root, base)
    resolved_root = root.resolve()
    candidates: list = []
    if target.is_file():
        resolved = target.resolve()
        if not resolved.is_relative_to(resolved_root):
            raise PermissionError("path outside workspace")
        candidates = [resolved]
    elif target.is_dir():
        candidates = list(_walk_files(root, target))
    else:
        raise ValueError("not a file or directory")
    hits: list = []
    truncated = False
    for resolved in sorted(candidates, key=lambda p: p.relative_to(resolved_root).as_posix()):
        rel = resolved.relative_to(resolved_root).as_posix()
        if include and not (_fnmatch(rel, include) or _fnmatch(resolved.name, include)):
            continue
        try:
            if resolved.stat().st_size > 1_000_000:
                continue
            text = resolved.read_text(encoding="utf-8")
        except (OSError, ValueError, UnicodeDecodeError):
            continue
        per_file = 0
        for lineno, line in enumerate(text.splitlines(), 1):
            try:
                found = regex.search(line)
            except re.error:
                raise ValueError("invalid regex")
            if found:
                hits.append({"path": rel, "line": lineno, "text": line[:500]})
                per_file += 1
                if len(hits) >= MAX_GREP_HITS:
                    truncated = True
                    break
                if per_file >= MAX_GREP_PER_FILE:
                    break
        if len(hits) >= MAX_GREP_HITS:
            truncated = True
            break
    return {"ok": True, "pattern": pattern, "output": hits, "truncated": truncated, "count": len(hits)}


def _check_path(gate, kind: str, path: str, call_id: "str | None") -> None:
    """Gate one path-scoped call, binding the approval id only for mutators.

    Read-only path tools (read/list/glob/grep) stay id-agnostic. write/edit are
    approval-bearing, so a web-approval gate gets the tool-call id it must bind
    the one-shot approval to.
    """
    if getattr(gate, "web_approval_gate", False) and kind in ("write", "edit"):
        gate.check(kind, path, call_id)
    else:
        gate.check(kind, path)


def _mutating_target(gate, root, path: str) -> Path:
    """Resolve a write/edit target without ever widening the workspace jail.

    The one out-of-workspace exception is the session plan draft, which the
    owning plugin binds to the gate; it is matched by exact path only, and a
    link standing at that spot is refused rather than followed.
    """
    resolve_draft = getattr(gate, "plan_draft_target", None)
    if callable(resolve_draft):
        draft = resolve_draft(path)
        if draft is not None:
            draft = Path(draft)
            if _is_link(draft) or _is_link(draft.parent):
                raise PermissionError("plan draft must not be a link or reparse point")
            return draft
    return path_in(root, path)


def _glob(root, gate, args, session, call_id) -> dict:
    base = args.get("path", ".")
    if not isinstance(base, str):
        raise ValueError("path must be a string")
    gate.check("glob", base)
    path_in(root, base)  # workspace jail before any read
    pattern = args["pattern"]
    if not isinstance(pattern, str):
        raise ValueError("pattern must be a string")
    return glob_search(root, pattern, base)


def _grep(root, gate, args, session, call_id) -> dict:
    base = args.get("path", ".")
    if not isinstance(base, str):
        raise ValueError("path must be a string")
    gate.check("grep", base)
    path_in(root, base)  # workspace jail before any read
    pattern = args["pattern"]
    if not isinstance(pattern, str):
        raise ValueError("pattern must be a string")
    include = args.get("include")
    if include is not None and not isinstance(include, str):
        raise ValueError("include must be a string")
    return grep_search(root, pattern, base, include)


def _read(root, gate, args, session, call_id) -> dict:
    path = args["path"]
    if not isinstance(path, str):
        raise ValueError("path must be a string")
    _check_path(gate, "read", path, call_id)
    target = path_in(root, path)
    if not target.is_file():
        raise ValueError("not a file")
    from ..providers.lightweight_config import session_options
    options = session_options(session)
    offset, limit = args.get('offset', 0), args.get('limit', options.get('fileReadChars', 12000))
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 12000:
        raise ValueError('invalid file page')
    # Count characters while retaining only the requested page. A large local
    # file must not allocate its entire contents in a small-memory agent host.
    total, fragments = 0, []
    with target.open(encoding='utf-8') as stream:
        while chunk := stream.read(65536):
            end = total + len(chunk)
            if end > offset and total < offset + limit:
                fragments.append(chunk[max(0, offset - total):max(0, min(len(chunk), offset + limit - total))])
            total = end
    page = ''.join(fragments)
    result = {"ok": True, "path": path, "output": page, "truncated": offset + len(page) < total}
    if 'offset' in args or 'limit' in args or options:
        result.update({'offset': offset, 'totalChars': total,
                       'nextOffset': offset + len(page) if result['truncated'] else None})
    return result


def _list(root, gate, args, session, call_id) -> dict:
    path = args["path"]
    if not isinstance(path, str):
        raise ValueError("path must be a string")
    _check_path(gate, "list", path, call_id)
    target = path_in(root, path)
    if not target.is_dir():
        raise ValueError("not a directory")
    return {"ok": True, "path": path, "output": sorted(p.name for p in target.iterdir())[:200]}


def _edit(root, gate, args, session, call_id) -> dict:
    path = args["path"]
    if not isinstance(path, str):
        raise ValueError("path must be a string")
    _check_path(gate, "edit", path, call_id)
    target = _mutating_target(gate, root, path)
    old = args["old"]
    new = args["new"]
    if not isinstance(old, str) or not old:
        raise ValueError("old must be a nonempty string")
    if not isinstance(new, str) or len(new) > 200000:
        raise ValueError("new must be a string of at most 200000 characters")
    if not target.is_file():
        raise ValueError("not a file")
    # Same lock as write: an edit is a read-modify-write and races identically.
    owner = owner_for(session)
    if not DEFAULT_LOCKS.acquire(target, owner):
        return {"ok": False, "conflict": True,
                "error": "path busy: held by %s" % (DEFAULT_LOCKS.holder(target) or "another writer")}
    try:
        text = target.read_text(encoding="utf-8")
        count = text.count(old)
        if count == 0:
            raise ValueError("no match for old string")
        if count > 1:
            raise ValueError("old string matches multiple occurrences; refine it")
        target.write_text(text.replace(old, new, 1), encoding="utf-8")
    finally:
        DEFAULT_LOCKS.release(target, owner)
    return {"ok": True, "path": path, "output": f"replaced 1 occurrence ({len(old)} -> {len(new)} chars)"}


def _write(root, gate, args, session, call_id) -> dict:
    path = args["path"]
    if not isinstance(path, str):
        raise ValueError("path must be a string")
    _check_path(gate, "write", path, call_id)
    target = _mutating_target(gate, root, path)
    content = args["content"]
    if not isinstance(content, str) or len(content) > 200000:
        raise ValueError("content must be a string of at most 200000 characters")
    # One writer per resolved path, across sessions: two runs aiming at the same
    # file (via different spellings of the path) must not both believe they won.
    owner = owner_for(session)
    if not DEFAULT_LOCKS.acquire(target, owner):
        return {"ok": False, "conflict": True,
                "error": "path busy: held by %s" % (DEFAULT_LOCKS.holder(target) or "another writer")}
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        # Recheck after creating parent: symlink races still require a real sandbox.
        _mutating_target(gate, root, path)
        target.write_text(content, encoding="utf-8")
    finally:
        DEFAULT_LOCKS.release(target, owner)
    return {"ok": True, "path": path, "output": f"wrote {len(content)} characters"}


REGISTRY: tuple[BuiltinTool, ...] = (
    BuiltinTool("read", "Read a UTF-8 file inside the workspace",
                {"path": {"type": "string"}, "offset": {"type": "integer", "description": "Character offset, default 0"},
                 "limit": {"type": "integer", "description": "Maximum characters, 1..12000"}}, ("path",), "read", False, _read),
    BuiltinTool("list", "List files inside the workspace",
                {"path": {"type": "string"}}, ("path",), "list", False, _list),
    BuiltinTool("glob", "List paths matching a glob pattern inside the workspace (read-only, capped, sorted)",
                {"pattern": {"type": "string"}, "path": {"type": "string"}}, ("pattern",), "glob", False, _glob),
    BuiltinTool("grep", "Search file contents with a regex inside the workspace (read-only, capped, sorted)",
                {"pattern": {"type": "string"}, "path": {"type": "string"}, "include": {"type": "string"}},
                ("pattern",), "grep", False, _grep),
    BuiltinTool("write", "Write a UTF-8 file inside the workspace (approval required)",
                {"path": {"type": "string"}, "content": {"type": "string"}}, ("path", "content"),
                "write", True, _write),
    BuiltinTool("edit", "Replace exactly one occurrence in a workspace file (approval required)",
                {"path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"}},
                ("path", "old", "new"), "edit", True, _edit),
)
