"""Per-state first-launch progress; OS permissions remain desktop-owned."""
import json
import os
import stat
from pathlib import Path

from ... import plugin_runtime
from ...resources import _atomic_write_json, _is_link


def _path(ctx):
    state = Path(ctx['state_dir'])
    target = state / 'desktop-onboarding.json'
    if _is_link(state) or _is_link(target):
        raise ValueError('onboarding state must not be a link or reparse point')
    return target


def _load(ctx):
    path = _path(ctx)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    except FileNotFoundError:
        return {'completed': False, 'version': 1}
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('invalid onboarding state file')
        raw = stream.read(4097)
    if len(raw) > 4096:
        raise ValueError('onboarding state too large')
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'completed', 'version'}
            or type(value['completed']) is not bool or type(value['version']) is not int
            or value['version'] != 1):
        raise ValueError('invalid onboarding state')
    return value


def dispatch(method, parts, data, ctx):
    if parts != ['api', 'onboarding', 'desktop']:
        return None
    if not ctx.get('desktop_token'):
        return 403, {'error': 'desktop host required'}
    if not plugin_runtime.is_enabled(ctx['state_dir'], 'desktop'):
        return 403, {'error': 'desktop plugin unavailable', 'plugin': 'desktop'}
    try:
        with plugin_runtime._config_lock(ctx['state_dir']):
            if method == 'GET':
                return 200, _load(ctx)
            if method == 'POST':
                if not isinstance(data, dict) or set(data) != {'completed'} or data['completed'] is not True:
                    return 400, {'error': 'expected completed true only'}
                value = {'completed': True, 'version': 1}
                _atomic_write_json(_path(ctx), value)
                return 200, value
            return 405, {'error': 'method not allowed'}
    except (ValueError, OSError):
        return 400, {'error': 'onboarding state could not be read or saved'}
