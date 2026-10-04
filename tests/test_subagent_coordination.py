"""Real parent driver regressions using isolated, deterministic providers."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from xueness.core import Gate, Store, run, evidence_aliases, assess
from xueness import plugin_runtime
from xueness.bundled_plugins.subagents.coordinator import TaskCoordinator, completion_check


def call(cid, name, args):
    return {'content': '', 'tool_calls': [{'id': cid, 'type': 'function',
             'function': {'name': name, 'arguments': json.dumps(args)}}]}


class CoordinationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'workspace'
        self.root.mkdir()
        (self.root / 'local.txt').write_text('independent inspection', encoding='utf-8')
        self.store = Store(Path(self.temp.name) / 'state')
        self.session = self.store.new('inspect and delegate', self.root)

    def test_parent_runs_own_tool_while_child_is_blocked_then_collects(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        parent_steps = []

        def child(*args, **kwargs):
            started.set()
            self.assertTrue(release.wait(3), 'parent never made independent progress')
            return {'ok': True, 'summary': 'bounded child findings', 'steps': 1}

        class Provider:
            def complete(_, messages, tools):
                parent_steps.append(len(parent_steps) + 1)
                if len(parent_steps) == 1:
                    return call('spawn', 'task', {'prompt': 'child inspection'})
                if len(parent_steps) == 2:
                    self.assertTrue(started.wait(1))
                    self.assertFalse(release.is_set())
                    return call('own', 'read', {'path': 'local.txt'})
                if len(parent_steps) == 3:
                    self.assertTrue(self.session['results']['own']['ok'])
                    self.assertNotIn('spawn', evidence_aliases(self.session).values())
                    release.set()
                    return call('collect', 'task_collect', {'wait_seconds': 2,
                                'reason': 'dependency', 'detail': 'Need the review to combine the answer.'})
                return {'content': json.dumps({'summary': 'integrated findings', 'evidence': [
                    {'tool_call_id': 'own', 'observation': 'Read the local file.'}]})}

        with patch('xueness.core._run_subagent', side_effect=child):
            out = run(self.session, self.store, Provider(), Gate(self.root), subagents=[], max_steps=4)
        self.assertEqual(out['status'], 'completed')
        self.assertEqual(out['completion']['delivery_checks']['subagents']['status'], 'passed')
        self.assertEqual(out['results']['collect']['tasks'][0]['summary'], 'bounded child findings')
        self.assertEqual(out['task_runs'][0]['status'], 'completed')
        self.assertEqual(parent_steps, [1, 2, 3, 4])
        self.assertNotIn('sub-', json.dumps(out['messages']))
        self.assertFalse(out['results']['collect']['evidence_eligible'])
        self.assertNotIn('collect', evidence_aliases(out).values())

    def test_final_answer_cannot_skip_collection_and_budget_cancels_child(self):
        started, exited = threading.Event(), threading.Event()

        def child(*args, **kwargs):
            started.set()
            while not kwargs['parent_should_stop']():
                exited.wait(.01)
            exited.set()
            return {'ok': False, 'error': 'cancelled'}

        class Provider:
            steps = 0
            def complete(_, messages, tools):
                _.steps += 1
                if _.steps == 1:
                    return call('spawn', 'task', {'prompt': 'blocked child'})
                self.assertTrue(started.wait(1))
                return {'content': json.dumps({'summary': 'premature done', 'evidence': [
                    {'tool_call_id': 'spawn', 'observation': 'dispatched'}]})}

        with patch('xueness.core._run_subagent', side_effect=child):
            out = run(self.session, self.store, Provider(), Gate(self.root), subagents=[], max_steps=3)
        self.assertEqual(out['status'], 'paused')
        self.assertIsNone(out['completion'])
        self.assertEqual(out['pause_code'], 'subagent_results_uncollected')
        self.assertEqual(out['steps'], 3)
        self.assertEqual(out['task_runs'][0]['status'], 'cancelled')
        self.assertTrue(exited.wait(1))
        self.assertNotIn('premature done', json.dumps(out['messages']))

    def test_concurrency_cap_parent_stop_and_unknown_task_isolation(self):
        c = TaskCoordinator(self.session)
        self.addCleanup(c.close)
        started = threading.Condition()
        count = [0]

        def child(tid, stop):
            with started:
                count[0] += 1
                started.notify_all()
            while not stop():
                threading.Event().wait(.01)
            return {'ok': False, 'error': 'cancelled'}

        for index in range(4):
            self.assertTrue(c.dispatch(str(index), {'prompt': 'inspect'}, child)['ok'])
        with started:
            self.assertTrue(started.wait_for(lambda: count[0] == 4, timeout=1))
        self.assertFalse(c.dispatch('5', {'prompt': 'inspect'}, child)['ok'])
        self.assertFalse(c.collect({'task_ids': ['task-other-session']})['ok'])
        self.assertFalse(c.collect({'wait_seconds': 1})['ok'])
        self.assertNotIn('subagent_wait', self.session)
        c.close()
        self.assertEqual({row['status'] for row in c.registry.list()}, {'cancelled'})

    def test_plugin_disabled_during_run_cancels_child_no_new_calls(self):
        started, exited = threading.Event(), threading.Event()
        def child(*args, **kwargs):
            started.set()
            while not kwargs['parent_should_stop']():
                exited.wait(.01)
            exited.set()
            return {'ok': False, 'error': 'cancelled'}
        class Provider:
            steps = 0
            def complete(_, messages, tools):
                _.steps += 1
                if _.steps == 1:
                    return call('spawn', 'task', {'prompt': 'inspect'})
                self.assertTrue(started.wait(1))
                plugin_runtime.set_enabled(self.store.directory, 'subagents', False)
                return call('second', 'task', {'prompt': 'must not run'})
        with patch('xueness.core._run_subagent', side_effect=child) as spy:
            out = run(self.session, self.store, Provider(), Gate(self.root), subagents=[], max_steps=3)
        self.assertEqual(spy.call_count, 1)
        self.assertEqual(out['results']['second']['error_code'], 'plugin_disabled')
        self.assertEqual(out['task_runs'][0]['status'], 'cancelled')
        self.assertTrue(exited.wait(1))

    def test_child_failure_is_not_delivery_success(self):
        self.session['messages'].append({'role': 'assistant', **call('one', 'task', {'prompt': 'inspect'})})
        c = TaskCoordinator(self.session)
        self.addCleanup(c.close)
        c.dispatch('one', {'prompt': 'inspect'}, lambda tid, stop: {'ok': False, 'error': 'provider failed'})
        result = c.collect({'wait_seconds': 1, 'reason': 'no_independent_work', 'detail': 'Only the review remains.'})
        self.assertFalse(result['ok'])
        self.assertEqual(result['tasks'][0]['status'], 'failed')
        self.assertEqual(completion_check(self.session)['status'], 'failed')
        self.assertEqual(self.session['subagent_wait']['reason'], 'no_independent_work')

    def test_pending_dispatch_cannot_be_cited_even_by_real_call_id(self):
        result = {'ok': True, 'evidence_eligible': False}
        report = json.dumps({'summary': 'done', 'evidence': [
            {'tool_call_id': 'spawn', 'observation': 'claimed finding'}]})
        self.assertFalse(assess(report, {'spawn': result})['verified'])

    def test_saved_completed_result_is_collectable_without_replaying_child(self):
        self.session['messages'].append({'role': 'assistant', **call('old', 'task', {'prompt': 'inspect'})})
        self.session['subagent_coordination'] = {'task-saved': {'call_id': 'old', 'collected': False}}
        self.session['task_runs'] = [{'id': 'task-saved', 'status': 'completed',
                                     'summary': 'saved result', 'steps': 2, 'error': ''}]
        c = TaskCoordinator(self.session)
        self.addCleanup(c.close)
        result = c.collect({})
        self.assertEqual(result['tasks'][0]['summary'], 'saved result')
        self.assertEqual(result['tasks'][0]['error'], '')
        self.assertEqual(completion_check(self.session)['status'], 'passed')
        self.assertFalse(c._workers)

    def test_new_human_turn_does_not_inherit_old_failed_delivery(self):
        self.session['messages'].append({'role': 'assistant', **call('old', 'task', {'prompt': 'inspect'})})
        self.session['subagent_coordination'] = {'task-old': {'call_id': 'old', 'collected': False}}
        self.session['task_runs'] = [{'id': 'task-old', 'status': 'cancelled'}]
        self.session['messages'].append({'role': 'user', 'content': 'new question'})
        self.assertEqual(completion_check(self.session)['status'], 'not_assessed')

    def test_lightweight_minimal_window_keeps_collection_available(self):
        from xueness.bundled_plugins.providers.lightweight import select_tools
        from xueness.bundled_plugins.subagents.tools import REGISTRY
        self.session['subagent_coordination'] = {'task-one': {'call_id': 'one', 'collected': False}}
        class Provider:
            lightweight_options = {'initialTools': 'minimal'}
            context_window = 2048
            max_output_tokens = 256
        catalog, active = select_tools([REGISTRY[0].schema()], self.session, Gate(self.root), Provider())
        self.assertEqual([row['function']['name'] for row in active], ['task_collect'])

    def test_compaction_cannot_hide_uncollected_task_on_resume(self):
        self.session['subagent_coordination'] = {'task-archived': {
            'call_id': 'archived-call', 'collected': False, 'turn': 1}}
        self.session['task_runs'] = [{'id': 'task-archived', 'status': 'completed',
                                     'summary': 'archived finding', 'steps': 1}]
        # The task call is no longer in the compacted prompt; its durable turn
        # marker still prevents the next run from silently dropping the result.
        c = TaskCoordinator(self.session)
        self.addCleanup(c.close)
        self.assertIn('task-archived', c.completion_guidance())
        self.assertEqual(c.collect({})['tasks'][0]['summary'], 'archived finding')
        self.assertEqual(completion_check(self.session)['status'], 'passed')


if __name__ == '__main__':
    unittest.main()
