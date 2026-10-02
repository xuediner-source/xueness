"""Exercise recovery boundaries, rather than replaying successful tool work."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness.core import Gate, Store, append_user_turn, run
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
        {'evidence_id': reference, 'observation': 'Directory was listed'}]})}


class EvidenceRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = Store(self.root / 'state')
        self.gate = Gate(self.root)
        self.session = self.store.new('Inspect the directory', self.root)
        self.session['results']['actual'] = {'ok': True}

    def test_manual_resume_does_not_reset_repair_allowance_but_new_turn_does(self):
        out = run(self.session, self.store, Provider([report('invented'), report('invented')]), self.gate)
        self.assertEqual('needs_review', out['status'])
        self.assertEqual(1, out['completion_reference_repairs'])
        resumed = Provider([report('invented')])
        out = run(self.store.load(out['id']), self.store, resumed, self.gate)
        self.assertEqual(1, len(resumed.requests))
        self.assertEqual(1, out['completion_reference_repairs'])
        append_user_turn(out, self.store, 'Correct the final references')
        out = run(out, self.store, Provider([report('invented'), report('E1')]), self.gate)
        self.assertEqual('completed', out['status'])
        self.assertEqual(2, out['completion_reference_repairs'])
        self.assertEqual({'actual'}, set(out['results']))

    def test_process_recovery_restores_pending_targeted_repair(self):
        self.session['completion_reference_repair'] = {'used': True, 'pending': True}
        self.session['completion_reference_repairs'] = 1
        self.store.save(self.session)
        provider = Provider([report('E1')])
        out = run(self.store.load(self.session['id']), self.store, provider, self.gate)
        self.assertEqual('completed', out['status'])
        self.assertTrue(any('Repair only the final JSON' in str(message.get('content')) for message in provider.requests[0]))
        self.assertEqual({'used': True, 'pending': False}, out['completion_reference_repair'])

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
