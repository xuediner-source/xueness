"""Settings for this server process's managed browser profile."""
from __future__ import annotations

import shutil
import re

from .profiles import _link

_CACHE_PATHS = ('Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache',
                'Default/Cache', 'Default/Code Cache', 'Default/GPUCache')


def _profile(ctx):
    from .profiles import managed_profile
    return managed_profile(ctx['state_dir'])


def _cache_targets(profile):
    targets = []
    for name in _CACHE_PATHS:
        target = profile / name
        if ((target.exists() or target.is_symlink()) and _link(target)
                or any((parent.exists() or parent.is_symlink()) and _link(parent) for parent in target.parents
                       if parent.is_relative_to(profile))
                or not target.resolve().is_relative_to(profile)):
            raise ValueError('managed browser cache path denied')
        if target.exists():
            targets.append(target)
    return targets


def dispatch(method, parts, query, data, ctx):
    if parts == ['api', 'browser', 'runtime']:
        if method != 'GET':
            return 405, {'error': 'method not allowed'}
        from .runtime import browser_runtime
        from ... import plugin_runtime
        desktop = bool(ctx.get('desktop_token'))
        return 200, {**browser_runtime(), 'desktop': desktop,
                     'importEnabled': desktop and plugin_runtime.is_enabled(ctx['state_dir'], 'desktop')}
    if parts != ['api', 'browser', 'data']:
        return None
    if method not in ('GET', 'POST'):
        return 405, {'error': 'method not allowed'}
    try:
        from . import plugin
        # Task starts use the same context lock. Broker creation also takes the
        # broker lock, so a clear cannot race a new managed browser worker.
        with ctx['lock'], plugin._BROKERS_LOCK:
            profile = _profile(ctx)
            if method == 'GET':
                return 200, {'profilePresent': profile.is_dir()}
            operation = data.get('operation')
            if operation not in ('cache', 'all') or set(data) - {'operation', 'confirmed'}:
                return 400, {'error': 'expected cache or all operation'}
            if operation == 'all' and data.get('confirmed') is not True:
                return 400, {'error': 'confirmation required to clear all browser data'}
            if ctx.get('running'):
                return 409, {'error': 'stop running tasks before clearing browser data'}
            targets = _cache_targets(profile) if operation == 'cache' else [profile]
            if operation == 'all':
                # Only generated, direct-child backups from a successful import
                # may be cleared along with the explicitly confirmed profile.
                for candidate in profile.parent.iterdir():
                    if re.fullmatch(r'browser-import-old-[0-9a-f]{32}', candidate.name):
                        if _link(candidate) or candidate.resolve().parent != profile.parent or not candidate.is_dir():
                            raise ValueError('managed browser backup path denied')
                        targets.append(candidate)
            plugin.shutdown(ctx['state_dir'])
            for target in targets:
                if target.is_dir():
                    shutil.rmtree(target)
                elif target.exists():
                    target.unlink()
            return 200, {'ok': True}
    except (ValueError, OSError):
        return 400, {'error': 'managed browser data unavailable or invalid'}
