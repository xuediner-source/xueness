"""Private, local account state. Reading it never contacts a provider."""
from __future__ import annotations
import hashlib
import json
import os
import stat
import math
from pathlib import Path
from ...resources import _atomic_write_json, _is_link, _protect_private_directory

PACKAGE = Path(__file__).parent
PACKAGE_ID = 'xueness-subscriptions'
MARKET_MANIFEST = {'id': PACKAGE_ID, 'version': '1.0.0', 'apiVersion': 1,
                   'builtin': 'subscriptions', 'capabilities': [], 'enabled': False}
PREFIX = 'subscription.'
MAX_BYTES = 2_000_000


def installed(state_dir):
    from ...plugin_sdk import load_manifests
    return any(item['id'] == PACKAGE_ID and item['builtin'] == 'subscriptions'
               for item in load_manifests(state_dir))


def require_available(state_dir):
    from ...plugin_runtime import require_enabled
    require_enabled(state_dir, 'subscriptions')
    if not installed(state_dir):
        raise ValueError('Install Subscriptions Hub from the marketplace first')


def directory(state_dir, *, create=False):
    root = Path(state_dir).absolute()
    for path in (root, root / 'subscriptions'):
        if _is_link(path):
            raise ValueError('subscription store must not be a link')
    target = root / 'subscriptions'
    if create:
        target.mkdir(parents=True, mode=0o700, exist_ok=True)
        _protect_private_directory(target)
    return target


def read(state_dir, name):
    if name not in ('auth.json', 'connections.json', 'public-models.json', 'quota.json'):
        raise ValueError('unknown subscription document')
    path = directory(state_dir) / name
    if _is_link(path):
        raise ValueError('subscription document must not be a link')
    try:
        original = path.lstat()
        if not stat.S_ISREG(original.st_mode):
            raise ValueError('subscription document must be a regular file')
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    except FileNotFoundError:
        return {}
    with os.fdopen(fd, 'rb') as stream:
        current = os.fstat(stream.fileno())
        if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
            raise ValueError('subscription document changed during read')
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('subscription document too large')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('invalid subscription document')
    return value


def write(state_dir, name, value):
    if name not in ('auth.json', 'connections.json', 'public-models.json', 'quota.json'):
        raise ValueError('unknown subscription document')
    path = directory(state_dir, create=True) / name
    if _is_link(path):
        raise ValueError('subscription document must not be a link')
    _atomic_write_json(path, value)


def definitions():
    return json.loads((PACKAGE / 'catalog.json').read_text(encoding='utf-8'))['providers']


def definition(pid):
    return next((item for item in definitions() if item['id'] == pid), None)


def public_accounts(state_dir):
    import time
    auth, connections = read(state_dir, 'auth.json'), read(state_dir, 'connections.json')
    catalogs, quotas = read(state_dir, 'public-models.json'), read(state_dir, 'quota.json')
    result = []
    for item in definitions():
        pid = item['id']
        record = auth.get(pid) if item['mode'] == 'oauth' else connections.get(pid)
        record = record if isinstance(record, dict) else {}
        expiry = record.get('expiresAt')
        expired = isinstance(expiry, (float, int)) and expiry <= time.time() * 1000
        if pid == 'commandcode':
            saved = bool(record.get('apiKey') and record.get('credentialSource') == 'cli-login')
        elif pid == 'qoder':
            saved = bool(record.get('accessToken') and record.get('userId'))
        else:
            saved = bool(record.get('accessToken'))
        connected = saved and (not expired or bool(record.get('refreshToken')))
        catalog = catalogs.get(pid, {})
        models = catalog.get('models', []) if isinstance(catalog, dict) else []
        if not isinstance(models, list):
            models = []
        if not models:
            models = [{'id': mid, 'name': mid, 'source': 'manual' if record.get('modelSource') == 'manual' else 'preset'} for mid in record.get('models', item.get('models', []))]
        clean_models = []
        seen = set()
        for model in models[:200]:
            if not isinstance(model, dict) or not isinstance(model.get('id'), str):
                continue
            mid = model['id']
            if not mid or len(mid) > 256 or mid in seen or any(ord(ch) < 32 for ch in mid):
                continue
            seen.add(mid)
            clean_models.append({'id': mid, 'name': str(model.get('name') or mid)[:160],
                                 'providerId': model_id(pid, mid),
                                 'source': model.get('source') if model.get('source') in ('preset', 'manual', 'upstream') else 'preset',
                                 'capabilities': [cap for cap in model.get('capabilities', []) if cap in ('image', 'pdf', 'video')],
                                 'reasoningLevels': [effort for effort in model.get('reasoningLevels', []) if effort in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')],
                                 **({'contextWindow': model['contextWindow']} if type(model.get('contextWindow')) is int and 2048 <= model['contextWindow'] <= 2_000_000 else {})})
        models = clean_models
        quota = public_quota(quotas.get(pid))
        result.append({**item, 'connected': connected, 'credentialsSaved': saved, 'expired': expired,
                       'account': str(record.get('emailAddress') or record.get('email') or record.get('account') or record.get('name') or '')[:160],
                       'expiresAt': expiry, 'models': models, 'quota': quota,
                       'baseUrl': record.get('baseUrl', item.get('baseUrl', '')),
                       'hasUserId': bool(record.get('userId'))})
    return result


def provider_records(state_dir):
    from ...plugin_runtime import is_enabled
    if not is_enabled(state_dir, 'subscriptions') or not installed(state_dir):
        return []
    records = []
    for account in public_accounts(state_dir):
        if not account['connected']:
            continue
        for model in account['models']:
            mid = model['id']
            identity = model_id(account['id'], mid)
            records.append({'id': identity, 'name': account['name'] + ' · ' + model.get('name', mid),
                            'model': mid, 'baseUrl': account.get('baseUrl') or 'https://subscriptions.xueness.invalid',
                            'source': 'subscription', 'subscriptionId': account['id'], 'hasKey': True,
                            'protocol': account.get('protocol', 'openai'), 'capabilities': model.get('capabilities', []),
                            'reasoningLevels': model.get('reasoningLevels', []), 'runtimeProfile': 'standard',
                            **({'contextWindow': model['contextWindow']} if model.get('contextWindow') else {})})
    return records


def provider_record(state_dir, pid):
    if not isinstance(pid, str) or not pid.startswith(PREFIX):
        return None
    return next((record for record in provider_records(state_dir) if record['id'] == pid), None)


def model_id(account_id, model):
    # Model discovery ordering cannot change a session's selected model.
    return PREFIX + account_id + '.' + hashlib.sha256(model.encode()).hexdigest()[:16]


def public_quota(value):
    if not isinstance(value, dict):
        return None
    finite = lambda x: type(x) in (int, float) and math.isfinite(x) and x >= 0
    result = {'supported': value.get('supported') is True, 'windows': [],
              'checkedAt': value.get('checkedAt') if finite(value.get('checkedAt')) else 0}
    if isinstance(value.get('plan'), str):
        result['plan'] = value['plan'][:120]
    windows = value.get('windows', [])
    for window in windows[:40] if isinstance(windows, list) else ():
        if not isinstance(window, dict):
            continue
        clean = {'kind': window.get('kind') if window.get('kind') in ('session', 'weekly', 'daily', 'monthly', 'lifetime', 'other') else 'other'}
        clean.update({key: window[key] for key in ('usedPercent', 'usedUsd', 'remaining', 'limit', 'resetsAt', 'windowDurationMins') if finite(window.get(key))})
        clean.update({key: window[key][:120] for key in ('scope', 'unit') if isinstance(window.get(key), str)})
        if len(clean) > 1:
            result['windows'].append(clean)
    result['supported'] = result['supported'] and bool(result['windows'])
    return result
