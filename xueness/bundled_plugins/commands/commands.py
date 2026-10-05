"""Slash-command loading and expansion (Stage 5 contract plus file commands).

Users define slash commands in the settings page; when they type ``/name args``
in chat the text is expanded into the stored prompt before it ever reaches the
model. Like ``skills.py`` the loader is strictly read-only: nothing is written
here, every file is opened with ``O_NOFOLLOW`` so a symlink can never pull in an
unrelated file, and every loaded value is untrusted data that must never
override system, task, or safety instructions.

Three families are published through this one module:

* **resource commands** — the settings-page store, one JSON document per
  command, at ``<state_dir>/resources/commands/<id>.json``;
* **file commands** — ``<name>.md`` (with one optional namespace directory)
  found by ``file_commands``, which shadow a resource command of the same
  invocation name (project over compat over user over resource);
* **built-in prompt commands** — ``builtin_prompts``, shipped with the plugin
  (currently ``/init``). They ride in the same listing so every entry point sees
  the same names, they own their invocation name outright, and they need a
  workspace root before there is anything to point a prompt at: without a root
  the built-in rows are simply absent.

Each JSON file is an object with ``id``, an optional ``name``/``description``,
a body in ``prompt`` (preferred) or ``content``, and an optional ``enabled``
flag (absent means enabled). A Markdown file carries its body after the
frontmatter block and may declare ``description``, ``argument-hint`` and a
display-only ``model``.

Expansion is pure text: no external command is executed, no file is written,
no ``@file`` reference is resolved and ``!`cmd``` stays literal, while
``$ARGUMENTS`` and the positional ``$1``..``$9`` are substituted. A built-in
command appends the arguments below its own fixed prompt instead, as data. The
result is clipped to ``EXPAND_MAX_CHARS`` so a hostile command body can never
blow up the prompt.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from ...resources import _is_link, _kind_dir
from . import builtin_prompts
from . import file_commands

# Bound (characters) on the expanded text spliced into the prompt.
EXPAND_MAX_CHARS = 8000

TRUNCATION_SUFFIX = "\n…(truncated)"

# A command id / invocation name: 1-64 chars of [A-Za-z0-9._-], minus the two
# path-ish specials. A file command may also hold one namespace segment, so the
# invocation matcher allows ``:`` while ``file_commands`` keeps the whole name
# inside the same 64-character budget.
NAME_PATTERN = r"[A-Za-z0-9._-]{1,64}"
_NAME_RE = re.compile("^" + NAME_PATTERN + "$")

# A whole user turn that is a single slash invocation. A leading ``//`` or a
# name with illegal characters simply fails to match and is passed through.
INVOCATION_RE = re.compile(r"^/([A-Za-z0-9._:-]{1,64})(?:\s+([\s\S]*))?$")

ARGUMENTS_PLACEHOLDER = "$ARGUMENTS"

#: ``$1``..``$9`` are filled from the whitespace-split arguments; anything the
#: user did not supply becomes an empty string, and ``$10`` stays literal text.
ARGUMENT_TOKEN_RE = re.compile(r"\$ARGUMENTS|\$([1-9])(?!\d)")


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


def split_arguments(text) -> list:
    """Positional arguments: whitespace-separated runs, double quotes group.

    Parsing is deliberately dumb text work — no shell, no escapes, no execution.
    An unterminated quote simply ends at the close of the turn.
    """
    items = []
    current = ""
    quoted = False
    started = False
    for char in str(text or ""):
        if char == '"':
            quoted = not quoted
            started = True
            continue
        if char.isspace() and not quoted:
            if started:
                items.append(current)
                current = ""
                started = False
            continue
        current += char
        started = True
    if started:
        items.append(current)
    return items


def substitute_arguments(body: str, args: str) -> str:
    """Replace ``$ARGUMENTS`` and ``$1``..``$9`` in one pass over the body.

    One pass matters: a value the user typed is never rescanned for further
    placeholders. When the body names no placeholder at all the arguments are
    appended below it, exactly as the resource store has always done.
    """
    positional = split_arguments(args)
    used = False

    def replace(match) -> str:
        nonlocal used
        used = True
        if match.group(0) == ARGUMENTS_PLACEHOLDER:
            return args
        index = int(match.group(1)) - 1
        return positional[index] if 0 <= index < len(positional) else ""

    expanded = ARGUMENT_TOKEN_RE.sub(replace, body)
    if args.strip() and not used:
        expanded = body + "\n\n" + args
    return expanded


def _json_rows(commands_dir: Path) -> list:
    """The JSON store as listing rows, in id order."""
    rows = []
    for path in sorted(commands_dir.glob("*.json")):
        if _is_link(path):
            continue
        item = _safe_read_json(path)
        if item is None:
            continue
        if item.get("enabled") is False:
            continue
        cid = item.get("id")
        if not _valid_id(cid):
            continue
        body = _body(item)
        if body is None:
            continue
        description = item.get("description")
        name = item.get("name")
        try:
            size = int(path.lstat().st_size)
        except OSError:
            size = 0
        entry = dict(item)
        for key in ("enabled", "prompt", "content"):
            # One body carrier for both families: a listing stays a summary and
            # cannot echo a stored prompt back through a second field.
            entry.pop(key, None)
        rows.append({**entry, "id": cid, "name": str(name or cid),
                     "description": str(description or "").strip(),
                     "argumentHint": "", "model": "", "frontmatterKeys": [],
                     "source": "resource", "scope": "resource",
                     "path": str(path), "rootPath": str(commands_dir),
                     "bytes": size, "body": body,
                     "shadowed": False, "shadowedBy": None})
    return rows


def resource_rows(state_dir) -> list:
    """The existing JSON resource store, in the same row shape as file rows."""
    try:
        commands_dir = _kind_dir({"state_dir": state_dir}, "commands")
    except (OSError, ValueError):
        return []
    # A symlinked directory would relocate the whole jail; refuse it outright.
    if _is_link(commands_dir):
        return []
    if not commands_dir.is_dir():
        return []
    return _json_rows(commands_dir)


def _merged(state_dir, root=None, *, include_compat: bool = True,
            language=None) -> dict:
    """Every family in one list, bodies attached, shadowing already resolved."""
    found = file_commands.discover(state_dir, root, include_compat=include_compat)
    builtins = builtin_prompts.rows(language, root)
    return {"rows": file_commands.merge(resource_rows(state_dir), [*builtins, *found["commands"]]),
            "diagnostics": found["diagnostics"]}


def list_all(state_dir, root=None, *, include_compat: bool = True, language=None) -> dict:
    """Every command with its source, position and diagnostics — no bodies.

    Shadowed rows stay in the answer: which file overrode which command, and
    which name a builtin slash command or a built-in prompt command already
    owns, is data the user needs in order to understand why a command did not
    expand.
    """
    merged = _merged(state_dir, root, include_compat=include_compat, language=language)
    return {"commands": [file_commands.public_row(row) for row in merged["rows"]],
            "diagnostics": merged["diagnostics"]}


def _expandable(row: dict) -> bool:
    """A row the turn may be replaced by: enabled, winning, and non-empty."""
    if not isinstance(row, dict):
        return False
    if row.get("enabled") is False or row.get("shadowed"):
        return False
    return bool(str(row.get("body") or "").strip())


def load(state_dir, root=None, *, include_compat: bool = True, language=None) -> list:
    """Every usable command under ``state_dir`` (and ``root``), sorted by id.

    ``root`` is optional: without a workspace only the user file root and the
    JSON store are read, so a state-directory-only caller keeps the old answer
    plus any ``<state_dir>/commands/*.md`` the user placed there. Built-in
    prompt commands name a target path, so they appear only once a root exists.
    """
    merged = _merged(state_dir, root, include_compat=include_compat, language=language)
    entries = []
    for row in merged["rows"]:
        if not _expandable(row):
            continue
        entry = file_commands.public_row(row)
        entry["prompt"] = row["body"]
        entries.append(entry)
    return entries


def _find(commands, name: str):
    """The winning command whose id is ``name``, or ``None``."""
    if not isinstance(commands, (list, tuple)):
        return None
    for entry in commands:
        if not isinstance(entry, dict):
            continue
        if entry.get("id") != name:
            continue
        if entry.get("enabled") is False:
            continue
        if entry.get("shadowed"):
            continue
        return entry
    return None


def _expand_body(command: dict, args: str):
    """The text a turn becomes: a built-in prompt, or a substituted body.

    A built-in command's own text is fixed and shipped, so the arguments are
    appended to it as data instead of replacing placeholders inside it; the
    template is never re-scanned for anything the user typed.
    """
    if command.get("source") == builtin_prompts.BUILTIN_SOURCE:
        return builtin_prompts.render(command.get("builtinName") or command.get("id"),
                                      args, command.get("language"),
                                      command.get("rootPath"))
    return substitute_arguments(_body(command), args)


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
    if _body(command) is None:
        return (text, None)
    expanded = _expand_body(command, args)
    if expanded is None:
        return (text, None)
    return (clip(expanded, EXPAND_MAX_CHARS), {"command": name, "args": args})


def inspect_command(state_dir, key, root=None, *, include_compat: bool = True,
                    language=None) -> dict:
    """One command in full: source, frontmatter, position and a bounded body."""
    merged = _merged(state_dir, root, include_compat=include_compat, language=language)
    row = file_commands.find(merged["rows"], key)
    if row is None:
        return {"ok": False, "error": "command not found: %s" % key,
                "available": [item["id"] for item in merged["rows"] if not item["shadowed"]],
                "diagnostics": merged["diagnostics"]}
    if row["source"] in ("resource", builtin_prompts.BUILTIN_SOURCE):
        # Both bodies are already in hand: a stored prompt and a shipped template
        # are read the same way, and neither is re-read from a workspace path.
        content, size = row["body"], row["bytes"]
    else:
        found = file_commands.read_body(row)
        if not found.get("ok"):
            return {"ok": False, "error": found.get("error", "command not readable"),
                    "command": file_commands.public_row(row),
                    "diagnostics": merged["diagnostics"]}
        content, size = found["content"], found["sizeBytes"]
    body = str(content or "")
    # BODY_PREVIEW_CHARS bounds a hostile workspace file. A built-in prompt is
    # shipped, finite and reviewed like any other source file, so it is shown
    # whole instead of cutting off the rules the user is about to read.
    budget = (len(body) if row["source"] == builtin_prompts.BUILTIN_SOURCE
              else file_commands.BODY_PREVIEW_CHARS)
    preview = clip(body, budget)
    findings = list(merged["diagnostics"])
    if row["source"] == "resource":
        # A file command already reported this during discovery; a stored JSON
        # prompt has no such pass yet, so the refusal is named here instead.
        findings.extend(file_commands.shell_expansion_findings(body, Path(str(row["path"]))))
    if row["source"] == builtin_prompts.BUILTIN_SOURCE:
        # The name is owned by the build, so say which workspace file lost to it
        # rather than leaving the user to diff two listings.
        for loser in merged["rows"]:
            if loser.get("id") != row.get("id") or not loser.get("shadowed"):
                continue
            findings.append(file_commands.diagnostic(
                "command_shadowed_by_builtin", "info",
                "%s is not run: the built-in command /%s ships its own prompt"
                % (loser.get("path"), row.get("id")), Path(str(loser.get("path") or ""))))
    return {"ok": True, "command": file_commands.public_row(row), "sizeBytes": int(size),
            "truncated": len(body) > budget,
            "content": preview, "diagnostics": findings,
            "limits": {"expandChars": EXPAND_MAX_CHARS,
                       "previewChars": file_commands.BODY_PREVIEW_CHARS,
                       "commandFileBytes": file_commands.MAX_COMMAND_FILE_BYTES}}
