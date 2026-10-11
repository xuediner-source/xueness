"""Offline tests for provider-owned semantic history handoffs."""
import json
import tempfile
import unittest
from pathlib import Path

from xueness.bundled_plugins.providers import semantic_compaction


class HandoffProvider:
    context_window = 32000
    max_output_tokens = 2048

    def __init__(self, *, invalid=False):
        # semantic_compaction copies the adapter so request-local options do
        # not mutate the shared provider; use shared state for instrumentation.
        self.calls = []
        self.invalid = invalid

    def complete(self, messages, _tools):
        self.calls.append(True)
        request = json.loads(messages[-1]['content'])
        coverage = request['requiredCoverage']
        record = {key: [] for key in semantic_compaction.SECTIONS}
        if coverage:
            record['requirements'] = ['Requirement ' + ident for ident in coverage]
        record['coveredMessageIds'] = [] if self.invalid else coverage
        return {'role': 'assistant', 'content': json.dumps(record),
                '_usage': {'prompt_tokens': 30, 'completion_tokens': 12, 'total_tokens': 42}}


class SemanticCompactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)

    def long_session(self):
        messages = [{'role': 'system', 'content': 'system', '_message_id': 'system'}]
        for index in range(4):
            messages.extend([
                {'role': 'user', 'content': f'human request {index}: ' + 'x' * 700,
                 '_message_id': f'user-{index}', '_turn_id': f'turn-{index}'},
                {'role': 'assistant', 'content': f'answer {index}: ' + 'y' * 700,
                 '_message_id': f'assistant-{index}', '_turn_id': f'turn-{index}'},
            ])
        messages.extend([
            {'role': 'user', 'content': 'current request', '_message_id': 'current-user',
             '_turn_id': 'current-turn'},
            {'role': 'assistant', 'content': 'current response', '_message_id': 'current-answer',
             '_turn_id': 'current-turn'},
        ])
        return {'id': 'b' * 32, 'messages': messages, 'archived_messages': [],
                'context_checkpoints': [], 'compactions': []}

    def test_multibatch_handoff_preserves_source_archive_and_live_turn(self):
        session = self.long_session()
        original = json.loads(json.dumps(session['messages']))
        provider = HandoffProvider()
        result = semantic_compaction.before_model_request(
            session, provider, state_dir=self.state, max_chars=5000)
        self.assertTrue(result['changed'])
        self.assertGreater(len(provider.calls), 1)
        self.assertEqual(session['messages'][0]['_message_id'], 'system')
        self.assertEqual(session['messages'][-2:], original[-2:])
        self.assertEqual(session['archived_messages'], original[1:-2])
        checkpoint = session['context_checkpoints'][0]
        self.assertEqual(checkpoint['sourceMessageIds'], [row['_message_id'] for row in original[1:-2]])
        self.assertEqual(set(checkpoint['handoff']['coveredMessageIds']),
                         {f'user-{index}' for index in range(4)})

    def test_invalid_summary_is_atomic_and_cancel_propagates(self):
        invalid = HandoffProvider(invalid=True)
        session = self.long_session()
        original_messages = json.loads(json.dumps(session['messages']))
        original_archive = list(session['archived_messages'])
        result = semantic_compaction.before_model_request(
            session, invalid, state_dir=self.state, max_chars=5000)
        self.assertFalse(result['changed'])
        self.assertEqual(result['reason'], 'summary_failed')
        self.assertEqual(session['messages'], original_messages)
        self.assertEqual(session['archived_messages'], original_archive)
        self.assertEqual(session['context_checkpoints'], [])

        cancelled = self.long_session()
        with self.assertRaises(Exception) as stopped:
            semantic_compaction.before_model_request(
                cancelled, HandoffProvider(), state_dir=self.state, max_chars=5000,
                should_stop=lambda: True)
        self.assertEqual(getattr(stopped.exception, '_xueness_stream_control', None), 'stop')
        self.assertEqual(cancelled['messages'], original_messages)
        self.assertEqual(cancelled['context_checkpoints'], [])


if __name__ == '__main__':
    unittest.main()
