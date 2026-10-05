"""CLI and in-chat face of custom commands: ``commands list|inspect``, ``/commands``.

One formatter serves the terminal, the chat reply and the plugin panel data, so
a listing cannot read differently in two places. Bodies only ever appear in
``inspect`` and stay clipped: ``list`` is a summary of sources and shadowing.
Nothing here decides permissions or reads a path the caller invented.

A built-in prompt command (``/init``) is listed and inspected from the same
rows, tagged with its source so the answer says where the text came from.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from . import builtin_prompts
from . import file_commands
from . import commands as store

USAGE = "Usage: xueness commands [list|inspect <name>] [--root PATH] [--json]"

EXPANSION_NOTE = ("expansion: $ARGUMENTS and $1..$9 only; no shell expansion, "
                  "no @file reads and no model switch")

BUILTIN_EXPANSION_NOTE = (
    "expansion: the arguments are appended below the shipped prompt as quoted data; "
    "$ARGUMENTS, $1..$9, shell and @file expansion do not apply here, and no workspace "
    "file can override this text")

BUILTIN_ORIGIN_NOTE = "(built-in prompt shipped with the commands plugin)"


def add_parsers(commands):
    group = commands.add_parser(
        "commands", help="discover file and stored custom commands, and inspect one")
    actions = group.add_subparsers(dest="commands_action")
    listing = actions.add_parser("list", help="every command, its source and any diagnostics")
    _common(listing)
    inspect_parser = actions.add_parser("inspect", help="one command, with its bounded body")
    inspect_parser.add_argument("name")
    _common(inspect_parser)


def _common(parser):
    parser.add_argument("--root", type=Path, default=None,
                        help="workspace holding .xueness/commands (default: current directory)")
    parser.add_argument("--json", action="store_true",
                        help="machine-readable output on stdout")


def _workspace(value) -> Path:
    try:
        return Path(value).expanduser() if value is not None else Path.cwd()
    except (OSError, RuntimeError, ValueError):
        return Path.cwd()


def listing(state_dir, root, language=None) -> dict:
    document = store.list_all(state_dir, root, language=language)
    return {"root": str(root), "stateDir": str(state_dir),
            "commands": document["commands"], "diagnostics": document["diagnostics"],
            "limits": {"expandChars": store.EXPAND_MAX_CHARS,
                       "previewChars": file_commands.BODY_PREVIEW_CHARS,
                       "commandFileBytes": file_commands.MAX_COMMAND_FILE_BYTES,
                       "commandsPerRoot": file_commands.MAX_COMMANDS_PER_ROOT}}


def _line(row: dict) -> str:
    hint = " %s" % row["argumentHint"] if row.get("argumentHint") else ""
    label = "- /%s%s (%s)" % (row["id"], hint, row["source"])
    if row.get("shadowedBy") == file_commands.BUILTIN_SHADOW:
        label += " [shadowed-by-builtin]"
    elif row.get("shadowedBy"):
        label += " [shadowed by %s]" % row["shadowedBy"]
    origin = str(row["path"])
    if row.get("source") == builtin_prompts.BUILTIN_SOURCE:
        origin += "  " + BUILTIN_ORIGIN_NOTE
    return "\n".join([label, "  " + (row["description"] or "(no description)"), "  " + origin])


def _diagnostic_lines(diagnostics) -> list:
    if not diagnostics:
        return []
    lines = ["", "Diagnostics (%d)" % len(diagnostics)]
    for item in diagnostics:
        path = " (%s)" % item["path"] if item.get("path") else ""
        lines.append("- [%s] %s: %s%s" % (item["severity"], item["code"], item["message"], path))
    return lines


def _join(lines: list, diagnostics) -> str:
    return "\n".join([*lines, *_diagnostic_lines(diagnostics)])


def format_listing(document: dict) -> str:
    rows = document["commands"]
    if not rows:
        return _join(["No custom commands found."], document["diagnostics"])
    return _join(["Custom commands (%d)" % len(rows)] + [_line(row) for row in rows],
                 document["diagnostics"])


def format_inspection(result: dict) -> str:
    if not result.get("ok"):
        available = ", ".join("/" + name for name in (result.get("available") or [])) or "(none)"
        return _join(["ERROR: %s" % result.get("error", "command not readable"),
                      "Available: %s" % available], result.get("diagnostics") or [])
    row = result["command"]
    lines = ["Command: /%s" % row["id"],
             "source: %s (scope %s)" % (row["source"], row["scope"]),
             "path: %s" % row["path"],
             "root: %s" % row["rootPath"],
             "description: %s" % (row["description"] or "(none)")]
    if row.get("argumentHint"):
        lines.append("argument-hint: %s" % row["argumentHint"])
    if row.get("model"):
        lines.append("model: %s (shown only; a command file never selects a model)" % row["model"])
    if row.get("frontmatterKeys"):
        lines.append("frontmatter: %s" % ", ".join(row["frontmatterKeys"]))
    if row.get("shadowedBy"):
        lines.append("shadowed: %s" % row["shadowedBy"])
    else:
        lines.append("shadowed: no")
    if row.get("source") == builtin_prompts.BUILTIN_SOURCE:
        lines.append("language: %s (the interface language this prompt was rendered in)"
                     % row.get("language"))
    lines.append("size: %d bytes" % int(result.get("sizeBytes") or row.get("bytes") or 0))
    lines.append(BUILTIN_EXPANSION_NOTE
                 if row.get("source") == builtin_prompts.BUILTIN_SOURCE else EXPANSION_NOTE)
    lines += ["", "Content", result["content"] or "(empty)"]
    if result.get("truncated"):
        lines.append("(body clipped to %d characters)" % file_commands.BODY_PREVIEW_CHARS)
    return _join(lines, result.get("diagnostics") or [])


def execute(args) -> int:
    """``xueness commands ...``; the plugin switch is enforced by the CLI host."""
    root = _workspace(getattr(args, "root", None))
    language = getattr(args, "language", None)
    action = getattr(args, "commands_action", None) or "list"
    json_mode = bool(getattr(args, "json", False))
    try:
        if action == "list":
            document = listing(args.state, root, language)
            print(json.dumps(document, ensure_ascii=False, indent=2) if json_mode
                  else format_listing(document))
            return 0
        if action == "inspect":
            result = store.inspect_command(args.state, args.name, root, language=language)
            print(json.dumps({**result, "root": str(root), "stateDir": str(args.state)},
                             ensure_ascii=False, indent=2) if json_mode
                  else format_inspection(result))
            return 0 if result.get("ok") else 1
    except (OSError, ValueError) as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return 1
    print(USAGE, file=sys.stderr)
    return 1


def handle_slash(argument, ctx) -> str:
    """``/commands [list|inspect <name>]`` through ``plugin_runtime.dispatch_slash``."""
    state_dir = ctx.get("state_dir")
    if state_dir is None:
        return "commands: no state directory in this session."
    session = ctx.get("session")
    root = _workspace(ctx.get("root")
                      or (session.get("root") if isinstance(session, dict) else None))
    language = ctx.get("language")
    verb, _, rest = (argument or "").strip().partition(" ")
    verb, rest = verb.lower(), rest.strip()
    if verb in ("", "list"):
        if rest:
            return "commands list takes no arguments.\n%s" % USAGE
        return format_listing(listing(state_dir, root, language))
    if verb == "inspect":
        if not rest:
            return "commands inspect needs a name.\n%s" % USAGE
        return format_inspection(store.inspect_command(state_dir, rest, root, language=language))
    return "Unknown commands command: %s\n%s" % (verb, USAGE)
