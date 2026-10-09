"""One-time desktop host tickets and a platform/capability probe.

Feature ``desktop.host_capability``. Settings key
``general.desktopHostCapabilityEnabled`` must be boolean true. While it is
off the routes answer 400 and do not issue or consume tickets. Desktop
status, the long-lived desktop token, Host/Origin and CSRF stay as they are.
Consuming a ticket does not authorize any other route.

Ticket rules follow ZCode v3.14.3 ``packages/server/src/hostCapability.ts``
(Apache-2.0, idea only, not copied code): 32 random bytes, 30 second TTL,
memory of this process only, and delete-before-check so a replay, an expiry
and a success all invalidate the value. Platform names come from
``process_runtime.host_platform_family``. Path case folding comes from
``write_lock.host_paths_ignore_case``.
"""
from __future__ import annotations

import re
import secrets
import threading
import time
from pathlib import Path

FEATURE_ID = 'desktop.host_capability'
SETTINGS_SECTION = 'general'
SETTINGS_KEY = 'desktopHostCapabilityEnabled'
SCHEMA = 'xueness.host-capability.v1'
NOT_ENABLED_ERROR = FEATURE_ID + ' not enabled'
HEADER = 'X-Xueness-Host-Capability'
DEFAULT_TTL_MS = 30_000
MAX_LIVE = 128
_PROBE = ('api', 'desktop', 'host-capability')
_CONSUME = ('api', 'desktop', 'host-capability', 'consume')
_TOKEN = re.compile(r'[A-Za-z0-9_-]{16,128}')
_STORES = {}
_GUARD = threading.Lock()


def _now_ms():
    return time.time_ns() // 1_000_000


def _new_capability():
    return secrets.token_urlsafe(32)


def _acceptable(value):
    return isinstance(value, str) and _TOKEN.fullmatch(value) is not None


def _same(left, right):
    if not isinstance(left, str) or not isinstance(right, str) or len(left) != len(right):
        return False
    return secrets.compare_digest(left, right)


class HostCapabilityStore:
    """In-process tickets. ``create_capability`` must not call back in."""

    def __init__(self, *, ttl_ms=DEFAULT_TTL_MS, now=None, create_capability=None,
                 server_id=None, max_live=MAX_LIVE):
        if type(ttl_ms) is not int or not 1 <= ttl_ms <= 300_000:
            raise ValueError('ttl must be an int from 1 to 300000 ms')
        if type(max_live) is not int or not 1 <= max_live <= 1024:
            raise ValueError('max_live must be an int from 1 to 1024')
        if now is not None and not callable(now):
            raise ValueError('now must be callable')
        if create_capability is not None and not callable(create_capability):
            raise ValueError('create_capability must be callable')
        if server_id is None:
            server_id = secrets.token_hex(16)
        elif (not isinstance(server_id, str) or len(server_id) != 32
              or any(c not in '0123456789abcdef' for c in server_id)):
            raise ValueError('server_id must be 32 lowercase hex characters')
        self._ttl_ms = ttl_ms
        self._max_live = max_live
        self._now = now or _now_ms
        self._create = create_capability or _new_capability
        self.server_id = server_id
        self._items = {}
        self._lock = threading.Lock()

    def _clock(self):
        value = self._now()
        if type(value) is not int:
            raise RuntimeError('host capability clock must return int milliseconds')
        return value

    def _purge(self, at):
        expired = [key for key, expires_at in self._items.items() if expires_at <= at]
        for key in expired:
            self._items.pop(key, None)

    def issue(self):
        """Return ``{capability, expiresAt}``, or None when the map is full.

        An existing unexpired token from a colliding generator is refreshed
        in its one slot. A brand-new token is refused once ``max_live`` live
        tickets remain after the purge. The refused token is not stored.
        """
        with self._lock:
            now = self._clock()
            self._purge(now)
            token = self._create()
            if not _acceptable(token):
                raise ValueError('host capability generator returned an unusable token')
            if token not in self._items and len(self._items) >= self._max_live:
                return None
            expires_at = now + self._ttl_ms
            self._items[token] = expires_at
            return {'capability': token, 'expiresAt': expires_at}

    def consume(self, capability):
        """True only for the first in-TTL use. Delete before deciding.

        A missing, expired, replayed or malformed value is False. Expired and
        replayed values are already gone, so a later attempt cannot succeed.
        """
        if not _acceptable(capability):
            return False
        with self._lock:
            now = self._clock()
            expires_at = self._items.pop(capability, None)
            self._purge(now)
            return expires_at is not None and expires_at > now

    def live_count(self):
        with self._lock:
            return len(self._items)


def _store_key(ctx):
    if not isinstance(ctx, dict):
        return None
    state_dir = ctx.get('state_dir')
    if state_dir is None:
        return None
    try:
        return str(Path(state_dir).expanduser().resolve())
    except (OSError, RuntimeError, TypeError, ValueError):
        return None


def store_for(ctx):
    key = _store_key(ctx)
    if key is None:
        raise ValueError('host capability store requires a state directory')
    with _GUARD:
        store = _STORES.get(key)
        if store is None:
            store = HostCapabilityStore()
            _STORES[key] = store
        return store


def bind_store(ctx, store):
    """Replace the store for this state directory. Tests inject a clock here."""
    key = _store_key(ctx)
    if key is None:
        raise ValueError('host capability store requires a state directory')
    if not isinstance(store, HostCapabilityStore):
        raise TypeError('store must be a HostCapabilityStore')
    with _GUARD:
        _STORES[key] = store
    return store


def peek_store(ctx):
    key = _store_key(ctx)
    if key is None:
        return None
    with _GUARD:
        return _STORES.get(key)


def forget_store(ctx):
    key = _store_key(ctx)
    if key is None:
        return
    with _GUARD:
        _STORES.pop(key, None)


def enabled(ctx) -> bool:
    """Persistent flag for the state directory bound to ``ctx``. Only real True."""
    from ..settings.settings_store import load_settings
    try:
        state_dir = ctx['state_dir']
    except (KeyError, TypeError):
        return False
    try:
        section = load_settings(state_dir).get(SETTINGS_SECTION, {})
    except (OSError, ValueError, TypeError):
        return False
    return isinstance(section, dict) and section.get(SETTINGS_KEY) is True


def _public_raw(value):
    if (isinstance(value, str) and 1 <= len(value) <= 32 and value.isascii()
            and value.isprintable() and ' ' not in value):
        return value
    return 'unknown'


def snapshot(ctx):
    """Probe body. The caller has already checked the flag.

    ``platform.raw`` matches ``/api/desktop/status`` ``platform``. ``family``
    is the shared helper. A client query string cannot choose either one.
    """
    from ...process_runtime import host_platform_family
    from ...write_lock import host_paths_ignore_case
    from ..settings.workspaces_api import native_picker_capability
    from .host import desktop_status
    status = desktop_status(ctx)
    raw = _public_raw(status.get('platform'))
    family = host_platform_family(raw)
    bridge = ctx.get('desktop_permissions_bridge') if isinstance(ctx, dict) else None
    picker = native_picker_capability(family)
    return {
        'schema': SCHEMA,
        'feature': FEATURE_ID,
        'serverId': store_for(ctx).server_id,
        'version': status.get('version'),
        'platform': {'raw': raw, 'family': family},
        'capabilities': {
            'desktopHost': status.get('desktop') is True,
            'nativeDirectoryPicker': status.get('nativeDirectoryPicker') is True,
            'nativeWorkspacePicker': {
                'available': picker.get('available') is True,
                'platform': picker.get('platform'),
            },
            'nativePermissionBridge': bool(ctx.get('desktop_token')) and bridge is not None,
            'frozen': status.get('frozen') is True,
            'hostOriginCsrf': True,
            # These channels are not implemented. Declare them false so a
            # client does not subscribe to events this process will not send.
            'desktopContinuous': False,
            'websocketRpc': False,
            'processResourceTelemetry': False,
            'hostCapabilityTicket': True,
            'caseInsensitivePaths': host_paths_ignore_case(),
        },
    }


def _not_enabled():
    return 400, {'error': NOT_ENABLED_ERROR, 'feature': FEATURE_ID}


def _header_value(ctx):
    """None when the header is absent. A present value is returned raw."""
    if not isinstance(ctx, dict):
        return None
    handler = ctx.get('handler')
    headers = getattr(handler, 'headers', None)
    if headers is None:
        return None
    try:
        return headers.get(HEADER)
    except (AttributeError, TypeError):
        return None


def _issue(ctx, data):
    if not enabled(ctx):
        return _not_enabled()
    if not isinstance(data, dict) or data:
        return 400, {'error': 'expected empty body', 'feature': FEATURE_ID}
    try:
        store = store_for(ctx)
        issued = store.issue()
    except (OSError, RuntimeError, TypeError, ValueError):
        return 500, {'error': 'host capability unavailable', 'feature': FEATURE_ID}
    if not enabled(ctx):
        if issued is not None:
            store.consume(issued.get('capability'))
        return _not_enabled()
    if issued is None:
        return 429, {'error': 'host capability store full', 'feature': FEATURE_ID}
    return 200, {
        'schema': SCHEMA,
        'feature': FEATURE_ID,
        'capability': issued['capability'],
        'expiresAt': issued['expiresAt'],
        'grantsAccess': False,
    }


def _consume(ctx, data):
    if not enabled(ctx):
        return _not_enabled()
    header = _header_value(ctx)
    if not isinstance(data, dict):
        return 400, {'error': 'expected capability', 'feature': FEATURE_ID}
    has_body = bool(data)
    if header is None and not has_body:
        return 400, {'error': 'expected capability', 'feature': FEATURE_ID}
    body_token = None
    if has_body:
        if set(data) != {'capability'}:
            return 400, {'error': 'expected capability only', 'feature': FEATURE_ID}
        body_token = data.get('capability')
    if header is not None and not _acceptable(header):
        return 400, {'error': 'invalid host capability', 'feature': FEATURE_ID}
    if body_token is not None and not _acceptable(body_token):
        return 400, {'error': 'invalid host capability', 'feature': FEATURE_ID}
    if header is not None and body_token is not None and not _same(header, body_token):
        return 400, {'error': 'host capability mismatch', 'feature': FEATURE_ID}
    token = header if header is not None else body_token
    store = peek_store(ctx)
    if store is None or not store.consume(token):
        return 401, {'error': 'invalid or expired host capability'}
    return 200, {
        'schema': SCHEMA,
        'feature': FEATURE_ID,
        'accepted': True,
        'grantsAccess': False,
    }


def dispatch(method, parts, query, data, ctx):
    """Probe, issue, or consume. Unknown paths return None."""
    del query
    try:
        path = tuple(parts)
    except TypeError:
        return None
    if path not in (_PROBE, _CONSUME):
        return None
    verb = (method or '').upper()
    if path == _PROBE and verb == 'GET':
        if not enabled(ctx):
            return _not_enabled()
        try:
            return 200, snapshot(ctx)
        except (OSError, RuntimeError, TypeError, ValueError, KeyError):
            return 500, {'error': 'host capability unavailable', 'feature': FEATURE_ID}
    if path == _PROBE and verb == 'POST':
        return _issue(ctx, data)
    if path == _CONSUME and verb == 'POST':
        return _consume(ctx, data)
    if verb in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'):
        return 405, {'error': 'method not allowed'}
    return None
