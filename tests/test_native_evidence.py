"""Native completion stays Markdown without weakening current-turn evidence."""
import unittest
from xueness.core import assess, Gate, run
from xueness.plugin_runtime import set_enabled
from tests import test_lightweight_runtime as fixtures


class NativeEvidenceTests(unittest.TestCase):
    setUp = fixtures.LightweightTests.setUp
    session = fixtures.LightweightTests.session

    def test_real_successful_reference_preserves_markdown(self):
        answer = 'Read **truth**.\n\nEvidence: E1'
        result = assess(answer, {'c': {'ok': True}}, {'E1': 'c'}, native_references=True)
        self.assertTrue(result['verified'])
        self.assertEqual('Read **truth**.', result['summary'])
        self.assertEqual('c', result['evidence'][0]['tool_call_id'])

    def test_failed_ineligible_unknown_or_previous_turn_ids_do_not_verify(self):
        for results, aliases in (({'c': {'ok': False}}, {'E1': 'c'}),
                                 ({'c': {'ok': True, 'evidence_eligible': False}}, {'E1': 'c'}),
                                 ({'c': {'ok': True}}, {})):
            result = assess('Done\nEvidence: E1', results, aliases, native_references=True)
            self.assertFalse(result['verified'])
            self.assertEqual('invalid_evidence_reference', result['error_code'])

    def test_footer_examples_quoted_code_and_duplicates_are_preserved(self):
        for content in ('```text\nEvidence: E1', 'Example\n> Evidence: E1',
                        'Example\nEvidence: E1\nMore text', 'Example\nEvidence: E1\nEvidence: E2',
                        'Example\nEvidence: E1,E1', 'Evidence: E1'):
            result = assess(content, {'c': {'ok': True}}, {'E1': 'c'}, native_references=True)
            self.assertFalse(result['verified'])
            self.assertEqual(content, result['summary'])

    def test_footer_is_opt_in_and_does_not_create_evidence_for_json_mode(self):
        content = 'Example\nEvidence: E1'
        self.assertFalse(assess(content, {'c': {'ok': True}}, {'E1': 'c'})['verified'])

    def test_real_host_loop_hides_footer_and_completes(self):
        (self.root/'a').write_text('truth')
        provider = fixtures.ScriptedProvider([fixtures.call('read', {'path': 'a'}),
            {'content': 'Read truth.\n\nEvidence: E1'}])
        result = run(self.session(), self.store, provider, self.gate)
        self.assertEqual('completed', result['status'])
        self.assertTrue(result['completion']['verified'])
        self.assertEqual('Read truth.', result['messages'][-1]['content'])

    def test_wrong_footer_reference_has_one_bounded_repair_without_redo(self):
        (self.root/'a').write_text('truth')
        provider = fixtures.ScriptedProvider([fixtures.call('read', {'path': 'a'}),
            {'content': 'Read truth.\nEvidence: E99'}, {'content': 'Read truth.\nEvidence: E1'}])
        result = run(self.session(), self.store, provider, self.gate)
        self.assertEqual('completed', result['status'])
        self.assertEqual(1, len(result['results']))
        self.assertIn('Do not call tools', provider.requests[-1][0][0]['content'])

    def test_disabled_sessions_cannot_use_native_footer_to_verify(self):
        (self.root/'a').write_text('truth')
        set_enabled(self.store.directory, 'sessions', False)
        provider = fixtures.ScriptedProvider([fixtures.call('read', {'path': 'a'}),
            {'content': 'Read truth.\nEvidence: E1'}])
        result = run(self.session(), self.store, provider, Gate(self.root))
        self.assertFalse(result['completion']['verified'])
        self.assertEqual('needs_review', result['status'])


if __name__ == '__main__':
    unittest.main()
