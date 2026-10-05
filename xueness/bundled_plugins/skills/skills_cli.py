"""CLI and in-chat face of skill discovery: ``skills list|inspect``, ``/skills``.

One formatter serves the terminal, the chat reply and the plugin panel data, so
a listing cannot read differently in two places. Bodies are bounded by
``skills.inspect_skill``; nothing here decides permissions or reads a path the
caller invented.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from . import file_skills
from . import skills as store

USAGE = "Usage: xueness skills [list|inspect <name>] [--root PATH] [--json]"


def add_parsers(commands):
    skills = commands.add_parser(
        "skills", help="discover directory-shaped and stored skills, and inspect one")
    actions = skills.add_subparsers(dest="skills_action")
    listing = actions.add_parser("list", help="every skill, its source and any diagnostics")
    _common(listing)
    inspect_parser = actions.add_parser("inspect", help="one skill, with its bounded body")
    inspect_parser.add_argument("name")
    _common(inspect_parser)


def _common(parser):
    parser.add_argument("--root", type=Path, default=None,
                        help="workspace holding .xueness/skills (default: current directory)")
    parser.add_argument("--json", action="store_true",
                        help="machine-readable output on stdout")


def _workspace(value) -> Path:
    try:
        return Path(value).expanduser() if value is not None else Path.cwd()
    except (OSError, RuntimeError, ValueError):
        return Path.cwd()


def listing(state_dir, root) -> dict:
    document = store.list_all(state_dir, root)
    return {"root": str(root), "stateDir": str(state_dir),
            "skills": document["skills"], "diagnostics": document["diagnostics"]}


def _line(row: dict) -> str:
    label = "%s (%s)" % (row["name"], row["source"])
    if row.get("shadowedBy"):
        label += " [shadowed by %s]" % row["shadowedBy"]
    return "\n".join([label, "  " + (row["description"] or "(no description)"),
                      "  " + str(row["path"])])


def format_listing(document: dict) -> str:
    rows = document["skills"]
    if not rows:
        return _join(["No skills found."], document["diagnostics"])
    return _join(["Available skills (%d)" % len(rows)] + [_line(row) for row in rows],
                 document["diagnostics"])


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


def _attachment_lines(row: dict) -> list:
    files = row.get("attachments") or []
    if not files:
        return []
    lines = ["attachments: %s" % ", ".join("%s (%d bytes)" % (item["name"], item["bytes"])
                                           for item in files)]
    if row.get("attachmentsTruncated"):
        lines.append("  (only the first %d attachment names are listed)"
                     % file_skills.MAX_ATTACHMENTS_PER_SKILL)
    return lines


def format_inspection(result: dict) -> str:
    if not result.get("ok"):
        available = ", ".join(result.get("available") or []) or "(none)"
        return _join(["ERROR: %s" % result.get("error", "skill not readable"),
                      "Available: %s" % available], result.get("diagnostics") or [])
    row = result["skill"]
    tags = ", ".join(row["tags"]) if row.get("tags") else "(none)"
    lines = ["Skill: %s" % row["name"],
             "source: %s (scope %s)" % (row["source"], row["scope"]),
             "id: %s" % row["id"],
             "path: %s" % row["path"],
             "directory: %s" % row["directory"],
             "description: %s" % (row["description"] or "(none)"),
             "tags: %s" % tags,
             "shadowed: %s" % (row["shadowedBy"] if row.get("shadowedBy") else "no"),
             "size: %d bytes" % int(result.get("sizeBytes") or row.get("bytes") or 0)]
    lines.extend(_attachment_lines(row))
    lines += ["", "Content", result["content"] or "(empty)"]
    if result.get("truncated"):
        lines.append("(body clipped to %d characters)" % store.READ_TOTAL_BUDGET)
    return _join(lines, result.get("diagnostics") or [])


def execute(args) -> int:
    """``xueness skills ...``; the plugin switch is enforced by the CLI host."""
    root = _workspace(getattr(args, "root", None))
    action = getattr(args, "skills_action", None) or "list"
    json_mode = bool(getattr(args, "json", False))
    try:
        if action == "list":
            document = listing(args.state, root)
            print(json.dumps(document, ensure_ascii=False, indent=2) if json_mode
                  else format_listing(document))
            return 0
        if action == "inspect":
            result = store.inspect_skill(args.state, args.name, root)
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
    """``/skills [list|inspect <name>]`` through ``plugin_runtime.dispatch_slash``."""
    state_dir = ctx.get("state_dir")
    if state_dir is None:
        return "skills: no state directory in this session."
    session = ctx.get("session")
    root = _workspace(ctx.get("root")
                      or (session.get("root") if isinstance(session, dict) else None))
    verb, _, rest = (argument or "").strip().partition(" ")
    verb, rest = verb.lower(), rest.strip()
    if verb in ("", "list"):
        if rest:
            return "skills list takes no arguments.\n%s" % USAGE
        return format_listing(listing(state_dir, root))
    if verb == "inspect":
        if not rest:
            return "skills inspect needs a name.\n%s" % USAGE
        return format_inspection(store.inspect_skill(state_dir, rest, root))
    return "Unknown skills command: %s\n%s" % (verb, USAGE)
