"""Replay, crash recovery and identity invariants of the session revisions."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from xueness.core import Store, _ensure_message_identity
from xueness.events import derive_events
from xueness.bundled_plugins.sessions import history


class StableHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'state')
        self.session = self.store.new('Inspect the workspace', Path(self.temp.name))

    def test_replay_retains_edits_and_removed_messages_with_stable_ids(self):
        s = self.session
        s['messages'].append({'role': 'assistant', 'content': 'old reply'})
        self.store.save(s)
        saved = copy.deepcopy(s['messages'])
        s['messages'][-1]['content'] = 'edited reply'
        self.store.save(s)
        revision_after_edit = s['history_revision']
        s['archived_messages'] = s['messages'][1:]
        s['messages'] = [s['messages'][0], {'role': 'user', 'content': 'continue'}]
        self.store.save(s)
        page = history.page(self.store, s['id'])
        replay = {}
        edited = None
        saw_original = False
        for row in page['records']:
            replay = history.apply(replay, row['operations'])
            saw_original |= any(m.get('content') == 'old reply' for m in replay.get('messages', []))
            if row['seq'] == revision_after_edit:
                edited = copy.deepcopy(replay)
        self.assertTrue(saw_original)
        self.assertEqual(edited['messages'][-1]['content'], 'edited reply')
        self.assertEqual(edited['messages'][-1]['_message_id'], saved[-1]['_message_id'])
        self.assertEqual(replay, history.content(s))
        self.assertEqual(s['messages'][-1]['_turn_id'], 'turn-2')

    def test_compacted_history_does_not_reuse_old_turn_numbers(self):
        s = self.session
        s.update(_turn_count=12, messages=[{'role': 'system', 'content': 'checkpoint'},
                                         {'role': 'user', 'content': 'retained', '_turn_id': 'turn-9'},
                                         {'role': 'user', 'content': 'new'}])
        _ensure_message_identity(s)
        self.assertEqual(s['messages'][-1]['_turn_id'], 'turn-13')
        original = copy.deepcopy(s['messages'])
        _ensure_message_identity(s)
        self.assertEqual(s['messages'], original)

    def test_torn_tail_is_repaired_without_losing_prior_revisions(self):
        s = self.session
        before = history.page(self.store, s['id'])['head']
        path = self.store.directory / (s['id'] + '.history.jsonl')
        with path.open('ab') as stream:
            stream.write(b'{"schema":"unfinished')
        s['status'] = 'paused'
        self.store.save(s)
        page = history.page(self.store, s['id'], before)
        self.assertFalse(page['resync'])
        self.assertEqual(len(page['records']), 1)
        self.assertTrue(path.read_bytes().endswith(b'\n'))

    def test_failed_publication_is_reconciled_by_explicit_reset(self):
        s = self.session
        before = s['history_revision']
        s['status'] = 'paused'
        with mock.patch.object(history, 'commit', side_effect=OSError('publication failed')):
            with self.assertRaises(OSError):
                self.store.save(s)
        # The compatibility checkpoint was committed; repair is never hidden
        # as an ordinary continuation of a cursor that missed the fact.
        page = history.page(self.store, s['id'], before)
        self.assertTrue(page['resync'])
        self.assertTrue(page['records'][0]['reset'])
        self.assertEqual(page['records'][0]['operations'][0]['value']['status'], 'paused')

    def test_same_size_corruption_is_detected_after_cache_warmup(self):
        s = self.session
        history.page(self.store, s['id'])
        path = self.store.directory / (s['id'] + '.history.jsonl')
        raw = path.read_bytes()
        path.write_bytes(raw.replace(b'Inspect the workspace', b'Corrupt the workspace'))
        with self.assertRaises(ValueError):
            history.page(self.store, s['id'])

    def test_guidance_keeps_tools_and_completions_in_the_human_turn(self):
        s = self.session
        s['messages'] += [{'role': 'assistant', 'content': 'first'},
                          {'role': 'user', 'content': 'guide', '_input_kind': 'guide'},
                          {'role': 'assistant', 'content': 'guided'},
                          {'role': 'user', 'content': 'next'},
                          {'role': 'assistant', 'content': 'second'}]
        _ensure_message_identity(s)
        s['completion_history'] = [{'turn_id': 'turn-1', 'summary': 'settled'}]
        events = derive_events(s)
        replies = [e for e in events if e['type'] == 'assistant.text']
        self.assertEqual([e['turnId'] for e in replies], ['turn-1', 'turn-1', 'turn-2'])
        self.assertEqual([e['turnId'] for e in events if e['type'] == 'turn.user'], ['turn-1', 'turn-2'])
        completion_at = next(i for i, e in enumerate(events) if e['type'] == 'session.completion')
        self.assertGreater(completion_at, next(i for i, e in enumerate(events) if e.get('preview') == 'guided'))


if __name__ == '__main__':
    unittest.main()
