"""Current-turn guidance and next-turn promotion stay durable and one-shot."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from xueness import plugin_runtime, web
from xueness.bundled_plugins.sessions import http_routes
from xueness.bundled_plugins.sessions.queue import MessageQueue, QueueConflict
from xueness.bundled_plugins.sessions.steering import (
    SteeringInbox, _fingerprint, before_model_request, dispatch, pending_snapshot,
    release_promotion, reserve_promotion, settle_turn,
)
from xueness.bundled_plugins.subagents.runner import _NullStore
from tests.fake_provider_fixture import inject_provider


class SessionSteeringTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.project = base / 'project'
        self.project.mkdir()
        self.ctx = web.build_context(base / 'state', base / 'runs', self.project,
                                     allow_real=False)
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'sessions', True)
        self.session = self.ctx['store'].new('initial', self.project)
        self.sid = self.session['id']
        self.turn_id = 'turn-1'
        self.session.update(status='running', active_turn_id=self.turn_id)
        self.ctx['store'].save(self.session)
        self.ctx['running'].add(self.sid)
        self.queue = MessageQueue(self.ctx['store'])
        self.queue.set_accepting(self.sid, True)

    def guide(self, text='clarify this', request_id='a' * 32, **extra):
        body = {'text': text, 'expected_turn_id': self.turn_id,
                'request_id': request_id, **extra}
        return dispatch('POST', ['api', 'sessions', self.sid, 'steer'], {},
                        body, self.ctx)

    def promote(self, queue_id, request_id='f' * 32, turn_id=None):
        body = {'expected_turn_id': turn_id or self.turn_id,
                'request_id': request_id}
        return dispatch('POST', ['api', 'sessions', self.sid, 'queue', queue_id,
                                 'send-now'], {}, body, self.ctx)

    def test_guide_admission_replays_one_receipt_and_rejects_stale_or_disabled_requests(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(lambda _: self.guide(), range(8)))
        self.assertTrue(all(status == 202 for status, _ in replies), replies)
        self.assertEqual(len({body['id'] for _, body in replies}), 1)
        self.assertEqual(sum(bool(body.get('replayed')) for _, body in replies), 7)
        self.assertEqual(self.guide(text='different')[0], 409)

        current = self.ctx['store'].load(self.sid)
        current['active_turn_id'] = 'turn-2'
        self.ctx['store'].save(current)
        self.assertEqual(self.guide(request_id='b' * 32)[0], 409)
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'sessions', False)
        self.assertEqual(self.guide(request_id='c' * 32)[0], 403)

    def test_guidance_is_spliced_once_at_model_boundary_with_same_turn_and_metadata(self):
        prepared = {'text': 'clarify this\n\nattached context',
                    'metadata': {'attachments': [{'name': 'note.txt', 'sha256': 'abc'}],
                                 'modelSelection': {}}, 'goal': False}
        with patch('xueness.bundled_plugins.sessions.http_routes._consume_prepared',
                   return_value=prepared) as consume, \
             patch('xueness.bundled_plugins.sessions.http_routes._prepared_remote',
                   return_value=None):
            response = self.guide(prepared_token='one-use-token')
        self.assertEqual(response[0], 202, response)
        self.assertEqual(consume.call_count, 1)

        inbox = SteeringInbox(self.ctx['store'])
        admitted_id = response[1]['id']
        self.assertEqual(before_model_request(self.session, self.ctx['store'],
                                              self.ctx['state_dir']), 1)
        message = self.session['messages'][-1]
        self.assertEqual(message['content'], prepared['text'])
        self.assertEqual(message['_input_id'], admitted_id)
        self.assertEqual(message['_turn_id'], self.turn_id)
        self.assertEqual(message['_composer_metadata'], prepared['metadata'])
        self.assertEqual(inbox.snapshot(self.sid)['queued_messages'], [])

        reloaded = self.ctx['store'].load(self.sid)
        reloaded['active_turn_id'] = self.turn_id
        self.assertEqual(before_model_request(reloaded, self.ctx['store'],
                                              self.ctx['state_dir']), 0)
        self.assertEqual(sum(row.get('_input_id') == admitted_id
                             for row in reloaded['messages']), 1)

    def test_failed_journal_write_rolls_back_memory_and_keeps_input_pending(self):
        response = self.guide()
        self.assertEqual(response[0], 202, response)
        with patch.object(self.ctx['store'], 'save', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'):
                before_model_request(self.session, self.ctx['store'],
                                     self.ctx['state_dir'])
        self.assertFalse(any(row.get('_input_id') == response[1]['id']
                             for row in self.session['messages']))
        snapshot = SteeringInbox(self.ctx['store']).snapshot(self.sid)
        self.assertEqual(snapshot['queued_messages'][0]['id'], response[1]['id'])

    def test_guide_that_misses_its_turn_is_paused_and_never_retargeted(self):
        response = self.guide()
        self.assertEqual(response[0], 202, response)
        self.session['active_turn_id'] = 'turn-2'
        self.assertEqual(before_model_request(self.session, self.ctx['store'],
                                              self.ctx['state_dir']), 0)
        item = SteeringInbox(self.ctx['store']).snapshot(self.sid)['queued_messages'][0]
        self.assertEqual(item['status'], 'paused')
        self.assertEqual(item['targetTurnId'], self.turn_id)
        self.assertFalse(any(row.get('_input_id') == response[1]['id']
                             for row in self.session['messages']))
        settle_turn(self.session, self.ctx['store'], 'turn-0001')
        self.assertEqual(SteeringInbox(self.ctx['store']).snapshot(self.sid)['queued_messages'][0]['status'],
                         'paused')

    def test_orphan_guidance_is_reconciled_and_ephemeral_stores_are_ignored(self):
        self.assertEqual(self.guide()[0], 202)
        stopped = self.ctx['store'].load(self.sid)
        stopped['status'] = 'stopped'
        stopped.pop('active_turn_id', None)
        self.ctx['store'].save(stopped)
        snapshot = pending_snapshot(self.ctx['store'], stopped)
        self.assertEqual(snapshot['pending_guidance'][0]['status'], 'paused')

        ephemeral = _NullStore()
        self.assertEqual(before_model_request(self.session, ephemeral,
                                              self.ctx['state_dir']), 0)
        settle_turn(self.session, ephemeral, self.turn_id)
        self.assertEqual(pending_snapshot(ephemeral, self.session),
                         {'pending_guidance': [], 'guidance_history': []})

    def test_legacy_noncanonical_store_ids_skip_inbox_callbacks(self):
        legacy = {**self.session, 'id': 'session'}
        self.assertEqual(before_model_request(legacy, self.ctx['store'],
                                              self.ctx['state_dir']), 0)
        settle_turn(legacy, self.ctx['store'], self.turn_id)
        self.assertEqual(pending_snapshot(self.ctx['store'], legacy),
                         {'pending_guidance': [], 'guidance_history': []})

    def test_promotion_moves_whole_prepared_item_first_and_replays_after_settlement(self):
        first = self.queue.enqueue(self.sid, 'ordinary', active_run=True)
        prepared = {'text': 'urgent follow-up\n\nattachment bytes',
                    'metadata': {'attachments': [{'name': 'image.png', 'data': 'YQ=='}],
                                 'modelSelection': {'provider_id': 'fixture'}}}
        urgent = self.queue.enqueue(self.sid, 'urgent follow-up', prepared,
                                    active_run=True)
        request_id = '1' * 32
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(lambda _: self.promote(urgent['id'], request_id), range(8)))
        self.assertTrue(all(status == 202 for status, _ in replies), replies)
        self.assertEqual(sum(bool(body.get('replayed')) for _, body in replies), 7)
        self.assertEqual([item['id'] for item in self.queue.snapshot(self.sid)['queued_messages']],
                         [urgent['id'], first['id']])
        with self.assertRaises(QueueConflict):
            self.queue.edit(self.sid, urgent['id'], 'edited', 'urgent follow-up')
        self.assertEqual(self.queue.cancel(self.sid, urgent['id']), 'claimed')
        with self.assertRaises(QueueConflict):
            self.queue.reorder(self.sid, [first['id'], urgent['id']],
                               [urgent['id'], first['id']])

        claimed = self.queue.claim_next(self.sid)
        self.assertEqual(claimed['id'], urgent['id'])
        self.assertEqual(claimed['promotion']['state'], 'claimed')
        self.assertEqual(claimed['prepared'], prepared)
        self.queue.update(self.sid, urgent['id'], 'completed')
        current = self.ctx['store'].load(self.sid)
        current.pop('active_turn_id', None)
        self.ctx['store'].save(current)
        replay = self.promote(urgent['id'], request_id)
        self.assertEqual(replay[0], 202, replay)
        self.assertTrue(replay[1]['replayed'])
        self.assertEqual(replay[1]['id'], urgent['id'])

    def test_promotion_rejects_stale_turn_competitor_and_released_retry(self):
        one = self.queue.enqueue(self.sid, 'one', active_run=True)
        two = self.queue.enqueue(self.sid, 'two', active_run=True)
        self.assertEqual(self.promote(one['id'], turn_id='stale')[0], 409)
        accepted = self.promote(two['id'], request_id='2' * 32)
        self.assertEqual(accepted[0], 202, accepted)
        self.assertEqual(self.promote(one['id'], request_id='3' * 32)[0], 409)
        self.assertTrue(release_promotion(self.queue, self.sid, '2' * 32))
        self.assertEqual(self.promote(two['id'], request_id='2' * 32)[0], 409)
        self.assertEqual([row['id'] for row in self.queue.snapshot(self.sid)['queued_messages']],
                         [one['id'], two['id']])

    def test_run_claims_reserved_item_as_a_new_turn_and_receipt_retry_does_not_repeat_it(self):
        from xueness.core import append_user_turn

        predecessor = self.queue.enqueue(self.sid, 'stopped predecessor', active_run=True)
        promoted = self.queue.enqueue(self.sid, 'explicit next turn', active_run=True)
        stopped = self.ctx['store'].load(self.sid)
        stopped['status'] = 'stopped'
        stopped.pop('active_turn_id', None)
        stopped = append_user_turn(stopped, self.ctx['store'], 'stopped predecessor', None,
                                   queue_message_id=predecessor['id'])
        stopped['status'] = 'stopped'
        stopped.pop('active_turn_id', None)
        self.ctx['store'].save(stopped)
        self.queue.pause_pending(self.sid)
        self.ctx['running'].discard(self.sid)

        request_id = '9' * 32
        reservation_body = {'expected_turn_id': 'turn-1', 'request_id': request_id}
        reserve_promotion(self.queue, self.sid, promoted['id'], request_id,
                          _fingerprint({**reservation_body, 'queue_id': promoted['id']}),
                          'turn-1')
        observed = []

        def complete_once(session, store, provider, gate, steps, max_chars, **kwargs):
            observed.append([row['content'] for row in session['messages']
                             if row.get('role') == 'user'])
            session.update(status='completed', steps=1,
                           completion={'verified': True, 'summary': 'fixture'},
                           pending_question=None, todos=[], hook_log=[])
            store.save(session)
            return session

        class Handler:
            def __init__(self):
                self._ctx = self.ctx
                self.response = None

            def _send(self, status, payload):
                self.response = (status, payload)

        Handler.ctx = self.ctx

        def run_with_receipt():
            handler = Handler()
            handled = http_routes.handle_POST(handler,
                ['api', 'sessions', self.sid, 'run'],
                f'/api/sessions/{self.sid}/run',
                {'provider': 'real', 'steps': 1, 'continue_queue': True,
                 'promotion_request_id': request_id})
            self.assertTrue(handled)
            return handler.response

        with patch('xueness.web.run', side_effect=complete_once), \
             inject_provider(ctx=self.ctx):
            status, body = run_with_receipt()
            self.assertEqual(status, 200, body)
            retry_status, retry_body = run_with_receipt()

        self.assertEqual(retry_status, 200, retry_body)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0].count('stopped predecessor'), 1)
        self.assertEqual(observed[0][-1], 'explicit next turn')
        history = self.queue.snapshot(self.sid)['queue_history']
        self.assertEqual(next(row for row in history if row['id'] == predecessor['id'])['status'], 'cancelled')
        self.assertEqual(next(row for row in history if row['id'] == promoted['id'])['status'], 'completed')


if __name__ == '__main__':
    unittest.main()
