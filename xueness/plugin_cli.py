"""CLI commands for inspecting and toggling bundled Xueness plugins."""
import json
import sys

from . import plugin_runtime

#: The manager group plus the singular alias operators naturally reach for.
GROUP_NAMES = ("plugins", "plugin")
#: Sub-actions this manager runs itself. Anything else belongs to the feature
#: plugin that declared it in its manifest ``pluginsActions``.
MANAGED_ACTIONS = ("list", "enable", "disable", "show")


def add_parsers(commands):
    """Register the plugin manager's command group."""
    for name in GROUP_NAMES:
        _add_group(commands, name)


def _add_group(commands, name):
    group = commands.add_parser(name, help="list and toggle bundled features")
    sub = group.add_subparsers(dest="plugins_action", required=True)
    sub.add_parser("list", help="list bundled plugins and their status")
    for action, help_text in (("enable", "enable a bundled plugin"),
                              ("disable", "disable a bundled plugin"),
                              ("show", "show one bundled plugin")):
        command = sub.add_parser(action, help=help_text)
        command.add_argument("id")
    validate = sub.add_parser("validate", help="audit a data manifest, marketplace listing or "
                                               "directory of them without writing anything")
    validate.add_argument("path")
    update = sub.add_parser("update", help="upgrade installed data manifests from the marketplace")
    update.add_argument("id", nargs="?")
    update.add_argument("--all", action="store_true", help="check every installed manifest")
    update.add_argument("--dry-run", action="store_true", help="report the plan without writing")
    profile = sub.add_parser("profile", help="list or apply a plugin composition profile")
    profile_sub = profile.add_subparsers(dest="profile_action", required=True)
    profile_sub.add_parser("list", help="list the selectable profiles")
    profile_show = profile_sub.add_parser("show", help="show one profile and the catalog it would produce")
    profile_show.add_argument("name")
    profile_apply = profile_sub.add_parser("apply", help="choose one profile as the plugin set")
    profile_apply.add_argument("name")
    profile_apply.add_argument("--dry-run", action="store_true", help="report the change without writing")


def _find(items, plugin_id):
    return next((item for item in items if item.get("id") == plugin_id), None)


def execute(args) -> int:
    """Run a plugin manager command and print its JSON result."""
    if args.plugins_action not in MANAGED_ACTIONS:
        return _delegate(args)
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


def _delegate(args) -> int:
    """Hand one declared sub-action to the plugin that owns it, or refuse it.

    The group is kernel routing so plugin management survives every other switch;
    the sub-action is product behaviour, so it needs its owner enabled and stops
    with it. No command name is mapped to a plugin here.
    """
    action = args.plugins_action
    owner = plugin_runtime.plugins_action_owner(action)
    if owner is None:
        print(f"ERROR: no plugin owns the {action} subcommand", file=sys.stderr)
        return 1
    if not plugin_runtime.is_enabled(args.state, owner):
        print(f"ERROR: plugin disabled or dependency unavailable: {owner}", file=sys.stderr)
        return 1
    handler = getattr(plugin_runtime.entrypoint(owner), "execute_cli", None)
    if handler is None:
        print(f"ERROR: plugin {owner} does not run the {action} subcommand", file=sys.stderr)
        return 1
    return handler(args)
