"""CLI face of workspace hook trust: ``xueness hooks trust ...``.

One document (:func:`workspace_hooks.status_document`) feeds the terminal, the
``--json`` output and the read-only HTTP route, so a review cannot read
differently in two places. Nothing here executes a hook: grants only record
digests, and commands run exclusively through the existing HookRunner seam.

Exit codes: 0 on success (including a review that still shows pending items),
1 on refusal. A disabled plugin never reaches this module — the CLI host
refuses first with a non-zero exit and empty stdout.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from . import workspace_hooks as store

USAGE = """Usage:
  xueness hooks trust status [--workspace PATH] [--json]
  xueness hooks trust review [--workspace PATH] [--json]
  xueness hooks trust grant --workspace PATH (--hook-digest <sha256> ... | --all-current --bundle-digest <sha256>)
  xueness hooks trust revoke --workspace PATH (--hook-digest <sha256> ... | --all)
  xueness hooks workspace on|off|show [--json]
"""


def add_parsers(commands):
    hooks = commands.add_parser(
        "hooks", help="workspace hook discovery, review and digest trust")
    actions = hooks.add_subparsers(dest="hooks_action", required=True)

    trust = actions.add_parser("trust", help="review and grant workspace hook trust")
    verbs = trust.add_subparsers(dest="trust_action")
    for verb, help_text in (("status", "trust state for one workspace"),
                            ("review", "every declaration with its trust state")):
        parser = verbs.add_parser(verb, help=help_text)
        parser.add_argument("--workspace", type=Path, default=None,
                            help="workspace to inspect (default: current directory)")
        parser.add_argument("--json", action="store_true",
                            help="machine-readable output on stdout")
    grant = verbs.add_parser("grant", help="trust specific declarations by digest")
    _grant_revoke_common(grant)
    grant.add_argument("--hook-digest", action="append", default=[], metavar="SHA256",
                       help="declaration digest to trust (repeatable)")
    grant.add_argument("--all-current", action="store_true",
                       help="trust every currently enabled declaration")
    grant.add_argument("--bundle-digest", default=None, metavar="SHA256",
                       help="bundle digest captured at review time; refuses on mismatch")
    revoke = verbs.add_parser("revoke", help="drop trust records for one workspace")
    _grant_revoke_common(revoke)
    revoke.add_argument("--hook-digest", action="append", default=[], metavar="SHA256",
                        help="declaration digest to revoke (repeatable)")
    revoke.add_argument("--all", action="store_true",
                        help="revoke every record for this workspace")

    workspace = actions.add_parser(
        "workspace", help="enable or disable workspace hooks (default: off)")
    workspace.add_argument("toggle", choices=("on", "off", "show"))
    workspace.add_argument("--json", action="store_true")


def _grant_revoke_common(parser):
    parser.add_argument("--workspace", type=Path, required=True,
                        help="workspace the records belong to")
    parser.add_argument("--json", action="store_true",
                        help="machine-readable output on stdout")


def _workspace(value) -> Path:
    try:
        return Path(value).expanduser() if value is not None else Path.cwd()
    except (OSError, RuntimeError, ValueError):
        return Path.cwd()


def _emit(args, document) -> None:
    if getattr(args, "json", False):
        print(json.dumps(document, ensure_ascii=False, indent=2))
    else:
        print(format_status(document))


def _fail(args, reason: str) -> int:
    if getattr(args, "json", False):
        print(json.dumps({"accepted": False, "reason": reason}, ensure_ascii=False))
    else:
        print("ERROR: %s" % reason, file=sys.stderr)
    return 1


def format_status(document: dict) -> str:
    action_hint = {"pending_trust": "pending trust",
                   "trusted": "trusted",
                   "trust_store_corrupt": "trust store corrupt"}.get(
        document.get("reason"), document.get("reason") or "unknown")
    lines = ["Workspace hook trust",
             "workspace: %s" % (document.get("workspace") or "(none)"),
             "feature: %s" % ("enabled" if document.get("featureEnabled") else "disabled"),
             "bundle: %s" % (document.get("bundleDigest") or "none"),
             "trust store: %s" % document.get("trustStatus", "unknown"),
             "state: %s" % action_hint]
    items = document.get("items") or []
    if not items:
        lines.append("No workspace hook declarations found.")
    for index, item in enumerate(items, 1):
        lines.append("%d. [%s] [%s] %s%s"
                     % (index, item["trustState"],
                        "enabled" if item["enabled"] else "disabled",
                        item["event"], " / %s" % item["matcher"] if item.get("matcher") else ""))
        lines.append("   %s" % item["command"])
        lines.append("   source: %s (%s)" % (item["sourcePath"], item["source"]))
        lines.append("   digest: %s" % item["digest"])
    if document.get("reason") == "pending_trust":
        lines += ["Grant exact declarations with:",
                  "  xueness hooks trust grant --workspace <path> --hook-digest <sha256>",
                  "Or trust every currently enabled declaration in this exact bundle with:",
                  "  xueness hooks trust grant --workspace <path> --all-current --bundle-digest %s"
                  % document.get("bundleDigest")]
    if document.get("reason") == "trust_store_corrupt":
        lines += ["The persistent trust store is corrupt; grant/revoke are rejected "
                  "until it is repaired.",
                  "Nothing was trusted and nothing was rewritten: %s"
                  % (document.get("corruptPath") or store.TRUST_FILENAME),
                  "Recovery: repair that file by hand, restore it from backup, or "
                  "remove it so a fresh store is created, then re-run grant."]
    lines += _diagnostic_lines(document.get("diagnostics") or [])
    return "\n".join(lines)


def _diagnostic_lines(diagnostics) -> list:
    if not diagnostics:
        return []
    lines = ["", "Diagnostics (%d)" % len(diagnostics)]
    for item in diagnostics:
        path = " (%s)" % item["path"] if item.get("path") else ""
        lines.append("- [%s] %s: %s%s" % (item["severity"], item["code"],
                                          item["message"], path))
    return lines


# -- verbs --------------------------------------------------------------------

def _status(args) -> int:
    document = store.status_document(args.state, _workspace(getattr(args, "workspace", None)))
    _emit(args, document)
    return 0


def _grant(args) -> int:
    digests = list(dict.fromkeys(getattr(args, "hook_digest", None) or []))
    all_current = bool(getattr(args, "all_current", False))
    bundle_digest = getattr(args, "bundle_digest", None)
    if all_current == bool(digests):
        return _fail(args, "specify exactly one of --hook-digest or --all-current")
    if all_current and not bundle_digest:
        return _fail(args, "--all-current requires --bundle-digest")
    if not store.feature_enabled(args.state):
        return _fail(args, "feature_disabled")
    workspace = store.canonical_workspace(_workspace(args.workspace))
    found = store.discover(workspace)
    if not found["hooks"]:
        return _fail(args, "no_workspace_hooks")
    if found["bundleDigest"] and bundle_digest and bundle_digest != found["bundleDigest"]:
        return _fail(args, "bundle_changed")
    if all_current:
        selected = [row for row in found["hooks"] if row["enabled"]]
        if not selected:
            return _fail(args, "no_enabled_hooks")
    else:
        by_digest = {row["digest"]: row for row in found["hooks"]}
        missing = [digest for digest in digests if digest not in by_digest]
        if missing:
            return _fail(args, "digest_mismatch: %s" % ", ".join(missing))
        selected = [by_digest[digest] for digest in digests]
    outcome = store.grant_trust(args.state, workspace, selected)
    if not outcome["ok"]:
        return _fail(args, outcome["reason"])
    document = store.status_document(args.state, args.workspace)
    document["granted"] = outcome["granted"]
    _emit(args, document)
    return 0


def _revoke(args) -> int:
    digests = list(dict.fromkeys(getattr(args, "hook_digest", None) or []))
    revoke_all = bool(getattr(args, "all", False))
    if revoke_all == bool(digests):
        return _fail(args, "specify exactly one of --hook-digest or --all")
    workspace = store.canonical_workspace(_workspace(args.workspace))
    outcome = store.revoke_trust(args.state, workspace, digests, revoke_all=revoke_all)
    if not outcome["ok"]:
        return _fail(args, outcome["reason"])
    document = store.status_document(args.state, args.workspace)
    document["revoked"] = outcome["removed"]
    _emit(args, document)
    return 0


def _workspace_toggle(args) -> int:
    toggle = getattr(args, "toggle", "show")
    if toggle in ("on", "off"):
        try:
            store.set_feature(args.state, toggle == "on")
        except (OSError, ValueError) as exc:
            return _fail(args, str(exc))
    document = {"workspace": str(_workspace(None)), "enabled": store.feature_enabled(args.state)}
    if getattr(args, "json", False):
        print(json.dumps(document, ensure_ascii=False, indent=2))
    else:
        print("Workspace hooks %s" % ("enabled" if document["enabled"] else "disabled"))
    return 0


def execute(args) -> int:
    """``xueness hooks ...``; the plugin switch is enforced by the CLI host."""
    action = getattr(args, "hooks_action", None)
    try:
        if action == "trust":
            verb = getattr(args, "trust_action", None) or "status"
            if verb in ("status", "review"):
                return _status(args)
            if verb == "grant":
                return _grant(args)
            if verb == "revoke":
                return _revoke(args)
        if action == "workspace":
            return _workspace_toggle(args)
    except (OSError, ValueError) as exc:
        return _fail(args, str(exc))
    print(USAGE, file=sys.stderr)
    return 1
