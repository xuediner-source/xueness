"""Desktop-owned permission status and explicit native permission actions."""
import re
import sys

from ... import plugin_runtime

PERMISSIONS = ('accessibility', 'screen', 'fullDisk', 'microphone')
STATUSES = frozenset({'granted', 'not-determined', 'denied', 'restricted', 'unknown', 'unsupported'})
REQUEST_ID = re.compile(r'[a-f0-9]{32}')


def bind_permissions(ctx, bridge):
    """Bind permission requests to the authenticated Electron parent pipe."""
    ctx['desktop_permissions_bridge'] = bridge


def unsupported_snapshot(platform=None):
    return {
        'platform': platform or sys.platform,
        'permissions': [
            {'id': permission, 'status': 'unsupported', 'canRequest': False}
            for permission in PERMISSIONS
        ],
    }


def _valid_snapshot(value):
    if not isinstance(value, dict) or set(value) != {'platform', 'permissions'}:
        return False
    if not isinstance(value['platform'], str) or not value['platform'] or len(value['platform']) > 32:
        return False
    rows = value['permissions']
    if not isinstance(rows, list) or len(rows) != len(PERMISSIONS):
        return False
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not {'id', 'status', 'canRequest'} <= set(row):
            return False
        if set(row) - {'id', 'status', 'canRequest', 'requiresRestart'}:
            return False
        if not isinstance(row['id'], str) or row['id'] not in PERMISSIONS or row['id'] in seen:
            return False
        if not isinstance(row['status'], str) or row['status'] not in STATUSES or type(row['canRequest']) is not bool:
            return False
        if 'requiresRestart' in row and type(row['requiresRestart']) is not bool:
            return False
        seen.add(row['id'])
    return seen == set(PERMISSIONS)


def _native_snapshot(ctx, action, permission=None):
    if not ctx.get('desktop_token'):
        if action == 'request':
            return 403, {'error': 'desktop host required'}
        return 200, unsupported_snapshot()
    bridge = ctx.get('desktop_permissions_bridge')
    if bridge is None:
        return 503, {'error': 'desktop permission bridge unavailable'}
    message = {'type': 'permissions', 'action': action}
    if action == 'request':
        message['permission'] = permission
    try:
        result = bridge.request(message, timeout=600 if action == 'request' else 30)
    except Exception:
        return 503, {'error': 'desktop permission service unavailable'}
    if not isinstance(result, dict):
        return 503, {'error': 'invalid desktop permission response'}
    if set(result) == {'id', 'error'}:
        if not isinstance(result['id'], str) or not REQUEST_ID.fullmatch(result['id']):
            return 503, {'error': 'invalid desktop permission response'}
        if result['error'] == 'disabled':
            return 403, {'error': 'desktop plugin disabled or dependency unavailable: desktop', 'plugin': 'desktop'}
        return 503, {'error': 'desktop permission service unavailable'}
    if set(result) != {'id', 'state'} or not isinstance(result['id'], str) or not REQUEST_ID.fullmatch(result['id']) or not _valid_snapshot(result['state']):
        return 503, {'error': 'invalid desktop permission response'}
    return 200, result['state']


def dispatch(method, parts, query, data, ctx):
    if parts == ['api', 'desktop', 'permissions', 'policy']:
        if method != 'GET':
            return 405, {'error': 'method not allowed'}
        if not ctx.get('desktop_token'):
            return 403, {'error': 'desktop host required'}
        if not plugin_runtime.is_enabled(ctx['state_dir'], 'desktop'):
            return 403, {'error': 'desktop plugin disabled or dependency unavailable: desktop', 'plugin': 'desktop'}
        return 200, {'enabled': True}

    if parts == ['api', 'desktop', 'permissions']:
        if method != 'GET':
            return 405, {'error': 'method not allowed'}
        if not plugin_runtime.is_enabled(ctx['state_dir'], 'desktop'):
            return 403, {'error': 'desktop plugin disabled or dependency unavailable: desktop', 'plugin': 'desktop'}
        return _native_snapshot(ctx, 'status')

    if parts == ['api', 'desktop', 'permissions', 'request']:
        if method != 'POST':
            return 405, {'error': 'method not allowed'}
        if not isinstance(data, dict) or set(data) != {'permission'} or data.get('permission') not in PERMISSIONS:
            return 400, {'error': 'expected permission id only'}
        if not plugin_runtime.is_enabled(ctx['state_dir'], 'desktop'):
            return 403, {'error': 'desktop plugin disabled or dependency unavailable: desktop', 'plugin': 'desktop'}
        return _native_snapshot(ctx, 'request', data['permission'])
    return None
