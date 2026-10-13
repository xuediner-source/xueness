"""Marketplace, manifest audit and composition profile contribution."""
import json
import sys

from ... import plugin_runtime
from . import marketplace, profiles, validate_update


def register_cli(commands):
    from .package_cli import add_parser
    add_parser(commands)


def dispatch(method, parts, query, data, ctx):
    """Ask each owned HTTP family in turn; the most specific route answers first.

    ``marketplace`` is last because its catch-all answers 405 for any other path
    under the shared ``plugins/marketplace`` prefix, which ``validate_update``
    claims one segment deeper.
    """
    from . import package_cli
    for module in (package_cli, validate_update, profiles, marketplace):
        result = module.dispatch(method, parts, query, data, ctx)
        if result is not None:
            return result
    return None


def execute_cli(args):
    """Run one sub-action of the shared ``plugins`` group and print its JSON.

    The command group stays kernel routing; validation, upgrades and profile
    selection belong to this plugin, so they stop when the plugin does.
    """
    try:
        plugin_runtime.require_enabled(args.state, 'extensions')
        result = _run(args)
    except (ValueError, OSError) as exc:
        print('ERROR: %s' % exc, file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get('ok', True) else 1


def _run(args):
    if getattr(args, 'cmd', None) == 'extension-package':
        from .package_cli import execute
        return execute(args)
    action = args.plugins_action
    if action == 'validate':
        return validate_update.validate(args.path)
    if action == 'update':
        return validate_update.update(args.state, getattr(args, 'id', None),
                                      bool(getattr(args, 'all', False)), bool(args.dry_run))
    if action == 'profile':
        return profiles.command(args.state, args.profile_action, getattr(args, 'name', None),
                                bool(getattr(args, 'dry_run', False)))
    raise ValueError('unsupported plugins subcommand: %s' % action)


def composer_capabilities():
    from .composer_capabilities import CAPABILITIES
    return CAPABILITIES


def tools():
    from .creator_tooling import REGISTRY
    return REGISTRY


def activate(scope, ctx):
    from ..mcp.package_binding import close_managed
    scope.ensure('extensions.external_packages', lambda: ctx['state_dir'], close_managed)


def on_disabled(state_dir):
    from ..mcp.package_binding import close_managed
    close_managed(state_dir)
