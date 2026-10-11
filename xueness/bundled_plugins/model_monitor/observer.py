"""Response metadata observer. Never sends a request or stores conversation text."""
from __future__ import annotations
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path
import stat
import threading
import uuid
from ...resources import _atomic_write_json, _is_link, _protect_private_directory
from ..providers.proxy import ProviderProxy

_LOCK = threading.RLock()
MAX_RECORDS = 200
MAX_BYTES = 400_000


def require_available(state_dir):
    from ...plugin_runtime import require_enabled
    require_enabled(state_dir, 'model_monitor')


def _path(state_dir, *, create=False):
    root = Path(state_dir).absolute()
    target = root / 'model-monitor'
    for part in (root, target, target / 'observations.json'):
        if _is_link(part):
            raise ValueError('model monitor path must not be a link')
    if create:
        target.mkdir(parents=True, mode=0o700, exist_ok=True)
        _protect_private_directory(target)
    return target / 'observations.json'


def read(state_dir, session_id=None):
    path = _path(state_dir)
    try:
        original = path.lstat()
        if not stat.S_ISREG(original.st_mode):
            raise ValueError('invalid monitoring document')
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    except FileNotFoundError:
        return []
    with os.fdopen(fd, 'rb') as stream:
        current = os.fstat(stream.fileno())
        if not stat.S_ISREG(current.st_mode) or (original.st_dev, original.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError('monitoring document changed during read')
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('monitoring document too large')
    value = json.loads(raw)
    if not isinstance(value, list):
        raise ValueError('invalid monitoring document')
    rows = [_clean(row) for row in value[-MAX_RECORDS:] if isinstance(row, dict)]
    return rows if session_id is None else [row for row in rows if row.get('sessionId') == session_id]


def _model(value):
    return value if isinstance(value, str) and 0 < len(value) <= 256 and all(ord(ch) >= 32 for ch in value) else None


def _clean(row):
    models = row.get('returnedModels', [])
    if not isinstance(models, list):
        models = []
    session_id = row.get('sessionId')
    return {**({'sessionId': session_id} if isinstance(session_id, str) and re.fullmatch(r'[0-9a-f]{32}', session_id) else {}),
            'id': str(row.get('id', ''))[:64], 'at': str(row.get('at', ''))[:40],
            'providerId': str(row.get('providerId', ''))[:64], 'requestedModel': _model(row.get('requestedModel')) or '',
            'returnedModels': list(dict.fromkeys(model for model in map(_model, models[:8]) if model)),
            'protocol': str(row.get('protocol', ''))[:32], 'outcome': row.get('outcome') if row.get('outcome') in ('success', 'error') else 'success'}


def record(state_dir, provider_id, provider, response=None, *, outcome='success', session_id=None):
    from ...plugin_runtime import is_enabled
    if not is_enabled(state_dir, 'model_monitor'):
        return
    models = response.get('_response_models', []) if isinstance(response, dict) else []
    if not isinstance(models, list):
        models = []
    key = getattr(provider, 'key', None)
    models = [model for model in models if model != key]
    row = _clean({'id': uuid.uuid4().hex, 'at': datetime.now(timezone.utc).isoformat(),
                  'providerId': provider_id or '', 'sessionId': session_id, 'requestedModel': getattr(provider, 'model', ''),
                  'returnedModels': models, 'protocol': getattr(provider, 'protocol', 'anthropic' if provider.__class__.__name__ == 'AnthropicMessages' else 'openai'),
                  'outcome': outcome})
    try:
        with _LOCK:
            require_available(state_dir)
            rows = read(state_dir)
            rows.append(row)
            _atomic_write_json(_path(state_dir, create=True), rows[-MAX_RECORDS:])
    except (OSError, ValueError):
        # A monitoring failure must not replay or discard an actual model reply.
        return


def clear(state_dir):
    with _LOCK:
        require_available(state_dir)
        _atomic_write_json(_path(state_dir, create=True), [])


class ObservedProvider(ProviderProxy):
    _proxy_fields = ProviderProxy._proxy_fields | {'session_id'}

    def __init__(self, state_dir, provider_id, provider, session_id=None):
        self.state_dir, self.provider_id, self.provider = state_dir, provider_id, provider
        self.session_id = session_id

    def _call(self, method, *args, **kwargs):
        try:
            reply = getattr(self.provider, method)(*args, **kwargs)
        except Exception:
            record(self.state_dir, self.provider_id, self.provider, outcome='error', session_id=self.session_id)
            raise
        record(self.state_dir, self.provider_id, self.provider, reply, session_id=self.session_id)
        return reply

    def complete(self, messages, tools):
        return self._call('complete', messages, tools)

    def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
        return self._call('stream', messages, tools, on_delta=on_delta, on_reasoning_delta=on_reasoning_delta)


def wrap(state_dir, provider_id, provider, session_id=None):
    from ...plugin_runtime import is_enabled
    return ObservedProvider(state_dir, provider_id, provider, session_id) if is_enabled(state_dir, 'model_monitor') else provider
