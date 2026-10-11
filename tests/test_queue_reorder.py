"""Reordering cannot lose pending context or race a worker's claim."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from xueness import web, plugin_runtime
from xueness.bundled_plugins.sessions.queue import MessageQueue, dispatch


class QueueReorderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        root = base / 'workspace'
        root.mkdir()
        self.ctx = web.build_context(base / 'state', base / 'runs', root, allow_real=False)
        self.session = self.ctx['store'].new('fixture', root)
        self.sid = self.session['id']
        self.queue = MessageQueue(self.ctx['store'])
        self.queue.set_accepting(self.sid, True)
        self.ids = [self.queue.enqueue(self.sid, text, {'text': text + '\nattachment', 'metadata': {'fixture': text}})['id']
                    for text in ('one', 'two', 'three')]

    def request(self, ids, expected=None):
        return dispatch('PATCH', ['api', 'sessions', self.sid, 'queue'], {},
                        {'ids': ids, 'expectedIds': self.ids if expected is None else expected}, self.ctx)

    def test_reorder_survives_reopen_and_preserves_prepared_context(self):
        previous = {item_id: self.queue.get(self.sid, item_id) for item_id in self.ids}
        order = self.ids[::-1]
        self.assertEqual(self.request(order), (200, {'ids': order}))
        reopened = MessageQueue(self.ctx['store'])
        self.assertEqual([row['id'] for row in reopened.snapshot(self.sid)['queued_messages']], order)
        for item_id in order:
            self.assertEqual(reopened.get(self.sid, item_id), previous[item_id])
            self.assertEqual(reopened.claim_next(self.sid)['id'], item_id)

    def test_stale_claim_cancel_or_reorder_rejects_without_changing_items(self):
        for mutation in ('claim', 'cancel', 'reorder'):
            with self.subTest(mutation=mutation):
                with patch.object(self.queue, '_read', wraps=self.queue._read):
                    if mutation == 'claim':
                        self.queue.claim_next(self.sid)
                    elif mutation == 'cancel':
                        self.queue.cancel(self.sid, self.ids[1])
                    else:
                        self.queue.update(self.sid, self.ids[0], 'queued')
                        self.queue.update(self.sid, self.ids[1], 'queued')
                        actual = [row['id'] for row in self.queue.snapshot(self.sid)['queued_messages']]
                        self.queue.reorder(self.sid, actual[::-1], actual)
                    before = self.queue._read(self.sid)
                    self.assertEqual(self.request(self.ids[::-1])[0], 409)
                    self.assertEqual(self.queue._read(self.sid), before)

    def test_claimed_paused_turn_is_fixed_and_other_paused_turns_can_move(self):
        self.queue.pause_pending(self.sid)
        self.session['current_queue_item_id'] = self.ids[0]
        self.ctx['store'].save(self.session)
        self.assertEqual(self.request(self.ids[::-1])[0], 409)
        self.assertEqual(self.request(self.ids[:0:-1], self.ids[1:])[0], 200)
        self.assertEqual([item['id'] for item in self.queue.snapshot(self.sid)['queued_messages']],
                         [self.ids[0], self.ids[2], self.ids[1]])

    def test_competing_reorders_commit_only_one_snapshot(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.request, [self.ids[::-1], self.ids[1:] + self.ids[:1]]))
        self.assertEqual(sorted(code for code, _ in results), [200, 409])

    def test_invalid_payload_disabled_plugin_and_failed_save_leave_queue_intact(self):
        before = self.queue._read(self.sid)
        for ids in (None, [True], [self.ids[0]] * 3, ['x' * 32], self.ids[:2]):
            self.assertEqual(self.request(ids)[0], 400)
        with patch.object(MessageQueue, '_atomic_save', side_effect=OSError('disk full')):
            self.assertEqual(self.request(self.ids[::-1])[0], 503)
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'sessions', False)
        self.assertEqual(self.request(self.ids[::-1])[0], 403)
        self.assertEqual(self.queue._read(self.sid), before)
