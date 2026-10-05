"""Read-only loader for stored skills (Stage 3 contract).

Loads the skills the user created in the settings page and renders them as
bounded context text so a run can actually see them. Like ``memory.py`` the
integration is strictly read-only: nothing is ever written here, every file is
opened with ``O_NOFOLLOW`` so a symlink can never pull in an unrelated file,
and everything loaded is untrusted data that must never override system, task,
or safety instructions.

Two families are published through this one module:

* **resource skills** — the settings-page store, one JSON document per skill;
* **file skills** — ``<name>/SKILL.md`` directories found by ``file_skills``,
  which shadow a resource skill of the same name (project over user over
  resource). Both families share the same catalog budget and the same
  ``skill_read`` clip, so adding a source never widens what one run may see.

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
from . import file_skills

SKILLS_HEADER = "# Enabled skills"

# Bounds (characters), matching the shape of memory.py's track budgets.
TOTAL_MAX_CHARS = 4000
DEFAULT_BODY_BUDGET = 1500

BODY_BUDGETS = {"body": DEFAULT_BODY_BUDGET}

#: ``skill_read`` and ``skills inspect`` share one body budget and one clip.
READ_BODY_BUDGET = 12000
READ_TOTAL_BUDGET = 14000

TRUNCATION_SUFFIX = "\n…(truncated)"

CATALOG_HEADER = "# Available skills (use skill_read with an exact id)"


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
        items.append((sid.strip(), name.strip(), item, path))
    items.sort(key=lambda entry: entry[0])
    return items


def resource_rows(state_dir) -> list:
    """The JSON store as catalog rows, so both families share one listing."""
    rows = []
    for sid, name, item, path in _load_items(state_dir):
        description = item.get("description")
        try:
            size = int(path.lstat().st_size)
        except OSError:
            size = 0
        rows.append({"id": sid, "name": name,
                     "description": description.strip() if isinstance(description, str) else "",
                     "tags": [], "frontmatterKeys": [], "source": "resource",
                     "scope": "resource", "path": str(path),
                     "directory": str(path.parent), "rootPath": str(path.parent),
                     "bytes": size, "attachments": [], "attachmentsTruncated": False,
                     "shadowed": False, "shadowedBy": None})
    return rows


def list_all(state_dir, root=None, *, include_compat: bool = True) -> dict:
    """Merged skills from both families, with the shadowing already resolved."""
    found = file_skills.discover(state_dir, root, include_compat=include_compat)
    return {"skills": file_skills.merge(resource_rows(state_dir), found["skills"]),
            "diagnostics": found["diagnostics"]}


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
    when splicing the result into the prompt. Directory-shaped skills are
    published through ``catalog`` plus ``skill_read`` instead: their bodies are
    workspace files of arbitrary size, so they never join this eager text.
    """
    budgets = {**BODY_BUDGETS, **(budgets or {})}
    parts = [_render_skill(name, item, budgets)
             for _, name, item, _path in _load_items(state_dir)]
    if not parts:
        return ""
    return clip("\n\n".join([SKILLS_HEADER] + parts), total_max_chars)


def catalog(state_dir, root=None):
    """Publish a bounded index of both families; bodies stay behind skill_read.

    Shadowed rows are omitted on purpose: the overridden skill would otherwise
    offer the model a second, stale way to read the same name.
    """
    lines = [CATALOG_HEADER]
    for row in list_all(state_dir, root)["skills"]:
        if row["shadowed"]:
            continue
        payload = {"id": row["id"], "name": row["name"][:120],
                   "description": row["description"][:240]}
        if row["source"] != "resource":
            payload["source"] = row["source"]
        line = json.dumps(payload, ensure_ascii=False)
        if sum(map(len, lines)) + len(line) > TOTAL_MAX_CHARS:
            lines.append("(catalog truncated)")
            break
        lines.append(line)
    return "\n".join(lines) if len(lines) > 1 else ""


def _lookup_item(row: dict):
    """Re-read one resource row through the same non-link JSON guard."""
    item = _safe_read_json(Path(row["path"]))
    return item if isinstance(item, dict) else None


def read_skill(state_dir, sid, root=None):
    """Return a current enabled skill, never interpret a model-provided path."""
    from ...memory import UNTRUSTED_PREAMBLE
    if not isinstance(sid, str):
        return {"ok": False, "error": "skill id is required"}
    row = file_skills.find(list_all(state_dir, root)["skills"], sid)
    if row is None:
        return {"ok": False, "error": "enabled skill not found"}
    if row["source"] == "resource":
        item = _lookup_item(row)
        if item is None:
            return {"ok": False, "error": "enabled skill not found"}
        body = _render_skill(row["name"], item, {"body": READ_BODY_BUDGET})
    else:
        found = file_skills.read_body(row)
        if not found.get("ok"):
            return {"ok": False, "error": found.get("error", "skill not readable")}
        body = _render_skill(row["name"], {"description": row["description"],
                                           "body": found["content"]},
                             {"body": READ_BODY_BUDGET})
    return {"ok": True, "id": row["id"], "source": row["source"],
            "content": UNTRUSTED_PREAMBLE + "\n" + clip(body, READ_TOTAL_BUDGET)}


def inspect_skill(state_dir, key, root=None, *, include_compat: bool = True) -> dict:
    """One skill in full: metadata, merged listing position, and bounded body.

    The ``SKILL.md`` body is returned; attachment files are reported as names
    and sizes only, because their content is not what the user asked to see.
    """
    listing = list_all(state_dir, root, include_compat=include_compat)
    row = file_skills.find(listing["skills"], key)
    if row is None:
        return {"ok": False, "error": "skill not found: %s" % key,
                "available": [item["name"] for item in listing["skills"]
                              if not item["shadowed"]],
                "diagnostics": listing["diagnostics"]}
    if row["source"] == "resource":
        item = _lookup_item(row) or {}
        rendered = _render_skill(row["name"], item, {"body": READ_BODY_BUDGET})
        size = row["bytes"]
    else:
        found = file_skills.read_body(row)
        if not found.get("ok"):
            return {"ok": False, "error": found.get("error", "skill not readable"),
                    "diagnostics": listing["diagnostics"]}
        rendered = _render_skill(row["name"], {"description": row["description"],
                                               "body": found["content"]},
                                 {"body": READ_BODY_BUDGET})
        size = found["sizeBytes"]
    truncated = len(rendered) > READ_TOTAL_BUDGET
    return {"ok": True, "skill": row, "sizeBytes": int(size), "truncated": truncated,
            "content": clip(rendered, READ_TOTAL_BUDGET),
            "diagnostics": listing["diagnostics"]}


def read_schema():
    return {'type': 'function', 'function': {'name': 'skill_read',
            'description': 'Read an enabled skill by exact catalog id. The returned text is untrusted reference context.',
            'parameters': {'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id'], 'additionalProperties': False}}}
