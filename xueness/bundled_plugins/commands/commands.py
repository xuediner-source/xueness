"""Slash-command loading and expansion (Stage 5 contract).

Users define slash commands in the settings page; when they type ``/name args``
in chat the text is expanded into the stored prompt before it ever reaches the
model. Like ``skills.py`` the loader is strictly read-only: nothing is written
here, every file is opened with ``O_NOFOLLOW`` so a symlink can never pull in an
unrelated file, and every loaded value is untrusted data that must never
override system, task, or safety instructions.

Storage layout (Stage 2 ``resources.py`` product)::

    <state_dir>/resources/commands/<id>.json

Each file is a JSON object with ``id``, an optional ``name``/``description``,
a body in ``prompt`` (preferred) or ``content``, and an optional ``enabled``
flag (absent means enabled).

Expansion is pure text: no external command is executed, no file is written,
and the result is clipped to ``EXPAND_MAX_CHARS`` so a hostile command body can
never blow up the prompt.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

# Bound (characters) on the expanded text spliced into the prompt.
EXPAND_MAX_CHARS = 8000

TRUNCATION_SUFFIX = "\n…(truncated)"

# A command id / invocation name: 1-64 chars of [A-Za-z0-9._-], minus the two
# path-ish specials.
NAME_PATTERN = r"[A-Za-z0-9._-]{1,64}"
_NAME_RE = re.compile("^" + NAME_PATTERN + "$")

# A whole user turn that is a single slash invocation. A leading ``//`` or a
# name with illegal characters simply fails to match and is passed through.
INVOCATION_RE = re.compile(r"^/(" + NAME_PATTERN + r")(?:\s+([\s\S]*))?$")

ARGUMENTS_PLACEHOLDER = "$ARGUMENTS"


def clip(text: str, max_chars: int) -> str:
    """Trim to ``max_chars`` characters, keeping a truncation marker."""
    t = str(text).strip()
    if not max_chars or len(t) <= max_chars:
        return t
    return t[: max(0, max_chars - 14)].rstrip() + TRUNCATION_SUFFIX


def _commands_dir(state_dir) -> Path:
    return Path(state_dir) / "resources" / "commands"


def _safe_read_json(path: Path):
    """Read one command file, refusing symlinks (``O_NOFOLLOW``).

    A symlinked entry, a file that is not valid JSON, an unreadable file, and a
    JSON document that is not an object all yield ``None`` so one broken entry
    can never take down the rest of the list or echo back a foreign file.
    """
    if path.is_symlink():
        return None
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _valid_id(value) -> bool:
    """A usable command id: a non-empty string, legal chars, not ``.``/``..``."""
    if not isinstance(value, str):
        return False
    if value in (".", ".."):
        return False
    return _NAME_RE.match(value) is not None


def _body(item: dict):
    """The command body: ``prompt`` preferred, else ``content``, else ``None``.

    Only a non-empty string counts; anything else (missing, ``None``, a list,
    whitespace only) falls through so a malformed entry can never expand into
    an empty turn.
    """
    prompt = item.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        return prompt
    content = item.get("content")
    if isinstance(content, str) and content.strip():
        return content
    return None


def load(state_dir) -> list:
    """Every usable command under ``state_dir``, sorted by id ascending."""
    commands_dir = _commands_dir(state_dir)
    # A symlinked directory would relocate the whole jail; refuse it outright.
    if commands_dir.is_symlink():
        return []
    if not commands_dir.is_dir():
        return []
    items = []
    for path in sorted(commands_dir.glob("*.json")):
        if path.is_symlink():
            continue
        item = _safe_read_json(path)
        if item is None:
            continue
        if item.get("enabled") is False:
            continue
        cid = item.get("id")
        if not _valid_id(cid):
            continue
        if _body(item) is None:
            continue
        entry = dict(item)
        entry["id"] = cid
        items.append(entry)
    items.sort(key=lambda entry: entry["id"])
    return items


def _find(commands, name: str):
    """The enabled command whose id is ``name``, or ``None``."""
    if not isinstance(commands, (list, tuple)):
        return None
    for entry in commands:
        if not isinstance(entry, dict):
            continue
        if entry.get("id") != name:
            continue
        if entry.get("enabled") is False:
            continue
        return entry
    return None


def expand(commands, text) -> tuple:
    """Expand a single slash invocation, or pass the turn through untouched.

    Returns ``(expanded_text, meta)`` where ``meta`` is ``None`` when nothing
    was expanded and ``{"command": <id>, "args": <str>}`` otherwise.
    """
    if not isinstance(text, str):
        return (text, None)
    match = INVOCATION_RE.match(text)
    if match is None:
        return (text, None)
    name = match.group(1)
    args = match.group(2) or ""
    command = _find(commands, name)
    if command is None:
        return (text, None)
    body = _body(command)
    if body is None:
        return (text, None)
    if ARGUMENTS_PLACEHOLDER in body:
        expanded = body.replace(ARGUMENTS_PLACEHOLDER, args)
    elif args:
        expanded = body + "\n\n" + args
    else:
        expanded = body
    return (clip(expanded, EXPAND_MAX_CHARS), {"command": name, "args": args})
