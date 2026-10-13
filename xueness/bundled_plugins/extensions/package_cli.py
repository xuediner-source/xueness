"""Review, install and activate external source packages through explicit calls."""
from __future__ import annotations

import json
from pathlib import Path

from ... import plugin_runtime
from ..mcp.package_binding import close_package
from . import package_store as store, package_trust as trust


def _summary(result):
    keys = ('id', 'version', 'archiveSha256', 'manifest', 'active', 'history',
            'enabled', 'grants', 'valid', 'uninstalled')
    value = {key: result[key] for key in keys if key in result}
    if 'files' in result:
        value['files'] = result['files']
    if 'receipt' in result:
        value['provenance'] = result['receipt']['provenance']
    return value


def _signature(path):
    return json.loads(store._read_file(Path(path), 4096)) if path else None


def _source(state, source, sha, signature):
    if isinstance(source, str) and source.startswith('https://'):
        if sha is None or signature is None:
            raise ValueError('HTTPS packages require an exact SHA-256 and trusted detached signature')
        # Reject an untrusted release before opening a network connection.
        provenance = trust.verify(state, sha, signature)
        from .package_download import download
        contents = download(state, source)
    else:
        if isinstance(source, str) and '://' in source:
            raise ValueError('package downloads require public HTTPS')
        contents = store._archive_bytes(Path(source))
        provenance = None
    reviewed = store.review_archive(contents, expected_sha256=sha)
    if signature is not None:
        provenance = trust.verify(state, reviewed['archiveSha256'], signature)
    return contents, reviewed, provenance or {'kind': 'sha256-pin'}


def manage(state, action, *, source=None, package_id=None, sha256=None,
           grants=(), signature=None):
    plugin_runtime.require_enabled(state, 'extensions')
    if action == 'list':
        return {'packages': store.list_packages(state)}
    if action in ('review', 'install', 'upgrade'):
        if action != 'review' and sha256 is None:
            raise ValueError('install and upgrade require the reviewed archive SHA-256')
        contents, reviewed, provenance = _source(state, source, sha256, signature)
        if action == 'review':
            return {**reviewed, 'provenance': provenance, 'enabled': False}
        pid = reviewed['manifest']['id']
        close_package(state, pid)
        function = store.install if action == 'install' else store.upgrade
        result = function(state, contents, expected_sha256=reviewed['archiveSha256'],
                          source_label=str(source), provenance=provenance)
        return _summary(result)
    if action == 'show':
        return _summary(store.review(state, package_id, archive_sha256=sha256))
    if action in ('enable', 'disable'):
        if sha256 is None:
            raise ValueError('activation changes require the reviewed archive SHA-256')
        if action == 'enable':
            plugin_runtime.require_enabled(state, 'mcp')
            resolved = store.resolved_package(state, package_id)
            trust.verify_receipt(state, resolved['receipt'], resolved['archiveSha256'])
        close_package(state, package_id)
        return _summary(store.set_enabled(state, package_id, action == 'enable',
                                         expected_sha256=sha256, grants=grants))
    if action == 'rollback':
        if sha256 is None:
            raise ValueError('rollback requires an exact reviewed history SHA-256')
        target = store.review(state, package_id, archive_sha256=sha256)
        trust.verify_receipt(state, target['receipt'], target['archiveSha256'])
        close_package(state, package_id)
        return _summary(store.rollback(state, package_id, archive_sha256=sha256))
    if action == 'uninstall':
        close_package(state, package_id)
        return _summary(store.uninstall(state, package_id))
    raise ValueError('unsupported external package action')


def add_parser(commands):
    command = commands.add_parser('extension-package', help='review and manage external MCP/ACP source ZIPs')
    actions = command.add_subparsers(dest='package_action', required=True)
    for action in ('review', 'install', 'upgrade'):
        parser = actions.add_parser(action)
        parser.add_argument('source')
        parser.add_argument('--sha256', required=action != 'review')
        parser.add_argument('--signature', type=Path)
    actions.add_parser('list')
    for action in ('show', 'enable', 'disable', 'rollback', 'uninstall'):
        parser = actions.add_parser(action)
        parser.add_argument('id')
        parser.add_argument('--sha256', required=action in ('enable', 'disable', 'rollback'))
        if action == 'enable':
            parser.add_argument('--grant', action='append', default=[])
    actions.add_parser('keys')
    key = actions.add_parser('trust-key')
    key.add_argument('id')
    key.add_argument('--public-key', required=True)
    key.add_argument('--fingerprint', required=True)
    revoke = actions.add_parser('revoke-key')
    revoke.add_argument('id')


def execute(args):
    action = args.package_action
    if action == 'keys':
        return {'keys': trust.list_keys(args.state)}
    if action == 'trust-key':
        return trust.add_key(args.state, args.id, args.public_key, args.fingerprint)
    if action == 'revoke-key':
        return trust.revoke_key(args.state, args.id)
    return manage(args.state, action,
                  source=getattr(args, 'source', None), package_id=getattr(args, 'id', None),
                  sha256=getattr(args, 'sha256', None), grants=getattr(args, 'grant', ()),
                  signature=_signature(getattr(args, 'signature', None)))


def dispatch(method, parts, query, data, ctx):
    if parts[:3] != ['api', 'plugins', 'packages']:
        return None
    state = ctx['state_dir']
    try:
        if method == 'GET' and len(parts) == 3:
            return 200, manage(state, 'list')
        if method == 'GET' and len(parts) == 4:
            return 200, manage(state, 'show', package_id=parts[3], sha256=query.get('sha256'))
        if method != 'POST' or not isinstance(data, dict):
            return 405, {'error': 'method not allowed'}
        if len(parts) == 4 and parts[3] in ('review', 'install', 'upgrade'):
            if set(data) != {'url', 'sha256', 'signature'} or not isinstance(data.get('url'), str) or not data['url'].startswith('https://'):
                raise ValueError('HTTP package imports require a signed public HTTPS URL')
            return 200, manage(state, parts[3], source=data['url'], sha256=data['sha256'], signature=data['signature'])
        if len(parts) == 5 and parts[4] in ('enable', 'disable', 'rollback', 'uninstall'):
            action = parts[4]
            fields = {'sha256', 'grants'} if action == 'enable' else set() if action == 'uninstall' else {'sha256'}
            if set(data) != fields:
                raise ValueError('unexpected package action fields')
            return 200, manage(state, action, package_id=parts[3], sha256=data.get('sha256'), grants=data.get('grants', ()))
        return 405, {'error': 'method not allowed'}
    except (OSError, ValueError, KeyError, TypeError):
        return 400, {'error': 'external package review or operation refused'}
