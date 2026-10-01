"""Command-line interface owned by the usage plugin."""
import json
import sys

from . import plugin


def add_parsers(commands):
    usage = commands.add_parser("usage", help="usage summary from local journals")
    usage.add_argument("--range", dest="range_param", default="7d", choices=("7d", "30d", "all"))


def execute_cli(args, deps=None):
    store_factory = getattr(deps, "Store", None) if deps is not None else None
    if store_factory is None:
        from ...core import Store as store_factory
    status, payload = plugin.dispatch(
        "GET", ["api", "usage"], {"range": [args.range_param]}, {},
        {"state_dir": args.state, "store": store_factory(args.state)})
    if status is None:
        print("ERROR: unsupported command", file=sys.stderr)
        return 1
    if status >= 400:
        print(f"ERROR ({status}): {payload.get('error', 'unknown')}", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0
