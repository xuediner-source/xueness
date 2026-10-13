"""Identity and lifetime binding for configured external MCP transports.

The digest describes configuration data, never an import path or permission.
Tool approval remains owned by Gate; changing a transport requires discovery
in a new run instead of silently redirecting an already approved tool call.
"""
from __future__ import annotations

import hashlib
import json
import threading
import weakref
from pathlib import Path

_POOLS = weakref.WeakSet()
_LOCK = threading.RLock()


def configuration_digest(server):
    public = {key: value for key, value in server.items()
              if isinstance(key, str) and not key.startswith('_')}
    encoded = json.dumps(public, sort_keys=True, separators=(',', ':'),
                         ensure_ascii=True, allow_nan=False).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def require_available(server):
    if server.get('enabled') is False:
        raise ValueError('MCP server disabled')
    state_dir = server.get('_state_dir')
    if state_dir is not None:
        from ... import plugin_runtime
        plugin_runtime.require_enabled(state_dir, 'mcp')
    if 'package' in server:
        from .package_binding import require_package
        require_package(server)


def register_pool(pool):
    with _LOCK:
        _POOLS.add(pool)


def same_state(left, right):
    from ...write_lock import host_relative_to
    if left is None or right is None:
        return left is right
    return host_relative_to(Path(left).resolve(), Path(right).resolve()) == '.'


def close_for_state(state_dir):
    with _LOCK:
        pools = list(_POOLS)
    for pool in pools:
        pool.close_state(state_dir)
