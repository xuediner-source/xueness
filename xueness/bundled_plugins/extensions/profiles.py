"""Plugin composition profiles: pure data that chooses which plugins are on.

A profile is a mapping of allowlisted plugin ids to booleans and nothing else —
no paths, commands, module names, hooks or URLs. Applying one records that
mapping as the profile layer of the existing boolean switch file, so the merge
order stays fixed: an explicit user switch, then the profile overlay, then the
manifest default. A profile can therefore only narrow or restore the plugin set;
it cannot relax a Gate, a workspace boundary, an approval rule or a permission
mode. Where a profile turns a plugin on but a dependency stays off, the catalog
keeps reporting ``blockedBy`` and nothing is enabled behind the user's back.

Custom profiles live in the state directory as the same kind of data file. They
are read, validated and merged here and never imported.
"""
import json
import re
from pathlib import Path

from ... import plugin_runtime
from ...resources import _is_link

BUILT_IN_FILE = Path(__file__).with_name('profiles.json')
CUSTOM_DIRECTORY = 'plugin-profiles'
MAX_PROFILE_BYTES = 64 * 1024
MAX_PROFILES = 64
MAX_EXTENDS_DEPTH = 8
PROFILE_NAME = re.compile(r'[a-z][a-z0-9_-]{0,63}\Z')

DOCUMENT_FIELDS = {'apiVersion', 'profiles'}
PROFILE_FIELDS = {'name', 'nameEn', 'description', 'descriptionEn', 'extends', 'plugins'}


def _refuse(message):
    raise ValueError('invalid plugin profile: ' + message)


def _read_json(path, limit):
    """One JSON document, without following a link and inside a size budget."""
    if _is_link(path):
        _refuse('%s must not be a symlink' % path.name)
    try:
        raw = path.read_bytes()
    except OSError:
        _refuse('%s cannot be read' % path.name)
    if len(raw) > limit:
        _refuse('%s exceeds %d bytes' % (path.name, limit))
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        _refuse('%s is not valid JSON' % path.name)


def _switches(document, name):
    """Reject unknown fields, unknown plugin ids and non-boolean switches."""
    if not isinstance(document, dict) or set(document) - PROFILE_FIELDS:
        _refuse('%s uses unsupported fields' % name)
    if 'name' in document and document['name'] != name:
        _refuse('%s does not name itself consistently' % name)
    parent = document.get('extends')
    if parent is not None and (type(parent) is not str or not PROFILE_NAME.match(parent)):
        _refuse('%s names an invalid profile to extend' % name)
    plugins = document.get('plugins')
    if not isinstance(plugins, dict) or not plugins:
        _refuse('%s must list plugin switches' % name)
    if len(plugins) > len(plugin_runtime.PLUGIN_IDS):
        _refuse('%s lists more switches than there are plugins' % name)
    for plugin_id, value in plugins.items():
        if plugin_id not in plugin_runtime.PLUGIN_IDS:
            _refuse('%s selects an unknown plugin: %s' % (name, plugin_id))
        if type(value) is not bool:
            _refuse('%s switch for %s must be a boolean' % (name, plugin_id))
    return {'name': name, 'extends': parent, 'plugins': dict(plugins),
            'nameEn': document.get('nameEn'), 'description': document.get('description'),
            'descriptionEn': document.get('descriptionEn')}


def built_in():
    """The profiles shipped as data inside this plugin package."""
    document = _read_json(BUILT_IN_FILE, MAX_PROFILE_BYTES)
    if not isinstance(document, dict) or set(document) - DOCUMENT_FIELDS or document.get('apiVersion') != 1:
        _refuse('the shipped profile file uses unsupported fields')
    rows = document.get('profiles')
    if not isinstance(rows, list) or not rows or len(rows) > MAX_PROFILES:
        _refuse('the shipped profile file lists no usable profiles')
    result = {}
    for row in rows:
        if not isinstance(row, dict) or type(row.get('name')) is not str or not PROFILE_NAME.match(row['name']):
            _refuse('a shipped profile has an invalid name')
        if row['name'] in result:
            _refuse('a shipped profile is listed twice: %s' % row['name'])
        result[row['name']] = _switches(row, row['name'])
    return result


def custom(state_dir):
    """Pure-data profiles the operator stored in the state directory."""
    directory = Path(state_dir) / CUSTOM_DIRECTORY
    if _is_link(directory):
        _refuse('%s must not be a symlink' % CUSTOM_DIRECTORY)
    if not directory.is_dir():
        return {}
    result = {}
    entries = sorted(directory.glob('*.json'))
    if len(entries) > MAX_PROFILES:
        _refuse('more than %d custom profiles' % MAX_PROFILES)
    for path in entries:
        name = path.stem
        if not PROFILE_NAME.match(name) or _is_link(path):
            _refuse('%s is not a usable profile file' % path.name)
        result[name] = _switches(_read_json(path, MAX_PROFILE_BYTES), name)
    return result


def _tables(state_dir):
    """Selectable profiles by name, with the built-in table winning on a clash."""
    table, sources = {}, {}
    for name, entry in built_in().items():
        table[name], sources[name] = entry, 'built-in'
    for name, entry in custom(state_dir).items():
        table.setdefault(name, entry)
        sources.setdefault(name, 'custom')
    return table, sources


def resolve(state_dir, name):
    """One profile with its inheritance merged, deepest parent first.

    Every level must again contain only allowlisted boolean switches, and a
    repeated or over-deep ``extends`` chain is refused instead of looping.
    """
    table, sources = _tables(state_dir)
    if type(name) is not str or not PROFILE_NAME.match(name):
        raise ValueError('invalid plugin profile name: %s' % (name,))
    if name not in table:
        raise ValueError('unknown plugin profile: ' + name)
    chain, current = [], name
    while True:
        if current in chain:
            raise ValueError('cyclic plugin profile inheritance: %s' % ' -> '.join((*chain, current)))
        if len(chain) >= MAX_EXTENDS_DEPTH:
            raise ValueError('plugin profile inheritance deeper than %d levels' % MAX_EXTENDS_DEPTH)
        entry = table[current]
        chain.append(current)
        if not entry['extends']:
            break
        current = entry['extends']
        if current not in table:
            raise ValueError('unknown plugin profile: ' + current)
    overlay = {}
    for level in reversed(chain):
        overlay.update(table[level]['plugins'])
    return {'name': name, 'source': sources[name], 'chain': chain, 'plugins': overlay}


def describe(state_dir):
    """Every selectable profile, with the switches each one would choose."""
    active = plugin_runtime.profile_state(state_dir)['name']
    table, sources = _tables(state_dir)
    rows = []
    for name in sorted(table):
        resolved = resolve(state_dir, name)
        rows.append({'name': name, 'source': sources[name], 'extends': resolved['chain'][1:],
                     'description': table[name]['description'] or '',
                     'descriptionEn': table[name]['descriptionEn'] or '',
                     'enabled': sorted(pid for pid, value in resolved['plugins'].items() if value),
                     'disabled': sorted(pid for pid, value in resolved['plugins'].items() if not value),
                     'active': name == active})
    return rows


def show(state_dir, name):
    """A resolved profile plus the catalog it would produce, without writing."""
    resolved = resolve(state_dir, name)
    return {'profile': resolved['name'], 'source': resolved['source'], 'extends': resolved['chain'][1:],
            'plugins': resolved['plugins'],
            'catalog': [{key: item[key] for key in ('id', 'enabled', 'effective', 'blockedBy')}
                        for item in plugin_runtime.preview(state_dir, resolved['plugins'])]}


def apply(state_dir, name, dry_run=False):
    """Select a profile, or report the selection without changing anything."""
    resolved = resolve(state_dir, name)
    overlay = resolved['plugins']
    before = {item['id']: item for item in plugin_runtime.catalog(state_dir)}
    if dry_run:
        after = plugin_runtime.preview(state_dir, overlay)
    else:
        after = plugin_runtime.set_profile(state_dir, name, overlay)
    changes, blocked, warnings = [], [], []
    for item in after:
        pid = item['id']
        previous = before[pid]
        if type(overlay.get(pid)) is bool and item['enabled'] != overlay[pid]:
            # An explicit user switch outranks the profile and is left alone.
            warnings.append({'code': 'explicitSwitchKept', 'id': pid,
                             'message': 'your own switch for %s is kept ahead of the profile' % pid})
        if item['enabled'] != previous['enabled'] or item['effective'] != previous['effective']:
            changes.append({'id': pid, 'enabled': item['enabled'], 'wasEnabled': previous['enabled'],
                            'effective': item['effective'], 'wasEffective': previous['effective']})
        if overlay.get(pid) and item['blockedBy']:
            blocked.append({'id': pid, 'blockedBy': item['blockedBy']})
    if overlay.get('extensions') is False:
        warnings.append({'code': 'profileOwnerDisabled',
                         'message': 'this profile switches extensions off, so profiles stop working until '
                                    '"xueness plugins enable extensions" runs'})
    return {'ok': True, 'dryRun': bool(dry_run), 'profile': name, 'source': resolved['source'],
            'extends': resolved['chain'][1:], 'changes': changes, 'blocked': blocked, 'warnings': warnings,
            'catalog': [{key: item[key] for key in ('id', 'enabled', 'effective', 'blockedBy')} for item in after]}


def command(state_dir, action, name=None, dry_run=False):
    """Run ``xueness plugins profile [list|show <name>|apply <name> [--dry-run]]``."""
    if action == 'list':
        return {'ok': True, 'active': plugin_runtime.profile_state(state_dir)['name'],
                'profiles': describe(state_dir)}
    if action == 'show':
        return {'ok': True, **show(state_dir, name)}
    if action == 'apply':
        return apply(state_dir, name, dry_run)
    raise ValueError('unsupported profile action: %s' % (action,))


def dispatch(method, parts, query, data, ctx):
    """``GET /api/plugins/profiles`` and ``POST /api/plugins/profiles/apply``."""
    if parts[:3] != ['api', 'plugins', 'profiles']:
        return None
    if len(parts) == 3 and method == 'GET':
        state_dir = ctx['state_dir']
        return 200, {'active': plugin_runtime.profile_state(state_dir)['name'], 'profiles': describe(state_dir)}
    if len(parts) == 4 and parts[3] == 'apply' and method == 'POST':
        # Only a named built-in or custom tier is a request: an inline overlay in
        # the body would be a plugin switch smuggled in as if it were data.
        if not isinstance(data, dict) or set(data) - {'name', 'dryRun'}:
            return 400, {'error': 'expected a profile name'}
        name = data.get('name')
        if type(name) is not str:
            return 400, {'error': 'profile name is required'}
        dry_run = data.get('dryRun') is True
        try:
            result = apply(ctx['state_dir'], name, dry_run)
        except (ValueError, OSError) as exc:
            return 400, {'error': str(exc)[:200]}
        if not dry_run:
            plugin_runtime.sync_services(ctx)
        return 200, result
    return 405, {'error': 'method not allowed'}
