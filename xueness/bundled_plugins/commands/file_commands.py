"""Read-only discovery of file-shaped custom commands (``<name>.md``).

Layout, highest precedence first. A row whose invocation name was already
claimed by a higher source is reported as ``shadowed`` instead of silently
dropped, and a name a builtin slash command already answers is reported as
``shadowedBy: "builtin"``::

    <workspace>/.xueness/commands/<name>.md         project
    <workspace>/.zcode/commands/<name>.md           project-compat (read-only)
    <state_dir>/commands/<name>.md                  user
    <state_dir>/resources/commands/<id>.json        resource (existing store)

One subdirectory is read inside each root and becomes a namespace, so
``git/pr.md`` is invoked as ``/git:pr``; deeper nesting is refused as a
diagnostic instead of silently widening the name space.

Frontmatter is parsed as *plain text*: only a block fenced by ``---`` holding
top-level ``key: value`` lines is understood, plus the folded and literal block
scalars real command files use for a long ``description``. No YAML dependency is
added. ``description`` and ``argument-hint`` are read, ``model`` is reported but
never applied, and every other key — ``allowed-tools``, ``skills``,
``disable-noninteractive`` and friends — is only named back to the user: an
untrusted command file grants nothing. Nothing in a command directory is ever
executed or imported, ``!`cmd``` stays literal text (Xueness has no shell
expansion here) and is flagged in the diagnostics.

Every path is refused when the entry itself is a symlink or Windows reparse
point, and every resolved path must stay inside the command root it came from,
so a redirected directory cannot move the jail somewhere else.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from ...resources import _is_link

COMMAND_EXTENSION = ".md"
NAMESPACE_SEPARATOR = ":"

#: One invocation name: ``NAME_PATTERN`` per segment, at most one namespace,
#: and ``MAX_NAME_CHARS`` for the whole thing so the chat matcher stays bounded.
NAME_SEGMENT_PATTERN = r"[A-Za-z0-9._-]{1,64}"
_NAME_SEGMENT_RE = re.compile("^" + NAME_SEGMENT_PATTERN + "$")
COMMAND_NAME_RE = re.compile("^" + NAME_SEGMENT_PATTERN +
                             "(?:" + re.escape(NAMESPACE_SEPARATOR) + NAME_SEGMENT_PATTERN + ")?$")
MAX_NAME_CHARS = 64

DESCRIPTION_MAX_CHARS = 1024
ARGUMENT_HINT_MAX_CHARS = 128

#: One command file is read as text, never executed; the cap bounds the cost of
#: a hostile or accidentally enormous file.
MAX_COMMAND_FILE_BYTES = 64 * 1024
#: Command files read per root, so one redirected tree cannot stall a listing.
MAX_COMMANDS_PER_ROOT = 64
#: ``commands inspect`` preview, in characters.
BODY_PREVIEW_CHARS = 2000

#: Frontmatter keys that change nothing but are still worth showing the user.
SUPPORTED_KEYS = ("description", "argument-hint", "model")

SOURCE_PRIORITY = {"project": 0, "project-compat": 1, "user": 2, "resource": 3}
SCOPE_BY_SOURCE = {"project": "project", "project-compat": "project",
                   "user": "user", "resource": "resource"}

#: Slash names the chat host answers itself, before any custom command runs.
CHAT_BUILTIN_NAMES = frozenset({
    "attach", "attachments", "compact", "detach", "dwf", "effort", "end", "exit", "expert",
    "help", "mode", "model", "models", "paste", "paste-image", "quit", "retry", "skills",
    "status",
})

BUILTIN_SHADOW = "builtin"

#: ``/!`cmd``` and a fenced ```` ```! ```` block are ZCode's shell expansion.
INLINE_SHELL_RE = re.compile(r"!`[^`\n]*`")
FENCED_SHELL_RE = re.compile(r"```!\s*[\s\S]*?```")

_OWNERSHIP_MEMO: dict = {}


def diagnostic(code: str, severity: str, message: str, path=None) -> dict:
    """One structured finding; a broken entry is an answer, never an exception."""
    item = {"code": code, "severity": severity, "message": message}
    if path is not None:
        item["path"] = str(path)
    return item


def _contained(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def _real(path) -> Path | None:
    try:
        return Path(path).resolve()
    except OSError:
        return None


def _is_markdown(path: Path) -> bool:
    return path.name.lower().endswith(COMMAND_EXTENSION)


def invocation_name(value) -> str:
    """The plain invocation name a row answers to, without a leading slash."""
    return str(value or "").lstrip("/")


def is_valid_name(name) -> bool:
    """A legal command name: legal characters, one namespace, bounded length."""
    if not isinstance(name, str) or not name or len(name) > MAX_NAME_CHARS:
        return False
    if COMMAND_NAME_RE.match(name) is None:
        return False
    return all(segment not in (".", "..") for segment in name.split(NAMESPACE_SEPARATOR))


# -- built-in name conflicts ---------------------------------------------------

def manifest_command_name(name) -> str | None:
    """The plugin whose manifest already claims ``name`` as a command.

    Same routing source the CLI and chat use (``plugin_runtime.slash_owner``), so
    a file command can never borrow a name the harness already answers. Build
    manifests are immutable package data, therefore the per-name answer is
    memoised exactly like the kernel memoises its HTTP route index.
    """
    if not isinstance(name, str) or not name:
        return None
    if name in _OWNERSHIP_MEMO:
        return _OWNERSHIP_MEMO[name]
    owner = None
    try:
        from ... import plugin_runtime
        owner = plugin_runtime.slash_owner(name)
    except (ImportError, OSError, ValueError):
        owner = None
    _OWNERSHIP_MEMO[name] = owner
    return owner


def is_reserved(name) -> bool:
    """Whether a builtin chat command or another plugin already owns ``name``."""
    return invocation_name(name) in CHAT_BUILTIN_NAMES or manifest_command_name(name) is not None


# -- frontmatter ---------------------------------------------------------------

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

    No fence at all is legal for a command file and yields ``({}, [], None)``,
    so a plain Markdown command still gets a description from its body. ``error``
    is ``command_unclosed_frontmatter`` for a block that never ends and
    ``command_invalid_frontmatter`` for one that holds nothing readable.
    """
    lines = _split_lines(text.lstrip("﻿"))
    if not lines or lines[0].strip() != "---":
        return {}, [], None
    end = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    if end is None:
        return {}, [], "command_unclosed_frontmatter"
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
        return values, keys, "command_invalid_frontmatter"
    return values, keys, None


def strip_frontmatter(text: str) -> str:
    lines = _split_lines(text.lstrip("﻿"))
    if not lines or lines[0].strip() != "---":
        return text
    end = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    if end is None:
        return text
    return "\n".join(lines[end + 1:])


def first_line_description(body: str) -> str:
    """The fallback description: the first prose line of the body."""
    for candidate in _split_lines(body):
        stripped = re.sub(r"^[#>\-*]+\s*", "", candidate).strip()
        if stripped:
            return stripped[:DESCRIPTION_MAX_CHARS]
    return ""


def _bounded(value, max_chars: int) -> str:
    return str(value or "").strip()[:max_chars]


def frontmatter_findings(values: dict, keys: list, path) -> list:
    """What the readable keys mean here, as data and diagnostics — never policy.

    ``model`` is shown but not applied, and any key outside ``SUPPORTED_KEYS``
    is named back without acting on it: a command file cannot grant tools,
    attach skills or change the permission mode of a run.
    """
    findings = []
    for key in dict.fromkeys(keys):
        if key in SUPPORTED_KEYS:
            continue
        findings.append(diagnostic(
            "command_unsupported_frontmatter", "warning",
            "frontmatter key %s is ignored by Xueness commands: %s" % (key, path.name), path))
    if "model" in values:
        findings.append(diagnostic(
            "command_model_not_applied", "info",
            "model %s is shown for reference only and never selects a model"
            % _bounded(values.get("model"), 128), path))
    return findings


def shell_expansion_findings(body: str, path) -> list:
    """Flag ZCode shell syntax that Xueness deliberately does not run."""
    findings = []
    if INLINE_SHELL_RE.search(body):
        findings.append(diagnostic(
            "command_shell_expansion_unsupported", "warning",
            "inline !`…` shell expansion is not supported; the text stays literal "
            "and no command is run", path))
    if FENCED_SHELL_RE.search(body):
        findings.append(diagnostic(
            "command_shell_expansion_unsupported", "warning",
            "fenced ```! shell expansion is not supported; the text stays literal "
            "and no command is run", path))
    return findings


# -- scanning ------------------------------------------------------------------

def _read_text(path: Path, max_bytes: int):
    """Read one non-link file as text, refusing to follow a redirect."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None, None, "command_unreadable"
    try:
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read(max_bytes + 1)
    except OSError:
        return None, None, "command_unreadable"
    if len(raw) > max_bytes:
        return None, len(raw), "command_file_too_large"
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None, len(raw), "command_invalid_encoding"
    return text, len(raw), None


def command_roots(state_dir, root=None, *, include_compat: bool = True) -> list:
    """Every command root to scan, with the workspace or state jail behind it."""
    items = []
    jail = _real(Path(state_dir))
    if root is not None:
        workspace = _real(root)
        if workspace is not None:
            items.append(("project", workspace / ".xueness" / "commands", workspace))
            if include_compat:
                items.append(("project-compat", workspace / ".zcode" / "commands", workspace))
    if jail is not None and not _is_link(Path(state_dir)):
        items.append(("user", jail / "commands", jail))
    return items


def _listing(directory: Path, diagnostics: list, code: str) -> list:
    try:
        return sorted(directory.iterdir(), key=lambda child: child.name)
    except OSError as exc:
        diagnostics.append(diagnostic(code, "warning",
                                      "command directory could not be listed: %s" % exc, directory))
        return []


def _stem(entry: Path) -> str:
    """The name a file or namespace directory contributes, without ``.md``."""
    name = entry.name
    if not entry.is_dir() and name.lower().endswith(COMMAND_EXTENSION):
        return name[:-len(COMMAND_EXTENSION)]
    return name


def _usable_segment(stem: str) -> bool:
    return stem not in (".", "..") and _NAME_SEGMENT_RE.match(stem) is not None


def _command_files(base: Path, diagnostics: list) -> list:
    """``(name, path)`` pairs under one root: files plus one namespace level."""
    found: list = []
    for entry in _listing(base, diagnostics, "command_root_unreadable"):
        if entry.name.startswith("."):
            continue
        if _is_link(entry):
            diagnostics.append(diagnostic("command_entry_symlink", "warning",
                                          "command entry must not be a link: %s" % entry.name,
                                          entry))
            continue
        if entry.is_dir():
            if not _usable_segment(entry.name):
                diagnostics.append(diagnostic("command_invalid_namespace", "warning",
                                              "command namespace is not usable: %s" % entry.name,
                                              entry))
                continue
            for child in _listing(entry, diagnostics, "command_namespace_unreadable"):
                if child.name.startswith("."):
                    continue
                if _is_link(child):
                    diagnostics.append(diagnostic("command_file_symlink", "warning",
                                                  "command file must not be a link: %s" % child.name,
                                                  child))
                    continue
                if child.is_dir():
                    diagnostics.append(diagnostic("command_namespace_too_deep", "warning",
                                                  "only one namespace level is read: %s"
                                                  % (entry.name + "/" + child.name), child))
                    continue
                if not _is_markdown(child):
                    continue
                found.append((entry.name + NAMESPACE_SEPARATOR + _stem(child), child))
        elif _is_markdown(entry):
            found.append((_stem(entry), entry))
    usable = []
    for name, path in found:
        # The same whole-name rule the chat matcher applies: a listing and an
        # expansion can never disagree about a name existing.
        if not is_valid_name(name):
            diagnostics.append(diagnostic("command_invalid_name", "error",
                                          "command name is not usable: %s" % path.name, path))
            continue
        usable.append((name, path))
    return usable


def _row(source: str, base: Path, name: str, path: Path, meta: dict, size: int) -> dict:
    return {"id": name, "name": name, "description": meta["description"],
            "argumentHint": meta["argumentHint"], "model": meta["model"],
            "frontmatterKeys": meta["keys"], "source": source,
            "scope": SCOPE_BY_SOURCE.get(source, "user"),
            "path": str(path), "directory": str(path.parent), "rootPath": str(base),
            "bytes": int(size), "body": meta["body"],
            "shadowed": False, "shadowedBy": None}


def _read_entry(source: str, base: Path, name: str, path: Path):
    """One command file as a row, or diagnostics explaining why it is not one."""
    if _is_link(path):
        return None, [diagnostic("command_file_symlink", "warning",
                                 "command file must not be a link: %s" % name, path)]
    resolved = _real(path)
    if resolved is None or not _contained(resolved, base):
        return None, [diagnostic("command_escapes_root", "error",
                                 "command path leaves its command root: %s" % name, path)]
    text, size, failure = _read_text(path, MAX_COMMAND_FILE_BYTES)
    if failure:
        detail = " (%d bytes)" % size if failure == "command_file_too_large" and size else ""
        return None, [diagnostic(failure, "error",
                                 "command file could not be read as text%s: %s" % (detail, name),
                                 path)]
    values, keys, error = parse_frontmatter(text)
    if error:
        return None, [diagnostic(error, "error",
                                 "command frontmatter is unusable: %s" % name, path)]
    body = strip_frontmatter(text).strip()
    if not body:
        return None, [diagnostic("command_empty_body", "error",
                                 "command file has no body to expand: %s" % name, path)]
    findings = frontmatter_findings(values, keys, path)
    findings.extend(shell_expansion_findings(body, path))
    description = _bounded(values.get("description"), DESCRIPTION_MAX_CHARS) \
        or first_line_description(body)
    meta = {"description": description,
            "argumentHint": _bounded(values.get("argument-hint"), ARGUMENT_HINT_MAX_CHARS),
            "model": _bounded(values.get("model"), 128),
            "keys": list(dict.fromkeys(keys)), "body": body}
    return _row(source, base, name, path, meta, size or 0), findings


def _scan_root(source: str, base: Path, jail: Path, diagnostics: list,
               limit: int = MAX_COMMANDS_PER_ROOT) -> list:
    if _is_link(base):
        diagnostics.append(diagnostic("command_root_symlink", "error",
                                      "command root must not be a link", base))
        return []
    resolved = _real(base)
    if resolved is None:
        diagnostics.append(diagnostic("command_root_unreadable", "warning",
                                      "command root could not be resolved", base))
        return []
    if not _contained(resolved, jail):
        diagnostics.append(diagnostic("command_root_escapes", "error",
                                      "command root resolves outside its workspace", base))
        return []
    if not base.is_dir():
        return []
    rows = []
    for name, path in _command_files(resolved, diagnostics):
        row, findings = _read_entry(source, resolved, name, path)
        diagnostics.extend(findings)
        if row is None:
            continue
        if len(rows) >= limit:
            diagnostics.append(diagnostic("command_root_limit", "warning",
                                          "only the first %d commands are read from this root"
                                          % limit, base))
            break
        rows.append(row)
    return rows


def discover(state_dir, root=None, *, include_compat: bool = True,
             limit: int = MAX_COMMANDS_PER_ROOT) -> dict:
    """Every usable file command, highest precedence first."""
    rows: list = []
    diagnostics: list = []
    for source, base, jail in command_roots(state_dir, root, include_compat=include_compat):
        rows.extend(_scan_root(source, base, jail, diagnostics, limit=limit))
    return {"commands": rows, "diagnostics": diagnostics}


# -- merging with the resource store ----------------------------------------

def _sort_key(row: dict):
    return (str(row.get("id") or ""), SOURCE_PRIORITY.get(row.get("source"), 9))


def merge(resource_rows: list, file_rows: list) -> list:
    """Rows from both families; the invocation name is claimed by one winner.

    A builtin slash command owns its name outright, so a file command that
    collides with one is listed as ``shadowedBy: "builtin"`` and never expands.
    Resource rows are never shadowed by a builtin here: their store contract is
    older than this listing and stays exactly as it was.
    """
    claimed: dict = {}
    rows = []
    for row in sorted([*file_rows, *resource_rows], key=_sort_key):
        name = str(row.get("id") or "")
        if not name:
            continue
        if row.get("source") != "resource" and is_reserved(name):
            rows.append({**row, "body": None, "shadowed": True, "shadowedBy": BUILTIN_SHADOW})
            continue
        winner = claimed.get(name)
        if winner is not None:
            rows.append({**row, "body": None, "shadowed": True, "shadowedBy": winner})
            continue
        claimed[name] = row.get("source")
        rows.append(row)
    return rows


def public_row(row: dict) -> dict:
    """A listing row without its body: a listing is a summary, not a prompt."""
    return {key: value for key, value in row.items() if key != "body"}


def find(rows: list, key) -> dict | None:
    """The winning row whose invocation name equals ``key`` exactly.

    Matching stays exact and case-sensitive because a lookup value is never
    treated as a path or a glob; a leading slash is tolerated as typing noise.
    """
    if not isinstance(key, str) or not key:
        return None
    wanted = invocation_name(key)
    for row in rows:
        if row.get("shadowed"):
            continue
        if wanted in (row.get("id"), row.get("name")):
            return row
    return None


def read_body(row: dict, *, max_bytes: int = MAX_COMMAND_FILE_BYTES) -> dict:
    """Re-check the jail at read time, then return the Markdown body.

    A row may come from an older listing, so the link and containment guards run
    again here instead of trusting ``row['path']``.
    """
    path = Path(str(row.get("path") or ""))
    base = Path(str(row.get("rootPath") or ""))
    if not str(path):
        return {"ok": False, "error": "command path is missing"}
    if _is_link(path):
        return {"ok": False, "error": "command file must not be a link"}
    resolved = _real(path)
    jail = _real(base)
    if resolved is None or jail is None or not _contained(resolved, jail):
        return {"ok": False, "error": "command path leaves its command root"}
    text, size, failure = _read_text(path, max_bytes)
    if failure:
        return {"ok": False, "error": "command file could not be read (%s)" % failure}
    body = strip_frontmatter(text).strip()
    return {"ok": True, "content": body, "bytesRead": int(size or 0), "sizeBytes": int(size or 0)}
