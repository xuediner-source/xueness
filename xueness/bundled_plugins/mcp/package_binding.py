"""Approved source packages contribute MCP servers through a trusted launcher."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import sys

from ... import plugin_runtime
from ..extensions import package_store, package_trust


def server_id(package_id):
    return 'pkg-' + package_id[:40] + '-' + hashlib.sha256(package_id.encode()).hexdigest()[:8]


def require_package(server):
    ref = server.get('package')
    if not isinstance(ref, dict) or set(ref) != {'id', 'archiveSha256'}:
        raise ValueError('invalid managed package reference')
    state = server.get('_state_dir')
    if state is None:
        raise ValueError('managed package requires a bound state directory')
    plugin_runtime.require_enabled(state, 'extensions')
    resolved = package_store.resolved_package(state, ref['id'])
    if not resolved.get('enabled') or resolved['archiveSha256'] != ref['archiveSha256']:
        raise ValueError('package disabled or version changed; discover tools again')
    if set(resolved.get('grants', [])) != set(resolved['manifest']['capabilities']):
        raise ValueError('package capabilities require explicit approval')
    package_trust.verify_receipt(state, resolved['receipt'], resolved['archiveSha256'])
    return resolved


def managed_servers(state):
    if not plugin_runtime.is_enabled(state, 'extensions'):
        return []
    servers = []
    for row in package_store.list_packages(state):
        if not row.get('enabled'):
            continue
        ref = {'id': row['id'], 'archiveSha256': row['archiveSha256']}
        server = {'id': server_id(row['id']), 'transport': 'stdio',
                  'command': 'xueness-managed-package', 'package': ref,
                  '_state_dir': str(Path(state).absolute())}
        try:
            resolved = require_package(server)
        except (OSError, ValueError):
            continue
        server['packageVersion'] = resolved['version']
        servers.append(server)
    return servers


def source_command(resolved):
    runtime = resolved['manifest']['runtime']
    if runtime == 'python':
        override = os.environ.get('XUENESS_EXTERNAL_PYTHON') if getattr(sys, 'frozen', False) else None
        if override:
            selected = Path(override).expanduser()
            if not selected.is_absolute() or not selected.is_file():
                raise ValueError('configured external Python runtime is unavailable')
            executable = str(selected.resolve())
        else:
            executable = sys.executable if not getattr(sys, 'frozen', False) else (
                shutil.which('python3') or shutil.which('python'))
        if not executable:
            raise ValueError('external Python runtime is unavailable')
        return [executable, '-E', '-s', '-B', str(resolved['entrypoint'])]
    executable = os.environ.get('XUENESS_DESKTOP_NODE') or shutil.which('node')
    if not executable:
        raise ValueError('external Node runtime is unavailable')
    return [executable, str(resolved['entrypoint'])]


def launch_command(server):
    resolved = require_package(server)
    if resolved['manifest']['transport'] == 'mcp-stdio':
        return source_command(resolved)
    state = Path(server['_state_dir']).absolute()
    args = ['--state', str(state), 'mcp-acp-worker', resolved['id'], resolved['archiveSha256']]
    return [sys.executable, *args] if getattr(sys, 'frozen', False) else [sys.executable, '-m', 'xueness', *args]


def launch_environment(server):
    resolved = require_package(server)
    result = {}
    if resolved['manifest']['runtime'] == 'node' and os.environ.get('XUENESS_DESKTOP_NODE'):
        result['ELECTRON_RUN_AS_NODE'] = '1'
    if resolved['manifest']['transport'] == 'acp-stdio' and not getattr(sys, 'frozen', False):
        result['PYTHONPATH'] = str(Path(__file__).resolve().parents[3])
    return result


def close_package(state, package_id):
    """Reap affected clients before a version, permission or install change."""
    from .process_boundary import _LOCK, _POOLS, same_state
    with _LOCK:
        pools = list(_POOLS)
    for pool in pools:
        with pool.lock:
            for sid, client in list(pool.clients.items()):
                ref = client.server.get('package') or {}
                if ref.get('id') == package_id and same_state(client.server.get('_state_dir'), state):
                    client.close()
                    if getattr(client, '_process_cleanup_failed', False):
                        raise ValueError('package process cleanup failed; change refused')
                    pool.discard(sid)


def close_managed(state, key_id=None):
    from .process_boundary import _LOCK, _POOLS, same_state
    with _LOCK:
        pools = list(_POOLS)
    for pool in pools:
        with pool.lock:
            for sid, client in list(pool.clients.items()):
                if client.server.get('package') and same_state(client.server.get('_state_dir'), state):
                    if key_id is not None:
                        try:
                            package = package_store.resolved_package(state, client.server['package']['id'])
                            if package['receipt']['provenance'].get('keyId') != key_id:
                                continue
                        except (OSError, ValueError):
                            pass  # A damaged installed package also loses its live transport.
                    pool.discard(sid)
