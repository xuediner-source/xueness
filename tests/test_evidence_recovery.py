"""Exercise recovery boundaries, rather than replaying successful tool work."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness.core import Gate, Store, append_user_turn, execute, run
from xueness.web import pending_denials


class Provider:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def complete(self, messages, tools):
        self.requests.append(messages)
        return next(self.responses)


def report(reference):
    return {'content': json.dumps({'summary': 'Inspected', 'evidence': [
        {'evidence_id': reference, 'observation': 'README.md content was returned'}]})}


def read_call(call_id):
    return {'content': '', 'tool_calls': [{
        'id': call_id, 'type': 'function',
        'function': {'name': 'read', 'arguments': json.dumps({'path': 'README.md'})},
    }]}


class EvidenceRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = Store(self.root / 'state')
        self.gate = Gate(self.root)
        (self.root / 'README.md').write_text('A fixture project.\n', encoding='utf-8')
        self.session = self.store.new(
            'Read README.md in this workspace and summarize it.', self.root)

    def record_successful_read(self, session, call_id='actual'):
        call = read_call(call_id)['tool_calls'][0]
        result = execute(self.root, self.gate, 'read', {'path': 'README.md'}, session)
        self.assertTrue(result.get('ok'), result)
        session['messages'].append({'role': 'assistant', 'content': '', 'tool_calls': [call]})
        session['results'][call_id] = result
        session['messages'].append({
            'role': 'tool', 'tool_call_id': call_id,
            'content': json.dumps(result, ensure_ascii=False),
        })
        return result

    def test_manual_resume_does_not_reset_repair_allowance_but_new_turn_does(self):
        out = run(self.session, self.store,
                  Provider([read_call('actual'), report('invented'), report('invented')]), self.gate)
        self.assertEqual('needs_review', out['status'])
        self.assertEqual(1, out['completion_reference_repairs'])
        resumed = Provider([report('invented')])
        out = run(self.store.load(out['id']), self.store, resumed, self.gate)
        self.assertEqual(1, len(resumed.requests))
        self.assertEqual(1, out['completion_reference_repairs'])
        append_user_turn(out, self.store, 'Correct the final references')
        out = run(out, self.store,
                  Provider([read_call('actual-new'), report('invented'), report('E2')]), self.gate)
        self.assertEqual('completed', out['status'])
        self.assertEqual(2, out['completion_reference_repairs'])
        self.assertEqual({'actual', 'actual-new'}, set(out['results']))

    def test_process_recovery_restores_pending_targeted_repair(self):
        self.record_successful_read(self.session)
        self.session['completion_reference_repair'] = {'used': True, 'pending': True}
        self.session['completion_reference_repairs'] = 1
        self.store.save(self.session)
        provider = Provider([report('E1')])
        out = run(self.store.load(self.session['id']), self.store, provider, self.gate)
        self.assertEqual('completed', out['status'])
        self.assertTrue(any('Repair only the final evidence references' in str(message.get('content')) for message in provider.requests[0]))
        self.assertEqual({'used': True, 'pending': False}, out['completion_reference_repair'])
        self.assertEqual('verified', out['completion']['status'])

    def test_policy_refusal_stops_and_cannot_be_approved(self):
        self.gate.denied_tool_names = {'read'}
        call = {'id': 'policy', 'type': 'function', 'function': {'name': 'read', 'arguments': '{"path":"secret.txt"}'}}
        provider = Provider([{'content': '', 'tool_calls': [call]}])
        with patch('xueness.core.dispatch') as dispatch:
            out = run(self.session, self.store, provider, self.gate)
        dispatch.assert_not_called()
        self.assertEqual('needs_review', out['status'])
        self.assertEqual('permission_denied', out['pause_code'])
        self.assertEqual([], pending_denials(out))
        self.assertEqual(1, len(provider.requests))
