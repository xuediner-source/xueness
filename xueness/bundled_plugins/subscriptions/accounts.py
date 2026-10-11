"""Plugin-owned, credential-safe account and quota HTTP surface."""
from __future__ import annotations
import threading
from . import broker, state

_LOCK = threading.RLock()


def _text(value, *, limit=256, empty=False):
    if not isinstance(value, str) or len(value) > limit or any(ord(ch) < 32 for ch in value):
        raise ValueError('invalid account field')
    value = value.strip()
    if not value and not empty:
        raise ValueError('account field is required')
    return value


def connect(state_dir, item, data):
    state.require_available(state_dir)
    if not item or item['id'] != 'qoder':
        raise ValueError('use account authorization or import a CLI login for this provider')
    if set(data) - {'accessToken', 'userId'}:
        raise ValueError('unsupported account field')
    with _LOCK:
        connections = state.read(state_dir, 'connections.json')
        previous = connections.get(item['id'], {})
        if not isinstance(previous, dict):
            previous = {}
        token = _text(data.get('accessToken', ''), limit=65536, empty=True) or previous.get('accessToken')
        record = {**previous, 'accessToken': _text(token, limit=65536),
                  'userId': _text(data.get('userId') or previous.get('userId'))}
        connections[item['id']] = record
        state.write(state_dir, 'connections.json', connections)
        quotas = state.read(state_dir, 'quota.json')
        quotas.pop(item['id'], None)
        state.write(state_dir, 'quota.json', quotas)


def dispatch(method, parts, query, data, ctx):
    if parts[:2] != ['api', 'subscriptions']:
        return None
    try:
        state_dir = ctx['state_dir']
        state.require_available(state_dir)
        if len(parts) == 2 and method == 'GET':
            return 200, {'accounts': state.public_accounts(state_dir), 'workerRunning': broker.running(state_dir)}
        if len(parts) != 4:
            return 404, {'error': 'subscription operation not found'}
        pid, action = parts[2:]
        item = state.definition(pid)
        if item is None:
            return 404, {'error': 'subscription provider not found'}
        if method == 'GET' and action == 'status':
            status = broker.call(state_dir, 'status', pid, start=False)
            return 200, {'status': status, 'account': next(row for row in state.public_accounts(state_dir) if row['id'] == pid)}
        if method != 'POST' or action not in ('connect', 'login', 'import', 'manual', 'cancel', 'models', 'quota', 'disconnect', 'set-models'):
            return 405, {'error': 'method not allowed'}
        if not isinstance(data, dict):
            raise ValueError('expected a JSON object')
        if action == 'connect':
            connect(state_dir, item, data)
            result = {'saved': True}
        elif action == 'set-models':
            if set(data) != {'models'} or not isinstance(data['models'], list) or not 0 < len(data['models']) <= 200:
                raise ValueError('enter at least one model ID')
            models = list(dict.fromkeys(_text(mid) for mid in data['models']))
            with _LOCK:
                catalogs = state.read(state_dir, 'public-models.json')
                catalogs[pid] = {'models': [{'id': mid, 'name': mid, 'source': 'manual'} for mid in models]}
                state.write(state_dir, 'public-models.json', catalogs)
            result = {'saved': True}
        else:
            if action == 'manual':
                if set(data) != {'callback'}:
                    raise ValueError('expected authorization callback')
                _text(data['callback'], limit=16384)
            elif data:
                raise ValueError('unexpected operation fields')
            # Serialize the files shared with the worker's explicit account
            # actions. Background token refresh writes only its own auth store.
            with _LOCK:
                result = broker.call(state_dir, action, pid, data)
        state.require_available(state_dir)
        return 200, {'result': result, 'accounts': state.public_accounts(state_dir)}
    except (ValueError, RuntimeError, OSError) as exc:
        # These errors are authored locally or redacted by the worker.
        return 400, {'error': str(exc)[:700]}
