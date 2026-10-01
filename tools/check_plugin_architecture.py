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
    'http_contract.py', 'plugin_cli.py', 'plugin_contract.py', 'plugin_runtime.py',
    'plugin_sdk.py', 'plugins.py', 'resources.py', 'session_lease.py',
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
}


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
        except (OSError, ValueError, SyntaxError, KeyError) as exc:
            errors.append(pid + ': ' + str(exc))

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
