"""Git CLI face owned by the git plugin.

``git <session> <status|diff|log>`` stays the read-only inspection it always
was; ``git turn-checkpoints`` and ``git rewind`` reach the same dispatch the
web uses, so the persisted plugin switch, the confirm-before-rewrite rule and
the session lease exist in exactly one place. ``git clone <url> <dest>`` joins
them: the same dispatch, the same ``--confirmed`` requirement, and ``--root``
pins the destination parent the way it pins a session workspace.
"""
import json
import sys
from pathlib import Path

from . import plugin

SUBCOMMANDS = ("turn-checkpoints", "rewind", "clone")
VERBS = ("status", "diff", "log")


def add_parsers(commands):
    git = commands.add_parser("git",
                              help="git status/diff/log, turn checkpoints, rewind and clone")
    git.add_argument("target", help="session id to inspect, or one of: " + ", ".join(SUBCOMMANDS))
    git.add_argument("rest", nargs="*", metavar="[verb|url dest]",
                     help="status, diff or log for a session; the remote and destination for clone")
    git.add_argument("--session", help="session id for a subcommand")
    git.add_argument("--checkpoint", help="turn checkpoint id to rewind to")
    git.add_argument("--latest", action="store_true", help="rewind to the newest turn checkpoint")
    git.add_argument("--root", type=Path,
                     help="refuse unless the session workspace, or a clone destination's parent, resolves here")
    git.add_argument("--confirmed", action="store_true",
                     help="acknowledge that the operation writes to this machine")


def execute_cli(args, deps=None):
    store_factory = getattr(deps, "Store", None) if deps is not None else None
    if store_factory is None:
        from ...core import Store as store_factory
    ctx = {"state_dir": args.state, "store": store_factory(args.state)}
    if args.target == "clone":
        return _clone(args, ctx)
    if args.target in SUBCOMMANDS:
        return _run_subcommand(args, ctx)
    if len(args.rest) != 1 or args.rest[0] not in VERBS:
        print("ERROR: expected one of " + ", ".join(VERBS), file=sys.stderr)
        return 1
    status, payload = plugin.dispatch(
        "GET", ["api", "sessions", args.target, "git", args.rest[0]], {}, {}, ctx)
    return _report(status, payload)


def _clone(args, ctx) -> int:
    if len(args.rest) != 2:
        print("ERROR: git clone requires <url> <dest>", file=sys.stderr)
        return 1
    url, dest = args.rest
    # The operator named this parent on the command line; that is the grant. The
    # host still refuses system anchors, and --root pins it against misuse.
    ctx = {**ctx, "workspace_roots": (Path(dest).expanduser().parent,)}
    data = {"url": url, "dest": dest, "confirmed": args.confirmed}
    if args.root is not None:
        data["root"] = str(args.root)
    status, payload = plugin.dispatch("POST", ["api", "git", "clone"], {}, data, ctx)
    return _report(status, payload)


def _run_subcommand(args, ctx) -> int:
    if not args.session:
        print("ERROR: --session is required", file=sys.stderr)
        return 1
    if args.target == "turn-checkpoints":
        status, payload = plugin.dispatch(
            "GET", ["api", "sessions", args.session, "git", "turn-checkpoints"], {}, {}, ctx)
        return _report(status, payload)
    if bool(args.checkpoint) == bool(args.latest):
        print("ERROR: exactly one of --checkpoint or --latest is required", file=sys.stderr)
        return 1
    data = {"confirmed": args.confirmed,
            "checkpoint": args.checkpoint if args.checkpoint else None,
            "latest": args.latest}
    if args.root is not None:
        data["root"] = str(args.root)
    status, payload = plugin.dispatch(
        "POST", ["api", "sessions", args.session, "git", "turn-checkpoints", "rewind"], {}, data, ctx)
    return _report(status, payload)


def _report(status, payload) -> int:
    if status is None:
        print("ERROR: unsupported command", file=sys.stderr)
        return 1
    if status >= 400:
        print(f"ERROR ({status}): {payload.get('error', 'unknown')}", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0
