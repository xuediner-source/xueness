"""Read-only discovery of directory-shaped skills (``<name>/SKILL.md``).

Layout, highest precedence first. A row whose ``name`` was already claimed by a
higher source is reported as ``shadowed`` instead of silently dropped::

    <workspace>/.xueness/skills/<name>/SKILL.md    project
    <workspace>/.zcode/skills/<name>/SKILL.md      project-compat (read-only)
    <state_dir>/skills/<name>/SKILL.md             user
    <state_dir>/resources/skills/<id>.json         resource (existing store)

``SKILL.md`` frontmatter is parsed as *plain text*: only a block fenced by
``---`` holding top-level ``key: value`` lines is understood, plus the folded
and literal block scalars real skill files use for a long ``description``. No
YAML dependency is added and no content of a skill directory is ever executed,
imported or written. Attachments are reported as names and sizes only; their
bytes are never read.

Every path is refused when the entry itself is a symlink or Windows reparse
point, and every resolved path must stay inside the skill root it came from, so
a redirected directory cannot move the jail somewhere else. Containment uses
the shared host-path comparison: Windows and macOS treat case variants as the
same path, and Linux does not. A mismatch is still a refusal.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from ...resources import _is_link
from ...write_lock import host_path_contained

SKILL_FILE_NAME = "SKILL.md"

#: Lowercase letters, digits and dashes, at most 64 characters.
NAME_PATTERN = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\Z")
NAME_MAX_CHARS = 64
DESCRIPTION_MAX_CHARS = 1024
TAG_MAX_CHARS = 32
MAX_TAGS = 16

#: One ``SKILL.md`` is read as text, never executed; the cap bounds the cost of
#: a hostile or accidentally enormous file.
MAX_SKILL_FILE_BYTES = 256 * 1024
#: Directories read per root, so one redirected tree cannot stall a listing.
MAX_SKILLS_PER_ROOT = 128
MAX_ATTACHMENTS_PER_SKILL = 32

SOURCE_PRIORITY = {"project": 0, "project-compat": 1, "user": 2, "resource": 3}
SCOPE_BY_SOURCE = {"project": "project", "project-compat": "project",
                   "user": "user", "resource": "resource"}


def diagnostic(code: str, severity: str, message: str, path=None) -> dict:
    """One structured finding; a broken entry is an answer, never an exception."""
    item = {"code": code, "severity": severity, "message": message}
    if path is not None:
        item["path"] = str(path)
    return item


def _contained(child: Path, parent: Path) -> bool:
    return host_path_contained(child, parent)


def _real(path) -> Path | None:
    try:
        return Path(path).resolve()
    except OSError:
        return None


def skill_roots(state_dir, root=None, *, include_compat: bool = True) -> list:
    """Every skill root to scan, with the workspace or state jail behind it."""
    items = []
    jail = _real(Path(state_dir))
    if root is not None:
        workspace = _real(root)
        if workspace is not None:
            items.append(("project", workspace / ".xueness" / "skills", workspace))
            if include_compat:
                items.append(("project-compat", workspace / ".zcode" / "skills", workspace))
    if jail is not None and not _is_link(Path(state_dir)):
        items.append(("user", jail / "skills", jail))
    return items


# -- frontmatter -------------------------------------------------------------

_KEY = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_BLOCK_FOLD = re.compile(r">[-+]?\Z")
_BLOCK_LITERAL = re.compile(r"\|[-+]?\Z")


def _split_lines(text: str) -> list:
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _unquote(value: str) -> str:
    for quote in ('"', "'"):
        if len(value) >= 2 and value.startswith(quote) and value.endswith(quote):
            return value[1:-1].strip()
    return value


def _block_scalar(lines: list, start: int, end: int, literal: bool):
    """Consume the indented block after ``key: >`` / ``key: |`` as plain text."""
    collected = []
    index = start
    while index < end:
        line = lines[index]
        if line.strip() and not line[:1].isspace():
            break
        collected.append(line.strip())
        index += 1
    while collected and not collected[-1]:
        collected.pop()
    joined = "\n".join(collected) if literal else " ".join(item for item in collected if item)
    return joined.strip(), index


def parse_frontmatter(text: str):
    """Return ``(values, keys, error)`` for a leading ``---`` block.

    ``error`` is ``skill_missing_frontmatter``, ``skill_unclosed_frontmatter``
    or ``skill_invalid_frontmatter`` when the block is absent, unterminated or
    holds nothing readable; one unusable line never hides the other keys.
    """
    lines = _split_lines(text.lstrip("﻿"))
    if not lines or lines[0].strip() != "---":
        return {}, [], "skill_missing_frontmatter"
    end = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    if end is None:
        return {}, [], "skill_unclosed_frontmatter"
    values: dict = {}
    keys: list = []
    broken = 0
    index = 1
    while index < end:
        line = lines[index]
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or line[:1].isspace():
            index += 1
            continue
        head, separator, tail = line.partition(":")
        key = head.strip().lower()
        if not separator or not _KEY.match(key):
            broken += 1
            index += 1
            continue
        value = tail.strip()
        literal = bool(_BLOCK_LITERAL.match(value))
        if literal or _BLOCK_FOLD.match(value):
            value, index = _block_scalar(lines, index + 1, end, literal)
        else:
            value = _unquote(value)
            index += 1
        keys.append(key)
        values[key] = value
    if broken and not values:
        return values, keys, "skill_invalid_frontmatter"
    return values, keys, None


def _tags(value: str) -> list:
    text = str(value or "").strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    items = []
    for piece in text.split(","):
        tag = _unquote(piece.strip())
        if tag and len(tag) <= TAG_MAX_CHARS and tag not in items:
            items.append(tag)
    return items[:MAX_TAGS]


def validate_frontmatter(values: dict, keys: list, path=None):
    """The name/description rules every discovered row must satisfy.

    Returns ``(meta, None)`` or ``(None, diagnostic)``; a caller that cannot
    produce a usable row still reports why in structured form.
    """
    name = str(values.get("name") or "").strip()
    if not name:
        return None, diagnostic("skill_missing_name", "error",
                                "SKILL.md frontmatter needs a name", path)
    if len(name) > NAME_MAX_CHARS or not NAME_PATTERN.match(name):
        return None, diagnostic("skill_invalid_name", "error",
                                "skill name must be lowercase letters, digits and dashes, "
                                "at most %d characters: %s" % (NAME_MAX_CHARS, name), path)
    description = str(values.get("description") or "").strip()
    if not description:
        return None, diagnostic("skill_missing_description", "error",
                                "SKILL.md frontmatter needs a description: %s" % name, path)
    if len(description) > DESCRIPTION_MAX_CHARS:
        return None, diagnostic("skill_description_too_long", "error",
                                "skill description is longer than %d characters: %s"
                                % (DESCRIPTION_MAX_CHARS, name), path)
    return {"name": name, "description": description, "tags": _tags(values.get("tags", "")),
            "keys": list(dict.fromkeys(keys))}, None


# -- scanning ----------------------------------------------------------------

def _read_text(path: Path, max_bytes: int):
    """Read one non-link file as text, refusing to follow a redirect."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None, None, "skill_unreadable"
    try:
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read(max_bytes + 1)
    except OSError:
        return None, None, "skill_unreadable"
    if len(raw) > max_bytes:
        return None, len(raw), "skill_file_too_large"
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None, len(raw), "skill_invalid_encoding"
    return text, len(raw), None


def _attachments(directory: Path, jail: Path):
    """Names and sizes of the sibling files; their content is never read."""
    items = []
    truncated = False
    try:
        entries = sorted(directory.iterdir(), key=lambda child: child.name)
    except OSError:
        return items, False
    for entry in entries:
        if entry.name == SKILL_FILE_NAME or entry.name.startswith("."):
            continue
        if _is_link(entry):
            continue
        try:
            if not entry.is_file() or not _contained(_real(entry) or entry, jail):
                continue
            size = entry.lstat().st_size
        except OSError:
            continue
        if len(items) >= MAX_ATTACHMENTS_PER_SKILL:
            truncated = True
            break
        items.append({"name": entry.name, "bytes": int(size)})
    return items, truncated


def _row(source: str, directory: Path, base: Path, meta: dict, size: int,
         attachments: list, attachments_truncated: bool) -> dict:
    name = meta["name"]
    return {"id": "file:%s:%s" % (source, name), "name": name,
            "description": meta["description"], "tags": meta["tags"],
            "frontmatterKeys": meta["keys"], "source": source,
            "scope": SCOPE_BY_SOURCE.get(source, "user"),
            "path": str(directory / SKILL_FILE_NAME), "directory": str(directory),
            "rootPath": str(base), "bytes": int(size),
            "attachments": attachments,
            "attachmentsTruncated": bool(attachments_truncated),
            "shadowed": False, "shadowedBy": None}


def _read_entry(source: str, base: Path, jail: Path, directory: Path):
    """One ``<directory>/SKILL.md`` as a row, or a diagnostic explaining why not."""
    path = directory / SKILL_FILE_NAME
    if _is_link(path):
        return None, diagnostic("skill_file_symlink", "warning",
                                "SKILL.md must not be a link: %s" % directory.name, path)
    resolved = _real(path)
    if resolved is None or not _contained(resolved, base):
        return None, diagnostic("skill_escapes_root", "error",
                                "skill path leaves its skill root: %s" % directory.name, path)
    text, size, failure = _read_text(path, MAX_SKILL_FILE_BYTES)
    if failure:
        detail = " (%d bytes)" % size if failure == "skill_file_too_large" and size else ""
        return None, diagnostic(failure, "error",
                                "SKILL.md could not be read as text%s: %s"
                                % (detail, directory.name), path)
    values, keys, error = parse_frontmatter(text)
    if error:
        return None, diagnostic(error, "error",
                                "SKILL.md frontmatter is unusable: %s" % directory.name, path)
    meta, invalid = validate_frontmatter(values, keys, path)
    if invalid:
        return None, invalid
    attachments, truncated = _attachments(directory, jail)
    return _row(source, directory, base, meta, size or 0, attachments, truncated), None


def _scan_root(source: str, base: Path, jail: Path, diagnostics: list,
               limit: int = MAX_SKILLS_PER_ROOT) -> list:
    if _is_link(base):
        diagnostics.append(diagnostic("skill_root_symlink", "error",
                                      "skill root must not be a link", base))
        return []
    resolved = _real(base)
    if resolved is None:
        diagnostics.append(diagnostic("skill_root_unreadable", "warning",
                                      "skill root could not be resolved", base))
        return []
    if not _contained(resolved, jail):
        diagnostics.append(diagnostic("skill_root_escapes", "error",
                                      "skill root resolves outside its workspace", base))
        return []
    if not base.is_dir():
        return []
    try:
        candidates = sorted(base.iterdir(), key=lambda child: child.name)
    except OSError as exc:
        diagnostics.append(diagnostic("skill_root_unreadable", "warning",
                                      "skill root could not be listed: %s" % exc, base))
        return []
    rows = []
    for directory in candidates:
        if directory.name.startswith("."):
            continue
        if _is_link(directory):
            diagnostics.append(diagnostic("skill_directory_symlink", "warning",
                                          "skill directory must not be a link: %s"
                                          % directory.name, directory))
            continue
        try:
            if not directory.is_dir():
                continue
        except OSError:
            continue
        row, issue = _read_entry(source, resolved, jail, directory)
        if issue:
            diagnostics.append(issue)
            continue
        if len(rows) >= limit:
            diagnostics.append(diagnostic("skill_root_limit", "warning",
                                          "only the first %d skills are read from this root"
                                          % limit, base))
            break
        rows.append(row)
    return rows


def discover(state_dir, root=None, *, include_compat: bool = True,
             limit: int = MAX_SKILLS_PER_ROOT) -> dict:
    """Every usable directory-shaped skill, highest precedence first."""
    rows: list = []
    diagnostics: list = []
    for source, base, jail in skill_roots(state_dir, root, include_compat=include_compat):
        rows.extend(_scan_root(source, base, jail, diagnostics, limit=limit))
    return {"skills": rows, "diagnostics": diagnostics}


# -- merging with the resource store ----------------------------------------

def _claim_keys(row: dict) -> list:
    keys = [str(row.get("name") or "").lower()]
    if row.get("source") == "resource":
        keys.append(str(row.get("id") or "").lower())
    return [key for key in dict.fromkeys(keys) if key]


def _sort_key(row: dict):
    return (str(row.get("name") or "").lower(),
            SOURCE_PRIORITY.get(row.get("source"), 9), str(row.get("id")))


def merge(resource_rows: list, file_rows: list) -> list:
    """Rows from both families, name collisions resolved by precedence."""
    claimed: dict = {}
    rows = []
    for row in sorted([*file_rows, *resource_rows], key=_sort_key):
        winner = next((claimed[key] for key in _claim_keys(row) if key in claimed), None)
        if winner is not None:
            rows.append({**row, "shadowed": True, "shadowedBy": winner})
            continue
        for key in _claim_keys(row):
            claimed[key] = row.get("source")
        rows.append(row)
    return rows


def find(rows: list, key) -> dict | None:
    """The winning row whose id or name equals ``key`` exactly.

    Matching stays exact so ``skill_read`` keeps its "by exact catalog id"
    contract: a lookup value is never treated as a path or a glob.
    """
    if not isinstance(key, str) or not key:
        return None
    for row in rows:
        if row.get("shadowed"):
            continue
        if key in (row.get("id"), row.get("name")):
            return row
    return None


def strip_frontmatter(text: str) -> str:
    lines = _split_lines(text.lstrip("﻿"))
    if not lines or lines[0].strip() != "---":
        return text
    end = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    if end is None:
        return text
    return "\n".join(lines[end + 1:])


def read_body(row: dict, *, max_bytes: int = MAX_SKILL_FILE_BYTES) -> dict:
    """Re-check the jail at read time, then return the ``SKILL.md`` text body.

    A row may come from an older listing, so the link and containment guards run
    again here instead of trusting ``row['path']``.
    """
    path = Path(str(row.get("path") or ""))
    base = Path(str(row.get("rootPath") or ""))
    if _is_link(path):
        return {"ok": False, "error": "SKILL.md must not be a link"}
    resolved = _real(path)
    jail = _real(base)
    if resolved is None or jail is None or not _contained(resolved, jail):
        return {"ok": False, "error": "skill path leaves its skill root"}
    text, size, failure = _read_text(path, max_bytes)
    if failure:
        return {"ok": False, "error": "SKILL.md could not be read (%s)" % failure}
    body = strip_frontmatter(text).strip()
    return {"ok": True, "content": body, "bytesRead": int(size or 0), "sizeBytes": int(size or 0)}
