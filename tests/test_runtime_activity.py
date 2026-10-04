"""Live model timing never substitutes character estimates for token usage."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness.core import Store, Gate, run
from xueness.bundled_plugins.providers.activity import RequestActivity, public_activity


class ActivityTests(unittest.TestCase):
    def test_first_output_request_duration_and_real_reported_usage_are_separate(self):
        session = {'steps': 1}
        now = [10.0]
        with patch('xueness.bundled_plugins.providers.activity.time.monotonic', side_effect=lambda: now[0]):
            activity = RequestActivity(session)
            now[0] = 10.5
            activity.delta('思考', reasoning=True)
            now[0] = 11
            activity.delta('hello')
            now[0] = 12
            activity.delta(' world')
            activity.complete({'content': 'hello world'}, {'completion_tokens': 7})
        public = public_activity(session['runtime_activity'])
        self.assertEqual(public['firstOutputSeconds'], 1)
        self.assertEqual(public['firstReasoningSeconds'], 0.5)
        self.assertEqual(public['outputChars'], 11)
        self.assertEqual(public['reportedOutputTokens'], 7)
        self.assertEqual(public['tokensPerSecond'], 3.5)
        self.assertEqual(public['charactersPerSecond'], 5.5)

    def test_no_token_rate_or_first_chunk_is_invented_for_nonstreaming_response(self):
        session = {}
        activity = RequestActivity(session)
        activity.complete({'content': 'text'}, None)
        public = public_activity(session['runtime_activity'])
        self.assertNotIn('reportedOutputTokens', public)
        self.assertNotIn('tokensPerSecond', public)
        self.assertNotIn('firstOutputSeconds', public)
        self.assertNotIn('reasoningChars', public)
        self.assertNotIn('firstReasoningSeconds', public)

    def test_public_metadata_drops_private_values_and_invalid_numbers(self):
        public = public_activity({'phase': 'generating', 'apiKey': 'private', 'content': 'private',
                                  'requestSeconds': float('nan'), 'outputChars': True, 'startedAt': 'private'})
        self.assertEqual(public, {'phase': 'generating'})
        self.assertEqual(public_activity({'phase': 'generating', 'requestSeconds': 10 ** 1000}), {'phase': 'generating'})
        self.assertIsNone(public_activity({'phase': 'arbitrary private phase'}))

    def test_history_has_only_bounded_request_measurements(self):
        session = {}
        for _ in range(30):
            RequestActivity(session).complete({'content': 'private model text'}, {'completion_tokens': 3})
        self.assertEqual(len(session['runtime_activity_history']), 24)
        self.assertNotIn('private model text', json.dumps(session['runtime_activity_history']))

    def test_stream_request_state_is_durable_then_settles_without_claiming_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            store = Store(base / 'state')
            session = store.new('Read README.md in this workspace and summarize it.', base)
            observations = []
            class Provider:
                runtime_profile = 'lightweight'
                def stream(self, messages, tools, on_delta):
                    observations.append(store.load(session['id'])['runtime_activity']['phase'])
                    on_delta('measured output')
                    observations.append(store.load(session['id'])['runtime_activity']['phase'])
                    return {'content': 'measured output', '_usage': {'completion_tokens': 4}}
            result = run(session, store, Provider(), Gate(base), max_steps=1)
            self.assertEqual(observations, ['waiting_model', 'generating'])
            self.assertEqual(result['runtime_activity']['phase'], 'needs_review')
            self.assertEqual(result['completion']['status'], 'unverified')
            self.assertEqual(result['completion']['tool_execution_status'], 'not_applicable')
            self.assertFalse(result['completion']['verified'])
            self.assertEqual(result['runtime_activity']['reportedOutputTokens'], 4)


if __name__ == '__main__':
    unittest.main()
