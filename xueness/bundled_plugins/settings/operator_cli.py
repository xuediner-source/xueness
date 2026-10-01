"""Command-line interface owned by the settings plugin."""
import argparse
import json
import sys

from . import plugin
from .settings_store import SECTION_IDS


def add_parsers(commands):
    settings = commands.add_parser("settings", help="show stored settings (all sections or one)")
    settings.add_argument("section", nargs="?", default=None, choices=SECTION_IDS)
    setting = commands.add_parser(
        "settings-set", help="set one key in a settings section (value parsed as JSON, fallback string)")
    setting.add_argument("section", choices=SECTION_IDS)
    setting.add_argument("key")
    setting.add_argument("value")


def execute_cli(args, deps=None):
    try:
        store_factory = getattr(deps, "Store", None) if deps is not None else None
        if store_factory is None:
            from ...core import Store as store_factory
        ctx = {"state_dir": args.state, "store": store_factory(args.state)}
        if args.cmd == "settings":
            parts = ["api", "settings"] + ([args.section] if args.section else [])
            method, query, data = "GET", {}, {}
        elif args.cmd == "settings-set":
            try:
                value = json.loads(args.value)
            except ValueError:
                value = args.value
            method, parts, query = "POST", ["api", "settings", args.section], {}
            data = {"values": {args.key: value}}
        else:
            raise ValueError("unsupported settings command")
        status, payload = plugin.dispatch(method, parts, query, data, ctx)
        if status is None:
            raise ValueError("unsupported command")
        if status >= 400:
            print(f"ERROR ({status}): {payload.get('error', 'unknown')}", file=sys.stderr)
            return 1
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
