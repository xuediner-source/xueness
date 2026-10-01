"""CLI commands for inspecting and toggling bundled Xueness plugins."""
import json
import sys

from . import plugin_runtime


def add_parsers(commands):
    """Register the plugin manager's command group."""
    group = commands.add_parser("plugins", help="list and toggle bundled features")
    sub = group.add_subparsers(dest="plugins_action", required=True)
    sub.add_parser("list", help="list bundled plugins and their status")
    for action, help_text in (("enable", "enable a bundled plugin"),
                              ("disable", "disable a bundled plugin"),
                              ("show", "show one bundled plugin")):
        command = sub.add_parser(action, help=help_text)
        command.add_argument("id")


def _find(items, plugin_id):
    return next((item for item in items if item.get("id") == plugin_id), None)


def execute(args) -> int:
    """Run a plugin manager command and print its JSON result."""
    try:
        items = plugin_runtime.catalog(args.state)
        if args.plugins_action == "list":
            result = items
        elif args.plugins_action == "show":
            result = _find(items, args.id)
            if result is None:
                raise ValueError(f"unknown plugin: {args.id}")
        else:
            enabled = args.plugins_action == "enable"
            items = plugin_runtime.set_enabled(args.state, args.id, enabled)
            if not enabled:
                hook = getattr(plugin_runtime.entrypoint(args.id), "on_disabled", None)
                if hook:
                    hook(args.state)
            result = _find(items, args.id)
            if result is None:
                # A runtime implementation may return only the changed item.
                result = {"id": args.id, "enabled": enabled}
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0
