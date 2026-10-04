"""Durability and races at the actual production queue lock boundary."""
from pathlib import Path
from contextlib import contextmanager
import copy
import json
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from xueness import session_management
from xueness.core import Store
from xueness.bundled_plugins.sessions.queue import MessageQueue, QueueConflict, reconcile_inactive
from xueness.bundled_plugins.sessions.http_routes import _queue_run_lease, _append_queued_turn, host
from xueness.session_lease import lease
from tests.secret_permissions import assert_secret_file_private


class MessageQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'state')
        self.session = self.store.new('你好', Path(self.temp.name))
        self.sid = self.session['id']
        self.queue = MessageQueue(self.store, threading.Lock())
        self.queue.set_accepting(self.sid, True)

    def test_closed_worker_cannot_be_reopened_by_a_late_enqueue(self):
        self.assertFalse(self.queue.close_if_empty(self.sid))
        with self.assertRaises(QueueConflict):
            self.queue.enqueue(self.sid, 'late', active_run=True)
        self.assertEqual(self.queue.snapshot(self.sid)['queued_messages'], [])

    def test_queue_sidecar_is_private(self):
        self.queue.enqueue(self.sid, 'private queued input', active_run=True)
        assert_secret_file_private(self, self.queue._path(self.sid))

    def test_failed_private_file_protection_preserves_old_queue_and_cleans_empty_temp(self):
        self.queue.enqueue(self.sid, 'already durable', active_run=True)
        path = self.queue._path(self.sid)
        old_bytes = path.read_bytes()

        def reject_before_write(fd):
            self.assertEqual(os.fstat(fd).st_size, 0)
            raise OSError('private-file ACL setup failed')

        with patch('xueness.bundled_plugins.sessions.queue._protect_private_file',
                   side_effect=reject_before_write):
            with self.assertRaisesRegex(OSError, 'ACL setup failed'):
                self.queue.enqueue(self.sid, 'must not leak', active_run=True)

        self.assertEqual(path.read_bytes(), old_bytes)
        self.assertEqual(list(self.queue.directory.glob('.queue-*')), [])
        self.assertEqual([item['text'] for item in
                          self.queue.snapshot(self.sid)['queued_messages']],
                         ['already durable'])

    def test_fifo_cancel_and_reopen_preserve_order(self):
        first = self.queue.enqueue(self.sid, 'first', active_run=True)
        cancelled = self.queue.enqueue(self.sid, 'cancel', active_run=True)
        last = self.queue.enqueue(self.sid, 'last', active_run=True)
        self.assertTrue(self.queue.cancel(self.sid, cancelled['id'])['removed'])
        reloaded = MessageQueue(self.store)
        self.assertEqual(reloaded.claim_next(self.sid)['id'], first['id'])
        self.assertEqual(reloaded.cancel(self.sid, first['id']), 'claimed')
        reloaded.update(self.sid, first['id'], 'completed')
        self.assertEqual(reloaded.claim_next(self.sid)['id'], last['id'])

    def test_stale_running_marker_pauses_without_reappending_or_automatically_running(self):
        first = self.queue.enqueue(self.sid, 'first', active_run=True)
        self.queue.claim_next(self.sid)
        reconcile_inactive({'lock': threading.Lock(), 'running': set(), 'store': self.store}, self.queue, self.sid)
        self.assertEqual(self.queue.snapshot(self.sid)['queued_messages'][0]['status'], 'paused')
        self.queue.resume_pending(self.sid, first['id'])
        self.assertIsNone(self.queue.claim_next(self.sid))
        self.assertEqual(len(self.store.load(self.sid)['messages']), 2)  # initial system + user

    def test_cancel_paused_unclaimed_but_preserve_the_claimed_turn(self):
        first = self.queue.enqueue(self.sid, 'first', active_run=True)
        last = self.queue.enqueue(self.sid, 'last', active_run=True)
        self.queue.claim_next(self.sid)
        self.queue.pause_pending(self.sid)
        self.assertEqual(self.queue.cancel(self.sid, first['id'], first['id']), 'claimed')
        self.assertTrue(self.queue.cancel(self.sid, last['id'], first['id'])['removed'])

    def test_plain_context_lock_can_wrap_queue_operations_without_deadlocking(self):
        context_lock = threading.Lock()
        done = threading.Event()
        def inspect():
            with context_lock:
                self.queue.snapshot(self.sid)
                item = self.queue.enqueue(self.sid, 'first', active_run=True)
                self.queue.cancel(self.sid, item['id'])
            done.set()
        thread = threading.Thread(target=inspect, daemon=True)
        thread.start()
        self.assertTrue(done.wait(3), 'queue operation reentered the production context lock')
        thread.join(1)

    def test_rejected_writer_does_not_pause_the_current_owner_queue(self):
        self.queue.enqueue(self.sid, 'first', active_run=True)
        before = self.queue.snapshot(self.sid)
        with host.lease(self.store, self.sid):
            with self.assertRaises(BlockingIOError):
                with _queue_run_lease({'store': self.store}, self.queue, self.sid):
                    self.fail('competing writer acquired the lease')
            self.assertEqual(self.queue.snapshot(self.sid), before)
            self.queue.enqueue(self.sid, 'still accepting', active_run=True)

    def test_owner_closes_queue_before_releasing_the_writer_lease(self):
        self.queue.enqueue(self.sid, 'first', active_run=True)
        real_lease = host.lease
        @contextmanager
        def checked_lease(store, sid):
            with real_lease(store, sid):
                yield
                self.assertEqual(self.queue.snapshot(sid)['queued_messages'][0]['status'], 'paused')
                with self.assertRaises(QueueConflict):
                    self.queue.enqueue(sid, 'too late', active_run=True)
        with patch.object(host, 'lease', checked_lease):
            with _queue_run_lease({'store': self.store}, self.queue, self.sid):
                pass

    def test_prepared_turn_is_saved_once_with_its_marker_and_context(self):
        item = self.queue.enqueue(self.sid, 'raw input', prepared={
            'text': 'expanded input with attachment context',
            'metadata': {'files': [{'path': 'a.txt', 'sha256': 'abc'}]},
        }, active_run=True)
        claimed = self.queue.claim_next(self.sid)
        saves = []
        real_save = self.store.save
        def capture(session):
            saves.append(copy.deepcopy(session))
            real_save(session)
        with patch.object(self.store, 'save', capture):
            _append_queued_turn({'store': self.store}, self.queue, self.session, claimed)
        self.assertEqual(len(saves), 1)
        self.assertEqual(saves[0]['current_queue_item_id'], item['id'])
        self.assertEqual(saves[0]['messages'][-1]['content'], claimed['prepared']['text'])
        self.assertEqual(saves[0]['input_context'][-1]['metadata']['files'][0]['path'], 'a.txt')

    def test_paused_backlog_retains_fifo_position_for_new_items(self):
        self.queue.enqueue(self.sid, 'first', active_run=True)
        self.queue.pause_pending(self.sid)
        second = self.queue.enqueue(self.sid, 'second')
        self.assertEqual(second['position'], 2)
        self.assertEqual(second['status'], 'paused')

    def test_archive_discards_queue_and_restore_does_not_replay_it(self):
        self.queue.enqueue(self.sid, 'discard on archive', active_run=True)
        queue_path = self.queue._path(self.sid)

        with lease(self.store, self.sid):
            session_management.archive(self.store, self.sid)
        self.assertFalse(queue_path.exists())

        with lease(self.store, self.sid):
            session_management.restore(self.store, self.sid)
        self.assertEqual(MessageQueue(self.store).snapshot(self.sid)['queued_messages'], [])
        self.assertFalse(queue_path.exists())

    def test_stale_archive_discards_queue_sidecar(self):
        self.queue.enqueue(self.sid, 'discard on stale archive', active_run=True)
        session = self.store.load(self.sid)
        session['status'] = 'completed'
        self.store.save(session)
        old = time.time() - 10 * 24 * 60 * 60
        os.utime(self.store._path(self.sid), (old, old))
        session_management.mark_viewed(self.store, self.sid)
        marker_path = self.store.directory / '.xueness-session-read' / f'{self.sid}.json'
        marker = json.loads(marker_path.read_text(encoding='utf-8'))
        marker['viewedAt'] = time.time() - 8 * 24 * 60 * 60
        marker_path.write_text(json.dumps(marker), encoding='utf-8')

        self.assertEqual(session_management.archive_stale(self.store, 3), [self.sid])
        self.assertFalse(self.queue._path(self.sid).exists())
