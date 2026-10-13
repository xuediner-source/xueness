"""Operator-pinned publisher keys and detached Ed25519 package signatures."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import re

from ... import plugin_runtime
from ...resources import _atomic_write_json, _is_link

_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}')
_SHA = re.compile(r'[0-9a-f]{64}')
DOMAIN = b'Xueness external package v1\0'


def _path(state):
    from .package_store import _check_path
    path = Path(state) / 'external-package-trust.json'
    if _is_link(path.parent) or _is_link(path):
        raise ValueError('package trust path must not be a link')
    return _check_path(path)


def _keys(state):
    path = _path(state)
    from .package_store import _read_file
    try:
        raw = _read_file(path, 32_000)
    except FileNotFoundError:
        return {}
    if len(raw) > 32_000:
        raise ValueError('package trust store exceeds limit')
    value = json.loads(raw)
    if not isinstance(value, dict) or len(value) > 64:
        raise ValueError('invalid package trust store')
    for key_id, row in value.items():
        if not isinstance(key_id, str) or not _ID.fullmatch(key_id) or not isinstance(row, dict):
            raise ValueError('invalid package publisher key')
        public = _decode(row.get('publicKey'), 32)
        if row.get('fingerprint') != hashlib.sha256(public).hexdigest():
            raise ValueError('package publisher fingerprint mismatch')
    return value


def _decode(value, size):
    if not isinstance(value, str) or len(value) > 128:
        raise ValueError('invalid package signing material')
    try:
        raw = base64.b64decode(value, validate=True)
    except ValueError:
        raise ValueError('invalid package signing material') from None
    if len(raw) != size:
        raise ValueError('invalid package signing material length')
    return raw


def list_keys(state):
    plugin_runtime.require_enabled(state, 'extensions')
    return [{'id': kid, **row} for kid, row in sorted(_keys(state).items())]


def add_key(state, key_id, public_key, expected_fingerprint):
    plugin_runtime.require_enabled(state, 'extensions')
    if not isinstance(key_id, str) or not _ID.fullmatch(key_id):
        raise ValueError('invalid publisher key id')
    fingerprint = hashlib.sha256(_decode(public_key, 32)).hexdigest()
    if expected_fingerprint != fingerprint:
        raise ValueError('publisher key fingerprint changed; review the key again')
    with plugin_runtime._config_lock(state):
        keys = _keys(state)
        if key_id in keys and keys[key_id]['fingerprint'] != fingerprint:
            raise ValueError('revoke the previous publisher key before replacing it')
        if key_id not in keys and len(keys) >= 64:
            raise ValueError('publisher key limit exceeded')
        keys[key_id] = {'publicKey': public_key, 'fingerprint': fingerprint}
        _atomic_write_json(_path(state), keys)
    return {'id': key_id, 'fingerprint': fingerprint}


def revoke_key(state, key_id):
    plugin_runtime.require_enabled(state, 'extensions')
    with plugin_runtime._config_lock(state):
        keys = _keys(state)
        removed = keys.pop(key_id, None) is not None
        _atomic_write_json(_path(state), keys)
    # Requests recheck trust; also release live transports immediately.
    from ..mcp.package_binding import close_managed
    close_managed(state, key_id=key_id)
    return {'id': key_id, 'removed': removed}


def verify(state, archive_sha256, signature):
    plugin_runtime.require_enabled(state, 'extensions')
    if not isinstance(archive_sha256, str) or not _SHA.fullmatch(archive_sha256):
        raise ValueError('invalid archive sha256')
    if not isinstance(signature, dict) or set(signature) != {'keyId', 'signature'}:
        raise ValueError('invalid detached package signature')
    if not isinstance(signature['keyId'], str) or not _ID.fullmatch(signature['keyId']):
        raise ValueError('invalid package signer id')
    row = _keys(state).get(signature['keyId'])
    if row is None:
        raise ValueError('package signer is not trusted')
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.exceptions import InvalidSignature
    except ImportError:
        raise ValueError('Ed25519 verification requires cryptography; signed package refused') from None
    try:
        Ed25519PublicKey.from_public_bytes(_decode(row['publicKey'], 32)).verify(
            _decode(signature['signature'], 64), DOMAIN + archive_sha256.encode('ascii'))
    except InvalidSignature:
        raise ValueError('package signature verification failed') from None
    return {'kind': 'ed25519', **signature, 'fingerprint': row['fingerprint']}


def verify_receipt(state, receipt, archive_sha256):
    provenance = receipt.get('provenance') or {'kind': 'sha256-pin'}
    if provenance.get('kind') == 'ed25519':
        verified = verify(state, archive_sha256,
                          {key: provenance.get(key) for key in ('keyId', 'signature')})
        if verified['fingerprint'] != provenance.get('fingerprint'):
            raise ValueError('package signing identity changed')
    elif provenance.get('kind') != 'sha256-pin':
        raise ValueError('unsupported package provenance')
