"""Settings for this server process's managed browser profile."""
from __future__ import annotations

import os
from pathlib import Path
import shutil

_CACHE_PATHS = ('Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache',
                'Default/Cache', 'Default/Code Cache', 'Default/GPUCache')


def _profile(ctx):
    state = Path(ctx['state_dir']).resolve()
    profile = state / f'browser-profile-{os.getpid()}'
    if profile.is_symlink() or not profile.resolve().is_relative_to(state):
        raise ValueError('managed browser profile path denied')
    if profile.exists() and not profile.is_dir():
        raise ValueError('managed browser profile path denied')
    return profile


def _cache_targets(profile):
    targets = []
    for name in _CACHE_PATHS:
        target = profile / name
        if (target.is_symlink() or any(parent.is_symlink() for parent in target.parents
                                     if parent.is_relative_to(profile))
                or not target.resolve().is_relative_to(profile)):
            raise ValueError('managed browser cache path denied')
        if target.exists():
            targets.append(target)
    return targets


def dispatch(method, parts, query, data, ctx):
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
            plugin.shutdown(ctx['state_dir'])
            for target in targets:
                if target.is_dir():
                    shutil.rmtree(target)
                elif target.exists():
                    target.unlink()
            return 200, {'ok': True}
    except (ValueError, OSError):
        return 400, {'error': 'managed browser data unavailable or invalid'}
