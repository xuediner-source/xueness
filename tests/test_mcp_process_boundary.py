"""External transport identity, resource bounds and lifecycle regressions."""
import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from tests.test_mcp import FAKE_SERVER
from xueness import plugin_runtime
from xueness.bundled_plugins.mcp.lifecycle import Pool
from xueness.bundled_plugins.mcp.mcp import McpClient, STDOUT_FRAME_LIMIT
from xueness.bundled_plugins.mcp.plugin import McpPlugin, activate
from xueness.plugin_scope import PluginScope


class McpProcessBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.resources = self.state / 'resources' / 'mcp'
        self.resources.mkdir(parents=True)
        self.script = self.root / 'server.py'
        self.script.write_text(FAKE_SERVER, encoding='utf-8')

    def server(self, log='requests.jsonl', state=None):
        return {'id': 'srv', 'command': sys.executable,
                'args': [str(self.script), str(self.root / log)],
                '_state_dir': str(state or self.state), 'timeout': 2}

    def pool(self):
        pool = Pool(self.root)
        self.addCleanup(pool.close)
        return pool

    def test_pool_replaces_changed_configuration_and_reaps_old_process(self):
        pool = self.pool()
        config = self.server()
        first = pool.get(config)
        proc = first.proc
        self.assertIs(pool.get(dict(config)), first)
        # Mutating the caller's nested argv cannot mutate the live client.
        config['args'][1] = str(self.root / 'replacement.jsonl')
        second = pool.get(config)
        self.assertIsNot(first, second)
        self.assertIsNotNone(proc.poll())
        self.assertTrue(second.call_tool('echo', {'text': 'new'})['ok'])
        self.assertTrue((self.root / 'replacement.jsonl').exists())

    def test_configuration_change_cannot_redirect_discovered_tool(self):
        config = self.server()
        config.pop('_state_dir')
        path = self.resources / 'srv.json'
        path.write_text(json.dumps(config), encoding='utf-8')
        plugin = McpPlugin()
        self.addCleanup(plugin.teardown)
        loaded = plugin.load(self.state, self.root, {})
        proc = plugin._clients['srv'].proc
        config['args'][1] = str(self.root / 'replacement.jsonl')
        path.write_text(json.dumps(config), encoding='utf-8')
        result = loaded['mcp_call']('mcp__srv__echo', {'text': 'approved before change'})
        self.assertFalse(result['ok'])
        self.assertIn('configuration changed', result['error'])
        self.assertIsNotNone(proc.poll())
        self.assertFalse((self.root / 'replacement.jsonl').exists())

    def test_pool_never_reuses_a_transport_bound_to_other_policy_state(self):
        pool = self.pool()
        first = pool.get(self.server())
        proc = first.proc
        second = pool.get(self.server(state=self.root / 'other-state'))
        self.assertIsNot(second, first)
        self.assertIsNotNone(proc.poll())
        self.assertEqual(second.server['_state_dir'], str(self.root / 'other-state'))
        # A former state's scope cannot close a transport now bound elsewhere.
        scope = PluginScope('mcp')
        activate(scope, {'state_dir': self.state})
        scope.dispose()
        self.assertTrue(second.active)

    def test_disabled_plugin_blocks_direct_client_and_reaps_live_child(self):
        client = self.pool().get(self.server())
        proc = client.proc
        plugin_runtime.set_enabled(self.state, 'mcp', False)
        result = client.call_tool('echo', {'text': 'must not execute'})
        self.assertFalse(result['ok'])
        self.assertIn('disabled', result['error'])
        self.assertIsNotNone(proc.poll())
        with self.assertRaises(ValueError):
            self.pool().get(self.server())

    def test_scope_disposal_closes_only_its_state_directory(self):
        owned = self.pool().get(self.server())
        other = self.pool().get(self.server('other.jsonl', self.root / 'other-state'))
        proc = owned.proc
        scope = PluginScope('mcp')
        activate(scope, {'state_dir': self.state})
        scope.dispose()
        self.assertIsNotNone(proc.poll())
        self.assertTrue(other.active)

    def test_malformed_and_oversized_stdout_fail_without_echoing_content(self):
        for source in ("print('PRIVATE_REMOTE_DATA', flush=True)",
                       "print('x' * %d, flush=True)" % (STDOUT_FRAME_LIMIT + 1)):
            with self.subTest(source=source):
                client = McpClient({'id': 'bad', 'command': sys.executable,
                                    'args': ['-c', source], 'timeout': 2}, cwd=self.root)
                self.addCleanup(client.close)
                client.start()
                self.assertFalse(client.active)
                self.assertIsNotNone(client.error)
                self.assertNotIn('PRIVATE_REMOTE_DATA', client.error)
                self.assertLess(len(client.error), 200)

    def test_concurrent_calls_keep_their_own_response(self):
        client = self.pool().get(self.server())
        with ThreadPoolExecutor(max_workers=2) as threads:
            slow = threads.submit(client.call_tool, 'slow', {'seconds': 0.1})
            echo = threads.submit(client.call_tool, 'echo', {'text': 'own reply'})
            self.assertEqual(slow.result()['content'], 'too late')
            self.assertIn('echo:own reply', echo.result()['content'])


if __name__ == '__main__':
    unittest.main()
