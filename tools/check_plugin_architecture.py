#!/usr/bin/env python3
"""Read-only plugin ownership gate. Never imports feature code or reads state."""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
import re


# These are infrastructure, not destinations for new product features. A new
# exception requires an architecture review and a reason in CONTRIBUTING.md.
KERNEL_BACKEND = {
    '__init__.py', '__main__.py', 'cli.py', 'core.py', 'events.py',
    'http_contract.py', 'file_lock.py', 'process_runtime.py', 'plugin_cli.py', 'plugin_contract.py', 'plugin_runtime.py',
    'plugin_scope.py', 'plugin_sdk.py', 'plugins.py', 'resources.py', 'session_lease.py',
    'tool_contract.py', 'tool_registry.py', 'builtin_tools.py', 'web.py', 'write_lock.py',
}
SHARED_FRONTEND = {
    'App.tsx', 'main.tsx', 'vite-env.d.ts', 'i18n.ts',
    'XuenessShell.tsx', 'XuenessWorkbenchContainer.tsx',
    'XuenessPluginManager.tsx', 'xuenessPluginRegistry.ts',
    'XuenessCapabilitiesPanel.tsx', 'XuenessCapabilityDialog.tsx',
    'xuenessCapabilities.ts', 'xuenessApi.ts', 'xuenessBridge.ts',
    'xuenessWorkspace.ts', 'xuenessFuzzy.ts', 'xuenessEvents.ts', 'plugins/shared.tsx',
    'ui/CodeContent.tsx', 'ui/CodePreview.tsx', 'ui/Select.tsx',
    'ui/icons.tsx', 'ui/primitives.tsx',
    # Platform-aware shortcut display (⌘/Ctrl, ⌥/Alt, ⇧/Shift).
    # Single source of truth used by XuenessShell (sidebar actions) and the
    # settings plugin (shortcuts panel). Pure display logic, no business rules.
    # Added 2026-10-07 during Win/Mac shortcut display unification.
    'xuenessShortcutDisplay.ts',
}

SERVICE_NAME = re.compile(r'[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\Z')
ROUTE_SEGMENT = re.compile(r'\*|[a-z][a-z0-9_]*\Z')
ACTION_NAME = re.compile(r'[a-z][a-z0-9_]*\Z')
DATA_PATH = re.compile(r'[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\Z')

#: A package data file that composes plugins is audited as data here too: it may
#: only name allowlisted plugins with booleans, and its inheritance must resolve.
PROFILE_NAME = re.compile(r'[a-z][a-z0-9_-]{0,63}\Z')
PROFILE_DOCUMENT_FIELDS = {'apiVersion', 'profiles'}
PROFILE_FIELDS = {'name', 'nameEn', 'description', 'descriptionEn', 'extends', 'plugins'}
MAX_EXTENDS_DEPTH = 8


def _strings(manifest, field) -> list[str]:
    values = manifest.get(field)
    return [value for value in values if isinstance(value, str)] if isinstance(values, list) else []


def _read(root: Path, relative: str) -> str:
    target = root / relative
    for part in (target, *target.parents):
        if part == root.parent:
            break
        if part.is_symlink():
            raise ValueError('symlink is not allowed: ' + relative)
    if not target.is_file() or not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('missing or out-of-root file: ' + relative)
    return target.read_text(encoding='utf-8')


def _ids(root: Path) -> tuple[str, ...]:
    tree = ast.parse(_read(root, 'xueness/plugin_runtime.py'))
    value = next((ast.literal_eval(node.value) for node in tree.body
                  if isinstance(node, ast.Assign)
                  and any(isinstance(t, ast.Name) and t.id == 'PLUGIN_IDS' for t in node.targets)), None)
    if not isinstance(value, (list, tuple)) or not value or any(
            not isinstance(x, str) or not re.fullmatch(r'[a-z][a-z0-9_]*', x) for x in value):
        raise ValueError('PLUGIN_IDS must be a literal list of plugin IDs')
    if len(value) != len(set(value)):
        raise ValueError('duplicate PLUGIN_IDS')
    return tuple(value)


def _profile_document_errors(pid: str, ref: str, document, ids: tuple[str, ...]) -> list[str]:
    """Audit composition data shipped inside a package: ids, booleans, parents.

    The gate never imports the plugin that reads such a file, so the same rules
    its runtime applies are checked statically here: a profile may only pick
    allowlisted plugins with booleans, and an ``extends`` chain must resolve
    without a cycle or unbounded depth.
    """
    if not isinstance(document, dict) or set(document) - PROFILE_DOCUMENT_FIELDS:
        return [pid + ': profile data ' + ref + ' uses unsupported fields']
    if type(document.get('apiVersion')) is not int or document['apiVersion'] != 1:
        return [pid + ': profile data ' + ref + ' needs apiVersion 1']
    rows = document.get('profiles')
    if not isinstance(rows, list) or not rows:
        return [pid + ': profile data ' + ref + ' lists no usable profiles']

    errors: list[str] = []
    parents: dict[str, str | None] = {}
    for row in rows:
        if not isinstance(row, dict) or not PROFILE_NAME.match(str(row.get('name') or '')):
            errors.append(pid + ': profile data ' + ref + ' has an invalid profile name')
            continue
        name = row['name']
        if name in parents:
            errors.append(pid + ': duplicate profile ' + name + ' in ' + ref)
            continue
        parents[name] = None
        unsupported = sorted(set(row) - PROFILE_FIELDS)
        parent, switches = row.get('extends'), row.get('plugins')
        if unsupported:
            errors.append(pid + ': profile ' + name + ' uses unsupported fields: ' + ', '.join(unsupported))
            continue
        if parent is not None and (not isinstance(parent, str) or not PROFILE_NAME.match(parent)):
            errors.append(pid + ': profile ' + name + ' extends an invalid profile name')
        elif isinstance(parent, str):
            parents[name] = parent
        if not isinstance(switches, dict) or not switches:
            errors.append(pid + ': profile ' + name + ' lists no plugin switches')
            continue
        for plugin_id, value in switches.items():
            if plugin_id not in ids:
                errors.append(pid + ': profile ' + name + ' selects an unknown plugin: ' + str(plugin_id))
            elif type(value) is not bool:
                errors.append(pid + ': profile ' + name + ' switch for ' + plugin_id + ' must be boolean')
    for name in parents:
        chain: list[str] = []
        current: str | None = name
        while current is not None:
            if current in chain:
                errors.append(pid + ': cyclic profile inheritance: ' + ' -> '.join((*chain, current)))
                break
            if len(chain) >= MAX_EXTENDS_DEPTH:
                errors.append(pid + ': profile inheritance deeper than %d levels: %s'
                              % (MAX_EXTENDS_DEPTH, name))
                break
            chain.append(current)
            parent = parents.get(current)
            if parent is not None and parent not in parents:
                errors.append(pid + ': profile ' + current + ' extends an unknown profile: ' + parent)
                break
            current = parent
    return errors


def audit(root: Path) -> list[str]:
    """Return actionable structural failures, independent of user switches."""
    root = Path(root).absolute()
    errors: list[str] = []
    try:
        ids = _ids(root)
        registry = _read(root, 'webapp/src/xuenessPluginRegistry.ts')
    except (OSError, ValueError, SyntaxError, StopIteration) as exc:
        return [str(exc)]
    package_root = root / 'xueness/bundled_plugins'
    packages = {p.name for p in package_root.iterdir() if p.is_dir() and p.name != '__pycache__'}
    if packages != set(ids):
        errors.append('bundled package/allowlist mismatch: ' + ', '.join(sorted(packages ^ set(ids))))
    # The UI registry is intentionally a static, descriptive TypeScript object.
    registry_object = re.search(r'export const XUENESS_PLUGIN_REGISTRY\s*=\s*\{(.*?)\}\s*as const', registry, re.S)
    frontend = {}
    for pid, body in re.findall(r'\b([a-z][a-z0-9_]*)\s*:\s*\{([^{}]*)\}', registry_object[1] if registry_object else ''):
        panels = re.search(r'\bpanels:\s*\[([^\]]*)\]', body)
        if pid in frontend:
            errors.append('duplicate frontend registry ID: ' + pid)
        if panels:
            frontend[pid] = re.findall(r'[\'"]([^\'"]+)[\'"]', panels[1])
    if set(frontend) != set(ids):
        errors.append('frontend registry/allowlist mismatch: ' + ', '.join(sorted(set(frontend) ^ set(ids))))
    manifests = {}
    contribution_owners = {'tools': {}, 'commands': {}, 'resources': {}}
    feature_ids = set()
    ui_refs: dict[str, str] = {}
    desktop_refs: dict[str, str] = {}
    for pid in ids:
        prefix = 'xueness/bundled_plugins/' + pid + '/'
        try:
            manifest = json.loads(_read(root, prefix + 'manifest.json'))
            _read(root, prefix + '__init__.py')
            _read(root, prefix + 'plugin.py')
            if not isinstance(manifest, dict):
                raise ValueError('manifest must be an object')
            manifests[pid] = manifest
            if manifest.get('id') != pid or type(manifest.get('apiVersion')) is not int or manifest['apiVersion'] != 1:
                errors.append(pid + ': incompatible id/apiVersion')
            if type(manifest.get('defaultEnabled')) is not bool:
                errors.append(pid + ': defaultEnabled must be boolean')
            for label in ('name', 'description', 'version'):
                if not isinstance(manifest.get(label), str) or not manifest[label].strip():
                    errors.append(pid + ': missing ' + label)
            for field in ('dependencies', 'tools', 'commands', 'panels', 'resources', 'capabilities', 'modules', 'frontendModules'):
                values = manifest.get(field)
                if not isinstance(values, list) or any(not isinstance(x, str) or not x for x in values):
                    errors.append(pid + ': ' + field + ' must be a string array')
                    manifest[field] = []
                    continue
                if len(values) != len(set(values)):
                    errors.append(pid + ': duplicate ' + field)
                if field in contribution_owners:
                    for value in values:
                        previous = contribution_owners[field].setdefault(value, pid)
                        if previous != pid:
                            errors.append(field + ': multiple owners for ' + value)
            if any(dep not in ids or dep == pid for dep in manifest['dependencies']):
                errors.append(pid + ': unknown or self dependency')
            for field in ('provides', 'inject', 'httpFamilies', 'pluginsActions', 'dataFiles'):
                if field not in manifest:
                    continue
                values = manifest[field]
                if not isinstance(values, list) or any(not isinstance(x, str) or not x for x in values):
                    errors.append(pid + ': ' + field + ' must be a string array')
                    manifest[field] = []
                    continue
                if len(values) != len(set(values)):
                    errors.append(pid + ': duplicate ' + field)
                for value in values:
                    if field == 'httpFamilies':
                        segments = value.split('/')
                        if segments[0] == '*' or any(not ROUTE_SEGMENT.match(segment) for segment in segments):
                            errors.append(pid + ': invalid httpFamilies pattern ' + value)
                    elif field == 'dataFiles':
                        if value.startswith('/') or '..' in Path(value).parts or not DATA_PATH.match(value):
                            errors.append(pid + ': invalid dataFiles path ' + value)
                    elif field == 'pluginsActions':
                        if not ACTION_NAME.match(value):
                            errors.append(pid + ': invalid pluginsActions name ' + value)
                    elif not SERVICE_NAME.match(value):
                        errors.append(pid + ': invalid ' + field + ' name ' + value)
            tool_events = manifest.get('toolEvents')
            if tool_events is not None:
                # Pure data: which pipeline events this plugin may intervene in
                # (deny before / rewrite after), plus an optional dispatch
                # priority. The same shapes are checked at manifest load time.
                if not isinstance(tool_events, dict) or set(tool_events) - {'events', 'priority'}:
                    errors.append(pid + ': toolEvents must be an object with events and an optional priority')
                else:
                    events = tool_events.get('events')
                    if (not isinstance(events, list) or not events
                            or len(events) != len(set(events))
                            or any(not isinstance(item, str) or item not in (
                                'before_tool_execution', 'after_tool_execution',
                                'after_tool_authorization', 'before_tool_effect')
                                for item in events)):
                        errors.append(pid + ': toolEvents events must list unique names from '
                                      'before_tool_execution, after_tool_execution, '
                                      'after_tool_authorization, before_tool_effect')
                    priority = tool_events.get('priority')
                    if priority is not None and (type(priority) is not int
                                                 or not -1000 <= priority <= 1000):
                        errors.append(pid + ': toolEvents priority must be an int within [-1000, 1000]')
            actual = {p.relative_to(package_root / pid).with_suffix('').as_posix().replace('/', '.')
                      for p in (package_root / pid).rglob('*.py')
                      if p.name != '__init__.py' and p.relative_to(package_root / pid).as_posix() != 'plugin.py'}
            for p in (package_root / pid).rglob('*'):
                if p.is_symlink():
                    errors.append(pid + ': package symlink ' + p.name)
            declared = set(manifest['modules'])
            if actual != declared:
                errors.append(pid + ': module ownership mismatch: ' + ', '.join(sorted(actual ^ declared)))
            if set(manifest['panels']) != set(frontend.get(pid, [])):
                errors.append(pid + ': frontend/backend panel mismatch')
            features = manifest.get('features')
            if not isinstance(features, list) or not features:
                errors.append(pid + ': features must describe every product capability')
                features = []
            for feature in features:
                if not isinstance(feature, dict) or set(feature) != {'id', 'name', 'nameEn'} or any(
                        not isinstance(feature.get(k), str) or not feature[k].strip() for k in ('id', 'name', 'nameEn')):
                    errors.append(pid + ': invalid bilingual feature entry')
                    continue
                fid = feature['id']
                if not re.fullmatch(re.escape(pid) + r'\.[a-z][a-z0-9_]*', fid) or fid in feature_ids:
                    errors.append(pid + ': duplicate or invalid feature id ' + fid)
                feature_ids.add(fid)
            for ref in manifest['frontendModules']:
                if ref in ui_refs:
                    errors.append(pid + ': multiple frontend owners for ' + ref)
                ui_refs[ref] = pid
                file, _, symbol = ref.partition('#')
                if file.startswith('/') or '..' in Path(file).parts or Path(file).suffix not in ('.ts', '.tsx') or '.test.' in file:
                    errors.append(pid + ': invalid frontend module ' + ref)
                    continue
                text = _read(root, 'webapp/src/' + file)
                if file.startswith('plugins/') and len(Path(file).parts) > 2 and Path(file).parts[1] != pid:
                    errors.append(pid + ': frontend package owned by another plugin ' + file)
                if symbol and not re.search(r'^export (?:async )?(?:function|class|const) ' + re.escape(symbol) + r'\b', text, re.M):
                    errors.append(pid + ': missing frontend export ' + ref)
            for ref in manifest.get('desktopModules', []):
                if not isinstance(ref, str) or not ref.startswith('src/') or '..' in Path(ref).parts:
                    errors.append(pid + ': invalid desktop module declaration')
                    continue
                if ref in desktop_refs:
                    errors.append('multiple desktop owners: ' + ref)
                desktop_refs[ref] = pid
                _read(root, 'desktop/' + ref)
            assets = manifest.get('backendAssets', [])
            if not isinstance(assets, list) or any(not isinstance(ref, str) or Path(ref).is_absolute() or '..' in Path(ref).parts for ref in assets):
                errors.append(pid + ': invalid backend asset declaration')
            else:
                for ref in assets:
                    _read(root, prefix + ref)
                actual = {p.relative_to(package_root / pid).as_posix() for p in (package_root / pid).rglob('*') if p.suffix in ('.js', '.mjs', '.cjs')}
                if actual != set(assets):
                    errors.append(pid + ': backend worker assets must all have an explicit owner')
            data_files = manifest.get('dataFiles', [])
            if not isinstance(data_files, list) or any(not isinstance(ref, str) or not DATA_PATH.match(ref)
                                                       or '..' in Path(ref).parts or ref == 'manifest.json'
                                                       for ref in data_files):
                errors.append(pid + ': invalid data file declaration')
            else:
                for ref in data_files:
                    text = _read(root, prefix + ref)
                    if Path(ref).suffix == '.json':
                        try:
                            document = json.loads(text)
                        except ValueError:
                            errors.append(pid + ': data file is not valid JSON: ' + ref)
                            continue
                        if isinstance(document, dict) and 'profiles' in document:
                            errors.extend(_profile_document_errors(pid, ref, document, ids))
                undeclared = sorted({p.relative_to(package_root / pid).as_posix()
                                     for p in (package_root / pid).rglob('*.json')}
                                    - set(data_files) - {'manifest.json'})
                if undeclared:
                    errors.append(pid + ': package data files need an explicit owner: ' + ', '.join(undeclared))
        except (OSError, ValueError, SyntaxError, KeyError) as exc:
            errors.append(pid + ': ' + str(exc))

    # Lifecycle declarations are data, but they must stay unambiguous: one HTTP
    # family, one service name and one ``plugins`` sub-action can only have one
    # owner, and a declared provider or injected service has to exist in the
    # build allowlist.
    family_owners: dict[tuple[str, ...], str] = {}
    service_owners: dict[str, str] = {}
    action_owners: dict[str, str] = {}
    for pid in ids:
        manifest = manifests.get(pid) or {}
        for value in _strings(manifest, 'httpFamilies'):
            pattern = tuple(value.split('/'))
            previous = family_owners.get(pattern)
            if previous is not None and previous != pid:
                errors.append('http family: multiple owners for ' + value)
            family_owners[pattern] = pid
        for name in _strings(manifest, 'provides'):
            previous = service_owners.get(name)
            if previous is not None and previous != pid:
                errors.append('service: multiple providers for ' + name)
            service_owners[name] = pid
        for name in _strings(manifest, 'pluginsActions'):
            previous = action_owners.get(name)
            if previous is not None and previous != pid:
                errors.append('plugins action: multiple owners for ' + name)
            action_owners[name] = pid
        try:
            entry = _read(root, 'xueness/bundled_plugins/' + pid + '/plugin.py')
        except (OSError, ValueError):
            continue  # the package audit above already reported the missing entry point
        if _strings(manifest, 'provides') and not re.search(r'^def activate\(scope, ctx\)', entry, re.M):
            errors.append(pid + ': declares provides without activate(scope, ctx)')
        if _strings(manifest, 'pluginsActions') and not re.search(r'^def execute_cli\(args\)', entry, re.M):
            errors.append(pid + ': declares pluginsActions without execute_cli(args)')
    for pid in ids:
        for name in _strings(manifests.get(pid) or {}, 'inject'):
            if name not in service_owners:
                errors.append(pid + ': injects a service no plugin provides: ' + name)
    claims = sorted(family_owners.items())
    for index, (pattern, owner) in enumerate(claims):
        for other, other_owner in claims[index + 1:]:
            if owner == other_owner or len(pattern) != len(other):
                continue
            if all(left == right or left == '*' or right == '*' for left, right in zip(pattern, other)):
                errors.append('http family overlap: %s (%s) and %s (%s)'
                              % ('/'.join(pattern), owner, '/'.join(other), other_owner))

    def visit(pid, chain):
        if pid in chain:
            errors.append('cyclic plugin dependency: ' + ' -> '.join((*chain, pid)))
            return
        for dep in manifests.get(pid, {}).get('dependencies', []):
            if dep in manifests:
                visit(dep, (*chain, pid))
    for pid in ids:
        visit(pid, ())
    for path in (root / 'webapp/src').rglob('*'):
        file = path.relative_to(root / 'webapp/src').as_posix()
        if path.suffix not in ('.ts', '.tsx') or '.test.' in file or file in SHARED_FRONTEND:
            continue
        if path.suffix == '.tsx' and not file.startswith(('plugins/', 'ui/')):
            errors.append('product component outside plugin directory: ' + file)
        if file in ui_refs:
            if any(ref.startswith(file + '#') for ref in ui_refs):
                errors.append('whole-file/export ownership overlap: ' + file)
            continue
        exports = re.findall(r'^export (?:async )?(?:function|class|const) (\w+)', _read(root, 'webapp/src/' + file), re.M)
        if not exports or any(file + '#' + symbol not in ui_refs for symbol in exports):
            errors.append('unowned frontend feature module: ' + file)
    for path in (root / 'xueness').glob('*.py'):
        if path.name in KERNEL_BACKEND:
            continue
        text = _read(root, 'xueness/' + path.name)
        tree = ast.parse(text)
        target = re.search(r"(?:import_module|run_module)\(['\"](xueness\.bundled_plugins\.([a-z][a-z0-9_]*)\.[^'\"]+)['\"]", text)
        if any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for n in tree.body) or not target:
            errors.append('business code outside plugin package: xueness/' + path.name)
        elif target[2] not in ids or not (root / (target[1].replace('.', '/') + '.py')).is_file():
            errors.append('invalid plugin compatibility target: xueness/' + path.name)
    for path in (root / 'desktop/src').rglob('*'):
        if path.is_file() and path.relative_to(root / 'desktop').as_posix() not in desktop_refs:
            errors.append('unowned desktop feature module: ' + path.relative_to(root).as_posix())
    cli = ast.parse(_read(root, 'xueness/cli.py'))
    compatibility = {'_render_event', '_add_agent_flags', '_model_selection_record',
                     '_prepare_agent', '_load_commands', '_prompt', '_approval_prompt',
                     '_latest_chat', '_chat_loop', '_chat_loop_owned', '_print_summary',
                     '_stream_json_event', '_event_renderer', '_register_session_cli',
                     '_register_settings_cli', '_register_usage_cli', '_register_memory_cli',
                     '_register_git_cli'}
    for function in (node for node in cli.body if isinstance(node, ast.FunctionDef)):
        if function.name in compatibility and any(not isinstance(node, (
                ast.Import, ast.ImportFrom, ast.Return, ast.Expr)) for node in function.body):
            errors.append('CLI compatibility helper contains business logic: ' + function.name)
        if function.name in compatibility and any(isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute) and node.func.attr == 'add_parser'
                for node in ast.walk(function)):
            errors.append('CLI parser must be owned by its plugin: ' + function.name)
        if function.name == 'main':
            for node in ast.walk(function):
                if isinstance(node, ast.Compare) and isinstance(node.left, ast.Attribute) and node.left.attr == 'cmd':
                    for value in node.comparators:
                        if isinstance(value, ast.Constant) and isinstance(value.value, str) and value.value not in {'plugins', 'resources'}:
                            errors.append('CLI host handles a product command: ' + value.value)
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        failures = audit(args.root)
    except (OSError, ValueError, SyntaxError) as exc:
        failures = [str(exc)]
    if failures:
        for issue in failures:
            print('FAIL: ' + issue)
        return 1
    print('PASS: plugin packages, feature inventory, module ownership and CLI/UI catalog metadata are consistent.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
