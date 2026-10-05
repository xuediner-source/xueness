"""Structural ownership gates and persisted policy at public tool boundaries."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from xueness import plugin_runtime
from xueness.core import Gate, Store, execute
from xueness.tool_contract import bind_execution
from xueness.tool_registry import dispatch, REGISTRY

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('plugin_architecture_guard', ROOT / 'tools/check_plugin_architecture.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ArchitectureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def fixture(self):
        root = self.base / 'source'
        shutil.copytree(ROOT / 'xueness', root / 'xueness', ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copytree(ROOT / 'webapp/src', root / 'webapp/src')
        shutil.copytree(ROOT / 'desktop/src', root / 'desktop/src')
        return root

    def rewrite(self, root, pid, change):
        path = root / 'xueness/bundled_plugins' / pid / 'manifest.json'
        item = json.loads(path.read_text(encoding='utf-8'))
        change(item)
        path.write_text(json.dumps(item), encoding='utf-8')

    def test_current_tree_has_complete_ownership(self):
        self.assertEqual(guard.audit(ROOT), [])

    def test_backend_worker_assets_require_plugin_ownership(self):
        root = self.fixture()
        (root/'xueness/bundled_plugins/browser/undeclared.mjs').write_text('')
        self.assertTrue(any('browser: backend worker assets' in e for e in guard.audit(root)))

    def test_orphan_backend_module_and_unregistered_package_fail(self):
        root = self.fixture()
        (root / 'xueness/bundled_plugins/providers/new_feature.py').write_text('')
        (root / 'xueness/bundled_plugins/future').mkdir()
        errors = guard.audit(root)
        self.assertTrue(any('providers: module ownership mismatch: new_feature' in e for e in errors), errors)
        self.assertTrue(any('package/allowlist mismatch: future' in e for e in errors), errors)

    def test_missing_ui_registry_entry_and_orphan_ui_module_fail(self):
        root = self.fixture()
        path = root / 'webapp/src/xuenessPluginRegistry.ts'
        path.write_text(path.read_text(encoding='utf-8').replace('  providers: { name:', '  omitted: { name:'), encoding='utf-8')
        (root / 'webapp/src/plugins/providers/NewFeature.tsx').write_text('export function NewFeature() {}', encoding='utf-8')
        errors = guard.audit(root)
        self.assertTrue(any('frontend registry/allowlist mismatch' in e for e in errors), errors)
        self.assertTrue(any('unowned frontend feature module' in e for e in errors), errors)

    def test_static_frontend_metadata_can_use_multiline_formatting(self):
        root = self.fixture()
        path = root / 'webapp/src/xuenessPluginRegistry.ts'
        path.write_text(path.read_text(encoding='utf-8').replace('  providers: { name:', '  providers: {\n    name:'), encoding='utf-8')
        self.assertEqual(guard.audit(root), [])

    def test_stale_frontend_export_and_duplicate_contributions_fail(self):
        root = self.fixture()
        self.rewrite(root, 'providers', lambda m: m['frontendModules'].append('plugins/providers/ProvidersPanel.tsx#NoSuchPanel'))
        self.rewrite(root, 'shell', lambda m: m['tools'].append('read'))
        errors = guard.audit(root)
        self.assertTrue(any('missing frontend export' in e for e in errors), errors)
        self.assertIn('tools: multiple owners for read', errors)

    def test_empty_features_panel_drift_and_dependency_cycle_fail(self):
        root = self.fixture()
        self.rewrite(root, 'providers', lambda m: m.update(features=[], panels=[], dependencies=['onboarding']))
        errors = guard.audit(root)
        for part in ['features must describe', 'frontend/backend panel mismatch', 'cyclic plugin dependency']:
            self.assertTrue(any(part in e for e in errors), errors)

    def test_http_family_cannot_be_claimed_by_two_plugins(self):
        root = self.fixture()
        self.rewrite(root, 'usage', lambda m: m.update(httpFamilies=['terminals']))
        self.assertIn('http family: multiple owners for terminals', guard.audit(root))

    def test_overlapping_http_family_patterns_need_one_owner(self):
        root = self.fixture()
        self.rewrite(root, 'memory', lambda m: m.update(httpFamilies=['resources/*']))
        errors = guard.audit(root)
        self.assertTrue(any('http family overlap' in e and 'resources/*' in e and 'memory' in e
                            for e in errors), errors)

    def test_provides_needs_an_activate_hook_and_inject_needs_a_provider(self):
        root = self.fixture()
        self.rewrite(root, 'usage', lambda m: m.update(provides=['usage.collector']))
        self.assertIn('usage: declares provides without activate(scope, ctx)', guard.audit(root))
        self.rewrite(root, 'usage', lambda m: m.update(provides=[], inject=['ghost.service']))
        self.assertIn('usage: injects a service no plugin provides: ghost.service', guard.audit(root))

    def test_lifecycle_field_shapes_are_data_only(self):
        root = self.fixture()
        self.rewrite(root, 'usage', lambda m: m.update(httpFamilies=['*', 'Sessions'], provides=['Usage Service']))
        errors = guard.audit(root)
        for expected in ['usage: invalid httpFamilies pattern *',
                         'usage: invalid httpFamilies pattern Sessions',
                         'usage: invalid provides name Usage Service']:
            self.assertIn(expected, errors)

    def test_a_plugins_subaction_has_one_owner_and_needs_the_seam(self):
        root = self.fixture()
        self.rewrite(root, 'usage', lambda m: m.update(pluginsActions=['validate']))
        self.assertIn('plugins action: multiple owners for validate', guard.audit(root))
        self.rewrite(root, 'usage', lambda m: m.update(pluginsActions=['Not An Action']))
        self.assertIn('usage: invalid pluginsActions name Not An Action', guard.audit(root))
        self.rewrite(root, 'usage', lambda m: m.update(pluginsActions=['audit']))
        self.assertIn('usage: declares pluginsActions without execute_cli(args)', guard.audit(root))

    def test_tool_events_declaration_is_pure_data_with_known_events(self):
        root = self.fixture()
        self.rewrite(root, 'usage', lambda m: m.update(
            toolEvents={'events': ['before_tool_execution', 'after_tool_execution'],
                        'priority': 10}))
        self.assertEqual(guard.audit(root), [])
        for bad in ([],
                    {'events': []},
                    {'events': ['not_an_event']},
                    {'events': ['before_tool_execution', 'before_tool_execution']},
                    {'events': ['before_tool_execution'], 'extra': 1},
                    {'events': ['before_tool_execution'], 'priority': 'high'},
                    {'events': ['before_tool_execution'], 'priority': True},
                    {'events': ['before_tool_execution'], 'priority': 1001}):
            self.rewrite(root, 'usage', lambda m, bad=bad: m.update(toolEvents=bad))
            errors = guard.audit(root)
            self.assertTrue(any('usage: toolEvents' in e for e in errors), bad)

    def test_package_data_files_need_an_explicit_owner_and_a_safe_path(self):
        root = self.fixture()
        (root / 'xueness/bundled_plugins/usage/extra.json').write_text('{}\n', encoding='utf-8')
        self.assertIn('usage: package data files need an explicit owner: extra.json', guard.audit(root))
        self.rewrite(root, 'usage', lambda m: m.update(dataFiles=['../escape.json']))
        self.assertIn('usage: invalid dataFiles path ../escape.json', guard.audit(root))
        self.rewrite(root, 'usage', lambda m: m.update(dataFiles=['never-written.json']))
        self.assertTrue(any('usage:' in e and 'never-written.json' in e for e in guard.audit(root)))

    def rewrite_profiles(self, root, document):
        path = root / 'xueness/bundled_plugins/usage/profiles.json'
        path.write_text(json.dumps(document), encoding='utf-8')
        self.rewrite(root, 'usage', lambda m: m.update(dataFiles=['profiles.json']))
        return guard.audit(root)

    def test_composition_data_may_only_pick_allowlisted_plugins_with_booleans(self):
        root = self.fixture()
        cases = (
            ({'apiVersion': 1, 'profiles': [{'name': 'alpha', 'plugins': {'ghost': True}}]},
             'usage: profile alpha selects an unknown plugin: ghost'),
            ({'apiVersion': 1, 'profiles': [{'name': 'alpha', 'plugins': {'git': 'yes'}}]},
             'usage: profile alpha switch for git must be boolean'),
            ({'apiVersion': 1, 'profiles': [{'name': 'alpha', 'plugins': {'git': True}, 'command': 'git push'}]},
             'usage: profile alpha uses unsupported fields: command'),
            ({'apiVersion': 1, 'profiles': [{'name': 'alpha', 'plugins': {}}]},
             'usage: profile alpha lists no plugin switches'),
            ({'apiVersion': 2, 'profiles': [{'name': 'alpha', 'plugins': {'git': True}}]},
             'usage: profile data profiles.json needs apiVersion 1'),
            ({'apiVersion': 1, 'profiles': [{'name': 'alpha', 'extends': 'alpha', 'plugins': {'git': True}}]},
             'usage: cyclic profile inheritance: alpha -> alpha'),
            ({'apiVersion': 1, 'profiles': [{'name': 'alpha', 'extends': 'nowhere', 'plugins': {'git': True}}]},
             'usage: profile alpha extends an unknown profile: nowhere'),
        )
        for document, expected in cases:
            self.assertIn(expected, self.rewrite_profiles(root, document), json.dumps(document))

    def test_composition_data_refuses_deep_and_oversized_documents(self):
        root = self.fixture()
        depth = guard.MAX_EXTENDS_DEPTH + 2
        rows = [{'name': 'chain%d' % index,
                 'extends': None if index == 0 else 'chain%d' % (index - 1),
                 'plugins': {'git': True}} for index in range(depth)]
        self.assertIn('usage: profile inheritance deeper than %d levels: chain%d'
                      % (guard.MAX_EXTENDS_DEPTH, depth - 1), self.rewrite_profiles(root, {'apiVersion': 1, 'profiles': rows}))

    def test_a_declared_data_file_must_be_readable_json(self):
        root = self.fixture()
        self.rewrite_profiles(root, {'apiVersion': 1, 'profiles': [{'name': 'alpha', 'plugins': {'git': True}}]})
        (root / 'xueness/bundled_plugins/usage/profiles.json').write_text('{not json', encoding='utf-8')
        self.assertIn('usage: data file is not valid JSON: profiles.json', guard.audit(root))

    def test_shipped_profile_data_passes_the_gate(self):
        self.assertEqual(guard.audit(self.fixture()), [])

    def test_business_module_cannot_be_added_to_host(self):
        root = self.fixture()
        (root / 'xueness/new_feature.py').write_text('def run_feature(): pass\n')
        self.assertIn('business code outside plugin package: xueness/new_feature.py', guard.audit(root))

    def test_registered_product_component_still_requires_plugin_directory(self):
        root = self.fixture()
        (root / 'webapp/src/NewProduct.tsx').write_text('export function NewProduct() {}\n')
        self.rewrite(root, 'providers', lambda m: m['frontendModules'].append('NewProduct.tsx'))
        self.assertIn('product component outside plugin directory: NewProduct.tsx', guard.audit(root))

    def test_desktop_native_modules_require_manifest_ownership(self):
        root = self.fixture()
        (root / 'desktop/src/new-feature.cjs').write_text('module.exports = {};\n')
        self.assertIn('unowned desktop feature module: desktop/src/new-feature.cjs', guard.audit(root))

    def test_cli_host_cannot_take_back_feature_implementation(self):
        root = self.fixture()
        path = root / 'xueness/cli.py'
        path.write_text(path.read_text(encoding='utf-8') + '\ndef _register_git_cli(commands):\n    commands.add_parser("new-product")\n', encoding='utf-8')
        self.assertIn('CLI parser must be owned by its plugin: _register_git_cli', guard.audit(root))

    def test_registered_cli_commands_and_manifest_owners_agree(self):
        parser = argparse.ArgumentParser()
        commands = parser.add_subparsers(dest='cmd')
        plugin_runtime.register_cli_parsers(commands)
        manifests = plugin_runtime._manifests()
        declared = {command for row in manifests.values() for command in row['commands']}
        self.assertEqual(set(commands.choices), declared)
        for command in commands.choices:
            owner = plugin_runtime.cli_owner(command)
            self.assertIn(owner, manifests)
            self.assertTrue(callable(getattr(plugin_runtime.entrypoint(owner), 'execute_cli', None)), command)
        names = [tool.name for tool in REGISTRY]
        self.assertEqual(len(names), len(set(names)))
        declared_tools = {name for row in manifests.values() for name in row['tools']}
        self.assertEqual(set(names), declared_tools - {'mcp__*', 'skill_read', 'task'})

    def test_resource_owner_and_runtime_manager_are_distinct(self):
        self.assertEqual(plugin_runtime.cli_owner('resources', argparse.Namespace(kind='plugins')), 'extensions')
        self.assertEqual(plugin_runtime.route_owner(['api', 'resources', 'plugins']), 'extensions')
        with tempfile.TemporaryDirectory() as state:
            plugin_runtime.set_enabled(state, 'extensions', False)
            ctx = {'state_dir': Path(state)}
            code, body = plugin_runtime.dispatch_http('GET', ['api', 'resources', 'plugins'], {}, {}, ctx)
            self.assertEqual(code, 403)
            code, body = plugin_runtime.dispatch_http('GET', ['api', 'plugins'], {}, {}, ctx)
            self.assertEqual(code, 200)
            self.assertEqual({p['id'] for p in body['plugins']}, set(plugin_runtime.PLUGIN_IDS))

    def test_direct_bound_tool_dispatch_cannot_resurrect_disabled_plugin(self):
        root = self.base / 'workspace'; root.mkdir()
        store = Store(self.base / 'state')
        plugin_runtime.set_enabled(store.directory, 'files', False)
        gate = Gate(root, allow_write=True)
        args = {'path': 'blocked.txt', 'content': 'must not write'}
        with bind_execution(store=store, state_dir=store.directory):
            self.assertEqual(dispatch(root, gate, 'write', args), {'ok': False, 'error': 'plugin disabled'})
            self.assertEqual(execute(root, gate, 'write', args), {'ok': False, 'error': 'plugin disabled'})
        self.assertEqual(execute(root, gate, 'write', args, state_dir=store.directory), {'ok': False, 'error': 'plugin disabled'})
        self.assertFalse((root / 'blocked.txt').exists())

    def test_declared_execution_context_without_policy_fails_closed(self):
        root = self.base / 'workspace'; root.mkdir()
        with bind_execution(store=None):
            self.assertEqual(dispatch(root, Gate(root), 'list', {'path': '.'}),
                             {'ok': False, 'error': 'plugin policy unavailable'})


if __name__ == '__main__':
    unittest.main()
