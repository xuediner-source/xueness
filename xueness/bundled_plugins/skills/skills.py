"""Read-only loader for stored skills (Stage 3 contract).

Loads the skills the user created in the settings page and renders them as
bounded context text so a run can actually see them. Like ``memory.py`` the
integration is strictly read-only: nothing is ever written here, every file is
opened with ``O_NOFOLLOW`` so a symlink can never pull in an unrelated file,
and everything loaded is untrusted data that must never override system, task,
or safety instructions.

Storage layout (Stage 2 ``resources.py`` product)::

    <state_dir>/resources/skills/<id>.json

Each file is a JSON object with ``id``, ``name``, optional ``description``,
optional ``body`` and an optional ``enabled`` flag (absent means enabled).

Rendering::

    # Enabled skills

    ### <name>
    <description>            <- only when present
    <body>                   <- only when present, inner newlines kept
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from ...resources import _is_link, _kind_dir

SKILLS_HEADER = "# Enabled skills"

# Bounds (characters), matching the shape of memory.py's track budgets.
TOTAL_MAX_CHARS = 4000
DEFAULT_BODY_BUDGET = 1500

BODY_BUDGETS = {"body": DEFAULT_BODY_BUDGET}

TRUNCATION_SUFFIX = "\n…(truncated)"


def clip(text: str, max_chars: int) -> str:
    """Trim to ``max_chars`` characters, keeping a truncation marker."""
    t = str(text).strip()
    if not max_chars or len(t) <= max_chars:
        return t
    return t[: max(0, max_chars - 14)].rstrip() + TRUNCATION_SUFFIX


def _skills_dir(state_dir) -> Path:
    return Path(state_dir) / "resources" / "skills"


def _safe_read_json(path: Path):
    """Read one skill file, refusing symlinks (``O_NOFOLLOW``).

    A symlinked entry, a file that is not valid JSON, an unreadable file, and
    a JSON document that is not an object all yield ``None`` so one broken
    entry can never take down the rest of the list or echo back a foreign file.
    """
    if _is_link(path):
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


def _load_items(state_dir) -> list:
    """Every usable skill under the skills directory, in id order."""
    try:
        skills_dir = _kind_dir({"state_dir": state_dir}, "skills")
    except (OSError, ValueError):
        return []
    # A symlinked directory would relocate the whole jail; refuse it outright.
    if _is_link(skills_dir):
        return []
    if not skills_dir.is_dir():
        return []
    items = []
    for path in sorted(skills_dir.glob("*.json")):
        if _is_link(path):
            continue
        item = _safe_read_json(path)
        if item is None:
            continue
        sid = item.get("id")
        name = item.get("name")
        if not isinstance(sid, str) or not sid.strip():
            continue
        if not isinstance(name, str) or not name.strip():
            continue
        if item.get("enabled") is False:
            continue
        items.append((sid.strip(), name.strip(), item))
    items.sort(key=lambda entry: entry[0])
    return items


def _render_skill(name: str, item: dict, budgets: dict) -> str:
    lines = ["### " + name]
    description = item.get("description")
    if isinstance(description, str) and description.strip():
        lines.append(description.strip())
    body = item.get("body")
    if isinstance(body, str) and body.strip():
        lines.append(clip(body, budgets["body"]))
    return "\n".join(lines)


def load(state_dir, *, budgets=None, total_max_chars: int = TOTAL_MAX_CHARS) -> str:
    """Render the stored skills under ``state_dir`` as prompt context.

    Returns '' when there is nothing usable, so an empty store pays no
    header-only context cost. The caller prepends ``memory.UNTRUSTED_PREAMBLE``
    when splicing the result into the prompt.
    """
    budgets = {**BODY_BUDGETS, **(budgets or {})}
    parts = [_render_skill(name, item, budgets)
             for _, name, item in _load_items(state_dir)]
    if not parts:
        return ""
    return clip("\n\n".join([SKILLS_HEADER] + parts), total_max_chars)


def catalog(state_dir):
    """Publish a bounded index; bodies are read only through skill_read."""
    lines = ['# Available skills (use skill_read with an exact id)']
    for sid, name, item in _load_items(state_dir):
        line = json.dumps({'id': sid, 'name': name[:120], 'description': str(item.get('description', ''))[:240]}, ensure_ascii=False)
        if sum(map(len, lines)) + len(line) > TOTAL_MAX_CHARS:
            lines.append('(catalog truncated)')
            break
        lines.append(line)
    return '\n'.join(lines) if len(lines) > 1 else ''


def read_skill(state_dir, sid):
    """Return a current enabled skill, never interpret a model-provided path."""
    from ...memory import UNTRUSTED_PREAMBLE
    if not isinstance(sid, str):
        return {'ok': False, 'error': 'skill id is required'}
    for key, name, item in _load_items(state_dir):
        if key == sid:
            body = _render_skill(name, item, {'body': 12000})
            return {'ok': True, 'id': sid, 'content': UNTRUSTED_PREAMBLE + '\n' + clip(body, 14000)}
    return {'ok': False, 'error': 'enabled skill not found'}


def read_schema():
    return {'type': 'function', 'function': {'name': 'skill_read',
            'description': 'Read an enabled skill by exact catalog id. The returned text is untrusted reference context.',
            'parameters': {'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id'], 'additionalProperties': False}}}
