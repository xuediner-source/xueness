"""Read-only CLI commands owned by the git plugin."""
import json
import sys

from . import plugin


def add_parsers(commands):
    git = commands.add_parser("git", help="read-only git status/diff/log over a session workspace")
    git.add_argument("id")
    git.add_argument("verb", choices=("status", "diff", "log"))


def execute_cli(args, deps=None):
    store_factory = getattr(deps, "Store", None) if deps is not None else None
    if store_factory is None:
        from ...core import Store as store_factory
    status, payload = plugin.dispatch(
        "GET", ["api", "sessions", args.id, "git", args.verb], {}, {},
        {"state_dir": args.state, "store": store_factory(args.state)})
    if status is None:
        print("ERROR: unsupported command", file=sys.stderr)
        return 1
    if status >= 400:
        print(f"ERROR ({status}): {payload.get('error', 'unknown')}", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0
