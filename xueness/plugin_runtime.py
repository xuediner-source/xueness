"""Trusted bundled feature registry shared by CLI, tools, HTTP and UI.

Only package code shipped with Xueness is importable. State stores boolean
switches, never module names, commands or executable entrypoints. Run-time
permissions remain the kernel Gate's responsibility. Disabling a dependency
blocks dependents without silently enabling or rewriting any other plugin.
"""
from __future__ import annotations

import importlib
import json
import threading
from contextlib import contextmanager
from pathlib import Path

from .resources import _atomic_write_json

API_VERSION = 1
PLUGIN_IDS = ('sessions', 'files', 'shell', 'planning', 'providers', 'memory',
              'settings', 'usage', 'git', 'workflows', 'terminal', 'office',
              'commands', 'skills', 'hooks', 'mcp', 'subagents', 'network', 'automation', 'extensions', 'diagnostics', 'browser', 'remote', 'bots', 'onboarding', 'updates', 'desktop')
PACKAGE_ROOT = Path(__file__).with_name('bundled_plugins')
CONFIG_NAME = 'plugin-state.json'
_LOCK = threading.RLock()


class PluginDisabled(ValueError):
    """The requested feature or one of its dependencies is unavailable."""


def _manifests():
    result = {}
    for pid in PLUGIN_IDS:
        item = json.loads((PACKAGE_ROOT / pid / 'manifest.json').read_text())
        if item.get('id') != pid or item.get('apiVersion') != API_VERSION:
            raise ValueError('incompatible bundled plugin manifest')
        if type(item.get('defaultEnabled')) is not bool:
            raise ValueError('invalid bundled plugin default')
        if any(dep not in PLUGIN_IDS for dep in item['dependencies']):
            raise ValueError('unknown bundled plugin dependency')
        result[pid] = item
    return result


def _read_config(state_dir):
    path = Path(state_dir) / CONFIG_NAME
    if path.is_symlink():
        raise ValueError('plugin configuration must not be a symlink')
    try:
        with path.open('rb') as stream:
            raw = stream.read(65537)
    except FileNotFoundError:
        return {}
    if len(raw) > 65536:
        raise ValueError('plugin configuration too large')
    try:
        item = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError('invalid plugin configuration') from None
    if not isinstance(item, dict) or item.get('apiVersion') != API_VERSION or isinstance(item.get('apiVersion'), bool):
        raise ValueError('invalid plugin configuration version')
    if set(item) - {'apiVersion', 'enabled'}:
        raise ValueError('unknown plugin configuration fields')
    switches = item.get('enabled')
    if not isinstance(switches, dict) or any(pid not in PLUGIN_IDS or type(value) is not bool for pid, value in switches.items()):
        raise ValueError('invalid plugin switches')
    return switches


def catalog(state_dir):
    manifests = _manifests()
    error = ''
    try:
        switches = _read_config(state_dir)
    except (OSError, ValueError):
        switches = {pid: False for pid in PLUGIN_IDS}
        error = 'invalid plugin configuration; repair plugin-state.json'
    effective = {}
    def resolve(pid, visiting=()):
        if pid in effective:
            return effective[pid]
        if pid in visiting:
            raise ValueError('cyclic plugin dependencies')
        enabled = switches.get(pid, manifests[pid]['defaultEnabled'])
        available = enabled and all(resolve(dep, visiting + (pid,)) for dep in manifests[pid]['dependencies'])
        effective[pid] = available
        return available
    for pid in PLUGIN_IDS:
        resolve(pid)
    return [{**manifest, 'enabled': switches.get(pid, manifest['defaultEnabled']),
             'effective': effective[pid],
             'blockedBy': [dep for dep in manifest['dependencies'] if not effective[dep]],
             **({'configurationError': error} if error else {})}
            for pid, manifest in manifests.items()]


def is_enabled(state_dir, plugin_id):
    return any(p['id'] == plugin_id and p['effective'] for p in catalog(state_dir))


def require_enabled(state_dir, plugin_id):
    if not is_enabled(state_dir, plugin_id):
        raise PluginDisabled('plugin disabled or dependency unavailable: ' + plugin_id)


@contextmanager
def _config_lock(state_dir):
    # CLI and Web may run in separate processes. Re-read under this lock to
    # avoid one toggle losing another writer's change.
    from . import file_lock as fcntl
    root = Path(state_dir)
    root.mkdir(parents=True, exist_ok=True)
    path = root / '.plugin-state.lock'
    if path.is_symlink():
        raise ValueError('plugin lock must not be a symlink')
    import os
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'a+b') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def set_enabled(state_dir, plugin_id, enabled):
    if plugin_id not in PLUGIN_IDS:
        raise ValueError('unknown plugin: ' + str(plugin_id))
    if type(enabled) is not bool:
        raise ValueError('enabled must be a boolean')
    with _LOCK, _config_lock(state_dir):
        switches = _read_config(state_dir)
        if enabled:
            unavailable = next(p for p in catalog(state_dir) if p['id'] == plugin_id)['blockedBy']
            if unavailable:
                raise ValueError('enable dependencies first: ' + ', '.join(unavailable))
        switches[plugin_id] = enabled
        _atomic_write_json(Path(state_dir) / CONFIG_NAME, {'apiVersion': API_VERSION, 'enabled': switches})
        return catalog(state_dir)


def entrypoint(plugin_id):
    """Load a trusted package from the immutable build allowlist."""
    if plugin_id not in PLUGIN_IDS:
        raise ValueError('unknown plugin')
    return importlib.import_module('xueness.bundled_plugins.' + plugin_id + '.plugin')


def active_tool_names(state_dir):
    from .tool_registry import REGISTRY
    effective = {p['id'] for p in catalog(state_dir) if p['effective']}
    return frozenset(tool.name for tool in REGISTRY if tool_owner(tool.name) in effective)


def tool_owner(name):
    for pid, spec in _manifests().items():
        if name in spec['tools'] or pid == 'mcp' and (name == 'mcp' or name.startswith('mcp__')):
            return pid
    for pid in PLUGIN_IDS:
        if any(tool.name == name for tool in getattr(entrypoint(pid), 'tools', lambda: ())()):
            return pid
    return None


def tool_schemas(state_dir):
    from .tool_registry import REGISTRY
    effective = {p['id'] for p in catalog(state_dir) if p['effective']}
    return [tool.schema() for tool in REGISTRY if tool_owner(tool.name) in effective]


def cli_owner(command, args=None):
    if command == 'resources':
        kind = getattr(args, 'kind', None)
        if kind == 'plugins':
            return 'extensions'
        return kind if kind in ('skills','commands','hooks','mcp','subagents') else None
    for pid, spec in _manifests().items():
        if command in spec['commands']:
            return pid
    return None


def route_owner(parts):
    if not parts or parts[0] != 'api' or len(parts) < 2:
        return None
    family = parts[1]
    if family == 'plugins' and len(parts) > 2 and parts[2] == 'marketplace':
        return 'extensions'
    if family == 'composer':
        return 'sessions'
    if family == 'sessions':
        if len(parts) > 3:
            return {'files':'files','file':'files','git':'git','tasks':'subagents'}.get(parts[3], 'sessions')
        return 'sessions'
    if family == 'resources' and len(parts) > 2:
        if parts[2] == 'plugins':
            return 'extensions'
        return parts[2] if parts[2] in ('skills','commands','hooks','mcp','subagents') else None
    return {'desktop':'desktop','bots':'bots','remote':'remote','diagnostics':'diagnostics','automations':'automation','workflows':'workflows','terminals':'terminal','mcp':'mcp',
            'providers':'providers','settings':'settings','workspaces':'settings','usage':'usage',
            'memory':'memory','browser':'browser','directory':'files','home':'files','system':'files'}.get(family)


def dispatch_http(method, parts, query, data, ctx):
    if parts[:2] == ['api', 'plugins'] and (len(parts) < 3 or parts[2] != 'marketplace'):
        if len(parts) == 2 and method == 'GET':
            return 200, {'plugins': catalog(ctx['state_dir'])}
        if len(parts) == 3 and method == 'POST':
            if set(data) != {'enabled'}:
                return 400, {'error': 'expected enabled boolean only'}
            try:
                items = set_enabled(ctx['state_dir'], parts[2], data['enabled'])
                sync_services(ctx)
                return 200, {'plugins': items}
            except (ValueError, OSError) as exc:
                return 400, {'error': str(exc)}
        return 405, {'error': 'method not allowed'}
    owner = route_owner(parts)
    if owner:
        if not is_enabled(ctx['state_dir'], owner):
            return 403, {'error': 'plugin disabled or dependency unavailable: ' + owner, 'plugin': owner}
        handler = getattr(entrypoint(owner), 'dispatch', None)
        if handler:
            result = handler(method, parts, query, data, ctx)
            if result is not None:
                return result
    # Generic resource repository is kernel storage; individual resource kinds
    # have been checked above, and legacy SDK manifests remain manageable.
    if parts[:2] == ['api', 'resources']:
        from . import resources
        return resources.dispatch(method, parts, query, data, ctx)
    return None


def sync_services(ctx):
    """Apply terminal lifecycle changes at HTTP request boundaries."""
    if ctx.get("handler") is not None:
        ctx = ctx["handler"]._ctx
    enabled = {p['id'] for p in catalog(ctx['state_dir']) if p['effective']}
    with ctx['lock']:
        broker = ctx.get('terminals')
        if 'terminal' not in enabled:
            if broker is not None:
                broker.close()
                ctx['terminals'] = None
        elif broker is None:
            ctx['terminals'] = entrypoint('terminal').create_service()
        if 'browser' not in enabled:
            shutdown = getattr(entrypoint('browser'), 'shutdown', None)
            if shutdown:
                shutdown(ctx['state_dir'])
        scheduler = ctx.get('automation_service')
        if 'automation' not in enabled:
            if scheduler is not None:
                scheduler.close()
                ctx['automation_service'] = None
        elif scheduler is None and ctx.get('serve_plugins'):
            ctx['automation_service'] = entrypoint('automation').create_service(ctx['state_dir'], allow_real=ctx.get('allow_real', False))


def register_cli_parsers(commands):
    for pid in PLUGIN_IDS:
        register = getattr(entrypoint(pid), 'register_cli', None)
        if register:
            register(commands)
