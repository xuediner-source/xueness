import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.fs_link_helpers import make_symlink
from xueness.core import Store
from xueness.memory import track_paths
from xueness.bundled_plugins.memory import catalog, editor
from xueness.bundled_plugins.settings.settings_store import update_settings
from xueness.plugin_runtime import set_enabled


class MemoryCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.workspace = self.base / 'project'
        self.workspace.mkdir()
        self.memory = self.base / 'memory'
        self.memory.mkdir()
        self.store = Store(self.base / 'sessions')
        self.ctx = {'project_dir': self.workspace, 'state_dir': self.base / 'state',
                    'store': self.store, 'workspace_roots': (self.workspace,)}
        self.env = patch.dict(os.environ, {'XUENESS_MEMORY_ROOT': str(self.memory)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def key(self, root, text):
        target = track_paths(self.memory, str(root.resolve()))['key']
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return target

    def test_catalog_reads_only_present_metadata_and_trusted_workspace_roots(self):
        self.key(self.workspace, 'private memory body')
        other = self.base / 'other'
        self.store.new('other task', other)
        self.key(other, 'other private memory')
        before = {str(p): p.stat().st_mtime_ns for p in self.memory.rglob('*')}
        status, payload = catalog.dispatch('GET', ['api', 'memory', 'workspaces'], {}, {}, self.ctx)
        self.assertEqual(status, 200)
        self.assertEqual({item['id'] for item in payload['workspaces']}, {str(self.workspace), str(other)})
        self.assertNotIn('private memory', str(payload))
        self.assertTrue(all(item['files'][0]['fileName'] == 'KEY.md' for item in payload['workspaces']))
        self.assertEqual(before, {str(p): p.stat().st_mtime_ns for p in self.memory.rglob('*')})

    def test_editor_scope_rejects_arbitrary_root_and_writes_only_selected_track(self):
        self.key(self.workspace, 'current')
        other = self.base / 'other'
        self.store.new('other task', other)
        self.key(other, 'other')
        parts = ['api', 'memory', 'tracks', 'key']
        status, document = editor.dispatch('GET', parts, {'root': [str(other)]}, {}, self.ctx)
        self.assertEqual((status, document['content']), (200, 'other'))
        status, saved = editor.dispatch('POST', parts, {'root': str(other)},
                                       {**document, 'content': 'edited', 'confirmed': True}, self.ctx)
        self.assertEqual((status, saved['content']), (200, 'edited'))
        self.assertEqual(track_paths(self.memory, str(self.workspace))['key'].read_text(), 'current')
        self.assertEqual(editor.dispatch('GET', parts, {'root': str(self.base / 'unknown')}, {}, self.ctx)[0], 400)
        self.assertEqual(editor.dispatch('GET', parts, {'root': ['a', 'b']}, {}, self.ctx)[0], 400)

    def test_catalog_does_not_report_out_of_root_symlinks(self):
        outside = self.base / 'outside.md'
        outside.write_text('private outside')
        make_symlink(self.memory / 'MEMORY.md', outside)
        self.assertEqual(catalog.dispatch('GET', ['api', 'memory', 'workspaces'], {}, {}, self.ctx)[1]['workspaces'], [])

    def test_injection_preference_and_plugin_gate_are_consumed(self):
        self.key(self.workspace, 'project fact')
        self.assertIn('project fact', catalog.load_run_memory(self.ctx, self.workspace))
        update_settings(self.ctx['state_dir'], lambda data: data.setdefault('general', {}).update(memoryEnabled=False))
        self.assertIsNone(catalog.load_run_memory(self.ctx, self.workspace))
        update_settings(self.ctx['state_dir'], lambda data: data['general'].update(memoryEnabled=True))
        set_enabled(self.ctx['state_dir'], 'memory', False)
        self.assertIsNone(catalog.load_run_memory(self.ctx, self.workspace))


if __name__ == '__main__':
    unittest.main()
