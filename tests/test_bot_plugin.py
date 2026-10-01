"""Channel admission, durable deduplication and explicit outbound review."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from xueness.bundled_plugins.bots import plugin
from xueness.core import Store


class BotPluginTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = (Path(temp.name) / 'work').resolve()
        self.root.mkdir()
        self.state = Path(temp.name) / 'state'
        self.ctx = {'state_dir': self.state, 'store': Store(self.state), 'create_roots': [self.root]}
        self.channel = {'id': 'inbox', 'kind': 'telegram', 'tokenEnv': 'TEST_BOT_TOKEN',
                        'root': str(self.root), 'allowedChats': ['123']}
        status, _ = plugin.dispatch('POST', ['api', 'bots'], {}, self.channel, self.ctx)
        self.assertEqual(status, 200)

    def test_poll_only_imports_allowlisted_text_and_is_idempotent(self):
        rows = [
            {'update_id': 1, 'message': {'chat': {'id': 123}, 'text': 'please review'}},
            {'update_id': 2, 'message': {'chat': {'id': 999}, 'text': 'untrusted denied'}},
            {'update_id': 3, 'message': None},
            {'update_id': 4, 'message': {'chat': None, 'text': 'bad shape'}},
        ]
        with patch.object(plugin, '_request', return_value=rows) as transport:
            first = plugin.poll(self.ctx, 'inbox')
            second = plugin.poll(self.ctx, 'inbox')
        self.assertEqual(first, second)
        self.assertEqual(len(first['inbox']), 1)
        self.assertEqual(len(self.ctx['store'].list()), 1)
        self.assertEqual(transport.call_args.args[2]['offset'], 5)
        session = self.ctx['store'].load(first['inbox'][0]['sessionId'])
        self.assertIn('untrusted external content', session['task'])
        self.assertEqual(session['status'], 'pending')
        self.assertEqual(session['steps'], 0)

    def test_crash_before_offset_write_reconciles_existing_session(self):
        row = {'update_id': 8, 'message': {'chat': {'id': 123}, 'text': 'once'}}
        with patch.object(plugin, '_request', return_value=[row]):
            plugin.poll(self.ctx, 'inbox')
            raw = plugin._load(self.state)
            raw['channels'][0]['offset'] = 0
            raw['inbox'] = []
            plugin._atomic_write_json(plugin._path(self.state), raw)
            result = plugin.poll(self.ctx, 'inbox')
        self.assertEqual(len(result['inbox']), 1)
        self.assertEqual(len(self.ctx['store'].list()), 1)

    def test_reply_requires_review_chat_allowlist_and_bounded_text(self):
        with patch.object(plugin, '_request') as transport:
            for data in ({'chatId': '123', 'text': 'hi'},
                         {'confirmed': True, 'chatId': '999', 'text': 'hi'},
                         {'confirmed': True, 'chatId': '123', 'text': 'x' * 4001}):
                with self.assertRaises(ValueError):
                    plugin.reply(self.ctx, 'inbox', data)
            transport.assert_not_called()
            self.assertEqual(plugin.reply(self.ctx, 'inbox', {
                'confirmed': True, 'chatId': '123', 'text': 'reviewed'}), {'sent': True})
            transport.assert_called_once_with(self.channel, 'sendMessage', {'chat_id': '123', 'text': 'reviewed'})

    def test_config_jails_root_rejects_corruption_and_never_returns_token(self):
        outside = self.root.parent / 'outside'
        outside.mkdir()
        status, _ = plugin.dispatch('POST', ['api', 'bots'], {}, {**self.channel, 'root': str(outside)}, self.ctx)
        self.assertEqual(status, 400)
        with patch.dict(plugin.os.environ, {'TEST_BOT_TOKEN': '123:private-token-value'}):
            status, public = plugin.dispatch('GET', ['api', 'bots'], {}, {}, self.ctx)
        self.assertEqual(status, 200)
        self.assertNotIn('private-token-value', json.dumps(public))
        plugin._path(self.state).write_text('{"channels":[null],"inbox":[]}')
        self.assertEqual(plugin.dispatch('GET', ['api', 'bots'], {}, {}, self.ctx)[0], 400)

    def test_transport_failure_cannot_include_token_or_url(self):
        with patch.dict(plugin.os.environ, {'TEST_BOT_TOKEN': '123:private-token-value'}), \
             patch.object(plugin.urllib.request, 'build_opener', side_effect=OSError('secret URL token')):
            with self.assertRaisesRegex(ValueError, '^bot request failed') as raised:
                plugin._request(self.channel, 'getUpdates', {})
        self.assertNotIn('private', str(raised.exception))
        self.assertNotIn('URL', str(raised.exception))
