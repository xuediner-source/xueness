"""Queue acknowledgement loss must never admit the same request twice."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from xueness import web, plugin_runtime
from xueness.bundled_plugins.sessions.queue import MessageQueue, dispatch


class QueueReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        project = base / 'project'
        project.mkdir()
        self.ctx = web.build_context(base / 'state', base / 'runs', project, allow_real=False)
        self.session = self.ctx['store'].new('initial', project)
        self.sid = self.session['id']
        self.ctx['running'].add(self.sid)
        self.queue = MessageQueue(self.ctx['store'])
        self.queue.set_accepting(self.sid, True)
        self.body = {'text': 'follow up', 'request_id': 'a' * 32}

    def submit(self, **changes):
        return dispatch('POST', ['api', 'sessions', self.sid, 'queue'], {}, {**self.body, **changes}, self.ctx)

    def test_concurrent_replays_are_one_durable_item_after_reopen(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(lambda _: self.submit(), range(8)))
        self.assertTrue(all(code == 202 for code, _ in replies), replies)
        self.assertEqual(len({body['id'] for _, body in replies}), 1)
        self.assertEqual(len(MessageQueue(self.ctx['store']).snapshot(self.sid)['queued_messages']), 1)
        self.assertEqual(sum(bool(body.get('replayed')) for _, body in replies), 7)

    def test_replay_does_not_consume_one_use_prepared_context_again(self):
        prepared = {'text': 'follow up\nattachment', 'metadata': {'modelSelection': {}}, 'edit_prefix': 'follow up'}
        with patch('xueness.bundled_plugins.sessions.http_routes._consume_prepared', return_value=prepared) as consume:
            first = self.submit(prepared_token='once')
            again = self.submit(prepared_token='once')
        self.assertEqual(first[0], 202, first)
        self.assertEqual(again[1]['id'], first[1]['id'])
        self.assertEqual(consume.call_count, 1)
        self.assertNotIn('once', str(self.queue._read(self.sid)))

    def test_replay_after_edit_completion_cancel_or_closed_run_keeps_original_receipt(self):
        for status in ('edited', 'completed', 'cancelled'):
            with self.subTest(status=status):
                self.body['request_id'] = {'edited': 'b', 'completed': 'c', 'cancelled': 'd'}[status] * 32
                first = self.submit()
                item_id = first[1]['id']
                if status == 'edited':
                    self.queue.edit(self.sid, item_id, 'new text', 'follow up')
                elif status == 'completed':
                    self.queue.update(self.sid, item_id, 'completed')
                else:
                    self.queue.cancel(self.sid, item_id)
                again = self.submit()
                self.assertEqual(again[1]['item'], first[1]['item'])
        self.ctx['running'].clear()
        self.queue.pause_pending(self.sid)
        self.assertEqual(self.submit()[0], 202)

    def test_conflicting_identity_and_disabled_plugin_never_replay(self):
        self.assertEqual(self.submit()[0], 202)
        self.assertEqual(self.submit(text='different')[0], 409)
        self.assertEqual(self.submit(prepared_token='different')[0], 409)
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'sessions', False)
        self.assertEqual(self.submit()[0], 403)

    def test_invalid_ids_and_failed_save_leave_no_receipt(self):
        for value in (None, '', True, [], 'x' * 32, 'a' * 100):
            self.assertEqual(self.submit(request_id=value)[0], 400)
        with patch.object(MessageQueue, '_atomic_save', side_effect=OSError('save failed')):
            self.assertNotEqual(self.submit()[0], 202)
        self.assertEqual(self.queue.snapshot(self.sid)['queued_messages'], [])
        self.assertEqual(self.submit()[0], 202)

    def test_identical_text_with_distinct_ids_still_means_distinct_turns(self):
        first = self.submit()
        second = self.submit(request_id='e' * 32)
        self.assertNotEqual(first[1]['id'], second[1]['id'])
        self.assertEqual(len(self.queue.snapshot(self.sid)['queued_messages']), 2)
