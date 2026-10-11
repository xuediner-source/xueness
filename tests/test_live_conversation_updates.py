"""Real HTTP snapshot/patch updates with reconnect and plugin lifecycle."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from xueness import web, plugin_runtime
from xueness.bundled_plugins.sessions.history import apply


class ConversationUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.ctx = web.build_context(base / 'state', base / 'runs', base, allow_real=False)
        self.session = self.ctx['store'].new('fixture conversation', base)
        self.server = web.create_server(0, self.ctx)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/api/sessions/{self.session["id"]}/updates'

    def tearDown(self):
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'sessions', False)
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def open_stream(self):
        return urllib.request.urlopen(urllib.request.Request(self.url, headers={'Accept': 'text/event-stream'}), timeout=8)

    def read_event(self, response):
        event = None
        while True:
            raw = response.readline()
            if not raw:
                self.fail('stream ended before the expected event')
            text = raw.decode('utf-8').strip()
            if text.startswith('event: '):
                event = text[7:]
            if text.startswith('data: '):
                return event, json.loads(text[6:])

    def test_non_stream_clients_receive_complete_snapshot(self):
        with urllib.request.urlopen(self.url, timeout=8) as response:
            snapshot = json.load(response)
        self.assertEqual(snapshot['session']['id'], self.session['id'])
        self.assertEqual(snapshot['journal']['messages'], self.session['messages'])

    def test_incremental_patch_and_reconnect_rebase_authoritatively(self):
        with self.open_stream() as response:
            name, initial = self.read_event(response)
            self.assertEqual(name, 'conversation.snapshot')
            s = self.ctx['store'].load(self.session['id'])
            s['messages'].append({'role': 'assistant', 'content': 'streamed reply'})
            self.ctx['store'].save(s)
            name, patch = self.read_event(response)
            self.assertEqual(name, 'conversation.patch')
            self.assertEqual(patch['baseRevision'], initial['revision'])
            self.assertGreater(patch['revision'], initial['revision'])
            updated = apply(initial['snapshot'], patch['operations'])
            self.assertEqual(updated['journal']['messages'][-1]['content'], 'streamed reply')
        with self.open_stream() as response:
            name, reconnected = self.read_event(response)
            self.assertEqual(name, 'conversation.snapshot')
            self.assertEqual(reconnected['snapshot']['journal']['messages'], updated['journal']['messages'])

    def test_disabled_plugin_refuses_new_stream(self):
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'sessions', False)
        with self.assertRaises(urllib.error.HTTPError) as refused:
            self.open_stream()
        self.assertEqual(refused.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
