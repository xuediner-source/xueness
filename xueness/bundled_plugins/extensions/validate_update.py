"""Read-only manifest checks and atomic marketplace upgrades.

A data manifest is *data*: this module parses JSON, compares it against the
shared SDK manifest contract and reports the verdict. Nothing here imports,
executes or evaluates a document, and ``validate`` writes no file at all — not
even in the state directory. ``update`` only ever reaches the marketplace source
the extensions plugin already trusts, re-runs the same validation on the incoming
manifest, and installs through the existing atomic writer, so a refused upgrade
leaves the installed file byte-for-byte unchanged.
"""
import json
import os
import stat
from pathlib import Path

from ... import plugin_sdk
from ...resources import _is_link
from . import marketplace

#: A manifest is a small JSON document; anything larger is a mistake or an attack.
MAX_MANIFEST_BYTES = 256 * 1024
MAX_MARKETPLACE_BYTES = 1024 * 1024
MAX_MARKETPLACE_ITEMS = 100
MAX_DIRECTORY_DOCUMENTS = 200

#: Field names that would turn a data manifest into runnable code. Refused by
#: name, even though the closed field set below already excludes them.
EXECUTABLE_FIELDS = ('entrypoint', 'command', 'commands', 'module', 'modules', 'import', 'imports',
                     'script', 'scripts', 'exec', 'eval', 'run', 'shell', 'bin', 'binary',
                     'hook', 'hooks', 'install', 'postinstall', 'uninstall', 'url', 'downloadUrl',
                     'download', 'homepage', 'repository')

#: Closed document shapes. Anything else is an unknown field, never a maybe.
MANIFEST_FIELDS = {'id', 'version', 'apiVersion', 'enabled', 'builtin', 'capabilities',
                   'dependencies', 'name', 'description', 'sha256'}
ENTRY_FIELDS = {'id', 'name', 'description', 'sha256', 'manifest'}
MARKETPLACE_FIELDS = {'apiVersion', 'items'}

#: Fields only a trusted build manifest carries. Those declare executable
#: packages and are audited by the architecture gate instead of here.
BUILD_ONLY_FIELDS = ('features', 'frontendModules', 'panels', 'defaultEnabled')

MARKETPLACE_NAME = 'marketplace.json'


#: A posted document has no path to name; the report says where it came from.
INLINE_TARGET = '<request body>'


def issue(code, message, item_id=None) -> dict:
    """One machine-readable finding: a stable code, a reason and an owner."""
    row = {'code': code, 'message': message}
    if item_id:
        row['id'] = str(item_id)[:120]
    return row


class _Refused(Exception):
    """One unreadable document; the caller records it as a finding."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def _read_json(path, limit):
    """Parse one JSON document without following a link and within a size budget."""
    if _is_link(path):
        raise _Refused('symlink_refused', 'manifest must not be a symlink: %s' % path.name)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        raise _Refused('unreadable', 'manifest cannot be opened: %s' % path.name) from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise _Refused('not_a_file', 'manifest is not a regular file: %s' % path.name)
        if info.st_size > limit:
            raise _Refused('too_large', 'manifest exceeds %d bytes: %s' % (limit, path.name))
        chunks, size = [], 0
        while size <= limit:
            part = os.read(fd, min(65536, limit + 1 - size))
            if not part:
                break
            chunks.append(part)
            size += len(part)
        if size > limit:
            raise _Refused('too_large', 'manifest exceeds %d bytes: %s' % (limit, path.name))
        raw = b''.join(chunks)
    except OSError:
        raise _Refused('unreadable', 'manifest cannot be read: %s' % path.name) from None
    finally:
        os.close(fd)
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise _Refused('invalid_json', 'manifest is not valid JSON: %s' % path.name) from None


def validate_manifest_document(item, resolvable=()):
    """Check one data manifest against the shared SDK contract.

    ``resolvable`` is the set of ids the current validation unit can see; a
    declared dependency outside it is an error rather than a silent gap.
    Returns ``(errors, warnings, manifest)`` and never raises.
    """
    errors, warnings = [], []
    if not isinstance(item, dict):
        return [issue('invalid_shape', 'manifest must be a JSON object')], warnings, None
    build_only = [key for key in BUILD_ONLY_FIELDS if key in item]
    if build_only:
        return [issue('build_manifest', 'a trusted build manifest (%s) is audited by the plugin '
                                        'architecture gate, not as a data package' % ', '.join(build_only))], warnings, None
    for key in sorted(item):
        if key in EXECUTABLE_FIELDS:
            errors.append(issue('executable_field',
                                'manifest must not declare executable content: %s' % key, item.get('id')))
    unknown = sorted(set(item) - MANIFEST_FIELDS)
    if unknown:
        errors.append(issue('unknown_field', 'unexpected manifest fields: %s' % ', '.join(unknown), item.get('id')))
    if errors:
        return errors, warnings, None

    manifest, shape_errors = plugin_sdk.validate_manifest(item)
    for text in shape_errors:
        errors.append(issue('invalid_manifest', text, item.get('id')))
    if manifest is None:
        return errors, warnings, None

    declared = item.get('sha256')
    if declared is not None:
        own = {key: value for key, value in item.items() if key != 'sha256'}
        if str(declared).lower() != marketplace.digest(own):
            errors.append(issue('digest_mismatch', 'declared sha256 does not match the manifest', manifest['id']))
    visible = set(resolvable)
    for dependency in item.get('dependencies') or ():
        if dependency == manifest['id']:
            errors.append(issue('self_dependency', 'manifest depends on itself', manifest['id']))
        elif dependency not in visible:
            errors.append(issue('unknown_dependency',
                                'dependency is not present in the validated set: %s' % dependency, manifest['id']))
    if 'capabilities' in item and not item['capabilities']:
        warnings.append(issue('no_capabilities',
                              'manifest requests no powers; the adapter it names stays disabled', manifest['id']))
    return errors, warnings, manifest


def validate_marketplace_document(document):
    """Check one trusted catalog listing, entry by entry.

    Returns ``(errors, warnings, items)``. An item's manifest is validated with
    exactly the same rules as a standalone file, so a catalog cannot describe a
    package the CLI would refuse to install.
    """
    errors, warnings, items = [], [], []
    if not isinstance(document, dict):
        return [issue('invalid_shape', 'marketplace must be a JSON object')], warnings, items
    unknown = sorted(set(document) - MARKETPLACE_FIELDS)
    if unknown:
        errors.append(issue('unknown_field', 'unexpected marketplace fields: %s' % ', '.join(unknown)))
    if 'apiVersion' in document and document['apiVersion'] != 1:
        errors.append(issue('incompatible_api_version', 'marketplace apiVersion must be 1'))
    rows = document.get('items')
    if not isinstance(rows, list) or not rows:
        errors.append(issue('invalid_items', 'marketplace items must be a non-empty array'))
        return errors, warnings, items
    if len(rows) > MAX_MARKETPLACE_ITEMS:
        errors.append(issue('too_many_items', 'marketplace lists more than %d items' % MAX_MARKETPLACE_ITEMS))
        return errors, warnings, items

    ids = {row.get('id') for row in rows if isinstance(row, dict)}
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            errors.append(issue('invalid_shape', 'marketplace item must be a JSON object'))
            continue
        entry_errors = [issue('unknown_field', 'unexpected marketplace item field: %s' % key, row.get('id'))
                        for key in sorted(set(row) - ENTRY_FIELDS)]
        manifest_errors, manifest_warnings, manifest = validate_manifest_document(row.get('manifest'), ids)
        entry_errors.extend(manifest_errors)
        if manifest is None and not entry_errors:
            entry_errors.append(issue('invalid_manifest', 'marketplace item is missing a manifest', row.get('id')))
        if manifest is not None:
            if row.get('id') != manifest['id']:
                entry_errors.append(issue('id_mismatch', 'item id does not match its manifest id', row.get('id')))
            if manifest['id'] in seen:
                entry_errors.append(issue('duplicate_id', 'marketplace lists the same plugin twice', manifest['id']))
            seen.add(manifest['id'])
            declared = row.get('sha256')
            if declared is not None and str(declared).lower() != marketplace.digest(row['manifest']):
                entry_errors.append(issue('digest_mismatch', 'item sha256 does not match its manifest', manifest['id']))
            for label, limit in (('name', 120), ('description', 500)):
                if len(str(row.get(label, ''))) > limit:
                    manifest_warnings.append(issue('truncated_field', '%s is longer than %d characters and will be '
                                                                  'truncated when installed' % (label, limit),
                                                   manifest['id']))
        items.append({'id': manifest['id'] if manifest else row.get('id'),
                      'version': manifest['version'] if manifest else None,
                      'ok': not entry_errors, 'errors': entry_errors, 'warnings': manifest_warnings})
        errors.extend(entry_errors)
        warnings.extend(manifest_warnings)
    return errors, warnings, items


def dependency_cycles(documents):
    """Dependency cycles among manifests that can see each other."""
    by_id = {row['document'].get('id'): row['document'] for row in documents
             if isinstance(row['document'], dict)}
    cycles = []

    def visit(rid, chain):
        if rid in chain:
            cycles.append(' -> '.join((*chain, rid)))
            return
        for dependency in by_id.get(rid, {}).get('dependencies') or ():
            if dependency in by_id:
                visit(dependency, (*chain, rid))

    for rid in by_id:
        visit(rid, ())
    return cycles


def report(target, kind, errors, warnings, items):
    return {'path': str(target), 'kind': kind, 'ok': not errors,
            'errors': errors, 'warnings': warnings, 'items': items}


def classify(document):
    """``(kind, errors, warnings, items)`` for any parsed document or listing.

    One key decides the shape: a listing carries ``items``, anything else is
    checked as a single manifest. Both branches use the same rules, so a catalog
    can never describe a package the CLI would refuse to install.
    """
    if isinstance(document, dict) and 'items' in document:
        errors, warnings, items = validate_marketplace_document(document)
        return 'marketplace', errors, warnings, items
    errors, warnings, manifest = validate_manifest_document(document)
    items = [{'id': manifest['id'] if manifest else None, 'version': manifest['version'] if manifest else None,
              'ok': not errors, 'errors': errors, 'warnings': warnings}]
    return 'manifest', errors, warnings, items


def validate_inline(document):
    """Audit a document the caller already holds, without touching any path."""
    kind, errors, warnings, items = classify(document)
    return report(INLINE_TARGET, kind, errors, warnings, items)


def validate(target):
    """Validate a manifest file, a marketplace document or a directory of them.

    Read-only by construction: one open per document, no writes, no imports and
    no state access.
    """
    path = target if isinstance(target, Path) else Path(str(target))
    if _is_link(path):
        return report(path, 'unknown', [issue('symlink_refused', 'validated path must not be a symlink')], [], [])
    if not path.exists():
        return report(path, 'unknown', [issue('path_not_found', 'nothing to validate at this path')], [], [])
    if path.is_dir():
        return _validate_directory(path)
    if not path.is_file():
        return report(path, 'unknown', [issue('not_a_file', 'validated path is neither a file nor a directory')],
                      [], [])
    try:
        document = _read_json(path, MAX_MARKETPLACE_BYTES)
    except _Refused as refused:
        return report(path, 'unknown', [issue(refused.code, refused.message)], [], [])
    kind, errors, warnings, items = classify(document)
    return report(path, kind, errors, warnings, items)


def _validate_directory(path):
    try:
        entries = sorted(path.iterdir(), key=lambda item: item.name)
    except OSError:
        return report(path, 'unknown', [issue('unreadable', 'directory cannot be listed')], [], [])
    if len(entries) > MAX_DIRECTORY_DOCUMENTS:
        return report(path, 'unknown',
                      [issue('too_many_entries', 'directory holds more than %d entries' % MAX_DIRECTORY_DOCUMENTS)],
                      [], [])
    listing = next((entry for entry in entries if entry.name == MARKETPLACE_NAME), None)
    if listing is not None:
        try:
            document = _read_json(listing, MAX_MARKETPLACE_BYTES)
        except _Refused as refused:
            return report(path, 'marketplace', [issue(refused.code, refused.message)], [], [])
        errors, warnings, items = validate_marketplace_document(document)
        return report(path, 'marketplace', errors, warnings, items)
    documents, errors, warnings, items = [], [], [], []
    for entry in entries:
        if entry.suffix != '.json' or entry.is_dir():
            continue
        try:
            documents.append({'file': entry, 'document': _read_json(entry, MAX_MANIFEST_BYTES)})
        except _Refused as refused:
            errors.append(issue(refused.code, refused.message, entry.name))
    if not documents:
        # Unreadable documents are the finding; only a genuinely empty directory
        # reports that there was nothing to validate.
        return report(path, 'directory', errors or [issue('nothing_to_validate', 'this directory holds no JSON manifest')],
                      [], items)
    resolvable = {row['document'].get('id') for row in documents if isinstance(row['document'], dict)}
    for row in documents:
        row_errors, row_warnings, manifest = validate_manifest_document(row['document'], resolvable)
        items.append({'id': manifest['id'] if manifest else None,
                      'version': manifest['version'] if manifest else None,
                      'file': row['file'].name, 'ok': not row_errors,
                      'errors': row_errors, 'warnings': row_warnings})
        errors.extend(row_errors)
        warnings.extend(row_warnings)
    for text in dependency_cycles(documents):
        errors.append(issue('dependency_cycle', 'cyclic manifest dependencies: %s' % text))
    return report(path, 'directory', errors, warnings, items)


def _version(text):
    return tuple(int(part) for part in str(text).split('.'))


def update(state_dir, plugin_id=None, all_ids=False, dry_run=False):
    """Upgrade installed data manifests from the marketplace this plugin trusts.

    Every incoming manifest passes the same validation as ``plugins validate``
    and its catalog digest must still match before anything is written; the
    write itself is the existing atomic replace with rollback. No new download
    source is introduced: the catalog comes from ``marketplace.catalog`` alone.
    """
    if bool(plugin_id) == bool(all_ids):
        raise ValueError('exactly one plugin id or --all is required')
    try:
        rows = marketplace.catalog(state_dir)
    except (ValueError, OSError):
        raise ValueError('marketplace catalog is unavailable or invalid') from None
    by_id = {row['id']: row for row in rows}
    installed = {row['id']: row for row in plugin_sdk.load_manifests(state_dir)}
    result = {'ok': True, 'dryRun': bool(dry_run), 'updated': [], 'skipped': [], 'errors': []}
    for rid in (sorted(installed) if all_ids else [plugin_id]):
        if not all_ids and rid not in installed:
            result['errors'].append(issue('not_installed',
                                          'no installed manifest with this id; install it first', rid))
            continue
        row = by_id.get(rid)
        if row is None:
            if all_ids:
                result['skipped'].append({'id': rid, 'reason': 'not in the marketplace catalog'})
            else:
                result['errors'].append(issue('not_in_catalog', 'the marketplace no longer lists this package', rid))
            continue
        errors, _warnings, _manifest = validate_manifest_document(row['manifest'])
        if row.get('sha256') != marketplace.digest(row['manifest']):
            errors.append(issue('digest_mismatch', 'catalog digest no longer matches the offered manifest', rid))
        if errors:
            result['errors'].extend(errors)
            continue
        try:
            newer = _version(row['version']) > _version(installed[rid]['version'])
        except ValueError:
            result['errors'].append(issue('invalid_version', 'installed version cannot be compared', rid))
            continue
        if not newer:
            result['skipped'].append({'id': rid, 'reason': 'already at the newest listed version'})
            continue
        planned = {'id': rid, 'fromVersion': installed[rid]['version'], 'toVersion': row['version'],
                   'sha256': row['sha256']}
        if dry_run:
            result['updated'].append(planned)
            continue
        try:
            marketplace.install(state_dir, rid, row['sha256'], update=True)
        except (ValueError, OSError) as exc:
            result['errors'].append(issue('update_refused', str(exc), rid))
            continue
        result['updated'].append(planned)
    result['ok'] = not result['errors']
    return result


def dispatch(method, parts, query, data, ctx):
    """``POST /api/plugins/marketplace/validate`` for one inline document.

    The body must be exactly ``{"document": ...}``: an audit of a server-side
    path would turn this endpoint into a filesystem probe, so paths stay a CLI
    concern and the Web only ever checks a document the caller already holds.
    """
    if parts[:4] != ['api', 'plugins', 'marketplace', 'validate'] or method != 'POST':
        return None
    if not isinstance(data, dict) or set(data) != {'document'}:
        return 400, {'error': 'expected an inline document'}
    return 200, validate_inline(data['document'])
