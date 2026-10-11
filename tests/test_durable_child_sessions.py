"""Offline recovery and parent-isolation regressions for durable subagent children."""
import json
from pathlib import Path
import tempfile
import time
import unittest
import uuid

from xueness import plugin_runtime, web
from xueness.core import Gate, Store
from xueness.bundled_plugins.subagents.child_sessions import (
    ChildStore, apply_messages, enqueue_message, prepare_resume, projection,
    recovery_info,
)
from xueness.bundled_plugins.subagents.coordinator import TaskCoordinator
from xueness.bundled_plugins.subagents.task_registry import TaskRegistry
from xueness.bundled_plugins.subagents.runner import run_subagent


class DurableChildSessionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state = base / 'state'
        self.root = base / 'workspace'
        self.root.mkdir()
        self.store = Store(self.state)
        self.parent = self.store.new('parent task', self.root)
        self.sid = self.parent['id']

    def child(self, task_id='task-retained', *, status='completed', messages=None,
              results=None, cancelled=False, root=None):
        row = {
            'id': uuid.uuid4().hex,
            'task': 'inspect the workspace',
            'root': str(root or self.root),
            'status': status,
            'messages': messages or [
                {'role': 'system', 'content': 'read only'},
                {'role': 'user', 'content': 'inspect'},
                {'role': 'assistant', 'content': 'findings'},
            ],
            'results': results or {},
            'compactions': [], 'archived_messages': [], 'steps': 2,
            'completion': {'summary': 'findings'} if status == 'completed' else None,
            'todos': [], 'pending_question': None,
            'read_only': True, 'permission_mode': 'plan', 'mode': 'plan',
            'delegation': {
                'taskId': task_id, 'parentSessionId': self.sid,
                'rootSessionId': self.sid, 'agent': None, 'modelSelection': {},
                'createdAt': time.time(), 'resumeCount': 0,
                **({'cancelled': True} if cancelled else {}),
            },
        }
        child_store = ChildStore(self.state, self.sid, task_id=task_id, root=self.root)
        child_store.save(row)
        return row

    def test_child_journal_survives_store_recreation_and_restores_task_projection(self):
        child = self.child()
        restored = ChildStore(self.state, self.sid, root=self.root).find_task('task-retained')
        self.assertEqual(restored['id'], child['id'])
        self.assertEqual(restored['messages'][-1]['content'], 'findings')
        self.assertTrue(recovery_info(restored)['canResume'])

        project = Path(self.temp.name) / 'project'
        web_runs = Path(self.temp.name) / 'web-runs'
        ctx = web.build_context(self.state, web_runs, project, workspace_roots=(self.root,))
        session = ctx['store'].load(self.sid)
        # Simulate a fresh web process with no in-memory task registry entries.
        ctx['task_registry'].clear()
        status, payload = plugin_runtime.dispatch_http(
            'GET', ['api', 'sessions', self.sid, 'tasks'], {}, {}, ctx)
        self.assertEqual(status, 200, payload)
        task = next(row for row in payload['tasks'] if row['id'] == 'task-retained')
        self.assertEqual(task['childSessionId'], child['id'])
        self.assertEqual(task['childStatus'], 'completed')
        self.assertTrue(task['canResume'])
        self.assertFalse(task['canResumeNow'])
        self.assertEqual(ctx['task_registry'].get('task-retained')['status'], 'completed')

    def test_child_history_is_parent_and_workspace_scoped(self):
        self.child()
        other_parent = self.store.new('other parent', self.root)
        with self.assertRaises(FileNotFoundError):
            ChildStore(self.state, other_parent['id'], root=self.root).find_task('task-retained')
        with self.assertRaises(FileNotFoundError):
            ChildStore(self.state, self.sid, task_id='task-retained',
                       root=Path(self.temp.name) / 'other-root').find_task('task-retained')

    def test_transcript_route_returns_full_visible_text_without_private_messages(self):
        prompt = 'inspect ' + ('workspace ' * 160)
        answer = 'Visible result ' + ('finding ' * 180)
        child = self.child(messages=[
            {'role': 'system', 'content': 'private system prompt marker'},
            {'role': 'user', 'content': prompt},
            {'role': 'assistant', 'content': answer,
             'reasoning': 'private reasoning marker'},
        ])
        ctx = web.build_context(self.state, Path(self.temp.name) / 'web-runs',
                                Path(self.temp.name) / 'project', workspace_roots=(self.root,))
        status, payload = plugin_runtime.dispatch_http(
            'GET', ['api', 'sessions', self.sid, 'tasks', 'task-retained', 'transcript'],
            {}, {}, ctx)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload['childSessionId'], child['id'])
        self.assertEqual(payload['initialPrompt'], prompt)
        visible = '\n'.join(event.get('preview', '') for event in payload['timeline']['events'])
        self.assertIn(answer, visible)
        self.assertNotIn('private system prompt marker', visible)
        self.assertNotIn('private reasoning marker', visible)

    def test_cancelled_and_incomplete_children_are_refused_without_executor_replay(self):
        cancelled = self.child('task-cancelled', status='stopped', cancelled=True)
        incomplete = self.child('task-incomplete', status='paused', messages=[
            {'role': 'system', 'content': 'read only'},
            {'role': 'user', 'content': 'inspect'},
            {'role': 'assistant', 'content': '', 'tool_calls': [
                {'id': 'call-open', 'type': 'function',
                 'function': {'name': 'read', 'arguments': '{"path":"file.txt"}'}}]},
        ])
        self.assertEqual(recovery_info(cancelled)['recoveryReason'], 'cancelled')
        self.assertEqual(recovery_info(incomplete)['recoveryReason'], 'unfinished_tool_exchange')
        calls = []
        registry = TaskRegistry()
        self.parent['task_runs'] = [projection(cancelled), projection(incomplete)]
        coordinator = TaskCoordinator(self.parent, registry)
        coordinator.bind_executor(lambda *args: calls.append(args) or {'ok': True}, state_dir=self.state)
        self.addCleanup(coordinator.close)
        self.assertFalse(coordinator.resume('resume-cancelled', {'task_id': 'task-cancelled'})['ok'])
        self.assertFalse(coordinator.resume('resume-incomplete', {'task_id': 'task-incomplete'})['ok'])
        self.assertEqual(calls, [])

    def test_messages_wait_for_a_safe_boundary_and_apply_once(self):
        child = self.child('task-guided', status='running', messages=[
            {'role': 'system', 'content': 'read only'},
            {'role': 'user', 'content': 'inspect'},
            {'role': 'assistant', 'content': '', 'tool_calls': [
                {'id': 'call-open', 'type': 'function',
                 'function': {'name': 'read', 'arguments': '{"path":"file.txt"}'}}]},
        ])
        child_store = ChildStore(self.state, self.sid, task_id='task-guided', root=self.root)
        receipt = enqueue_message(child_store, child, 'Please check the README too.', 'web-message-1')
        self.assertEqual(receipt['status'], 'queued')
        self.assertEqual(apply_messages(child_store, child), [])

        child['results']['call-open'] = {'ok': True, 'content': 'file'}
        child['messages'].append({'role': 'tool', 'tool_call_id': 'call-open', 'content': 'file'})
        child_store.save(child)
        self.assertEqual(apply_messages(child_store, child), ['web-message-1'])
        self.assertEqual(apply_messages(child_store, child), [])
        inputs = [row for row in child['messages'] if row.get('_input_id') == 'web-message-1']
        self.assertEqual(len(inputs), 1)
        self.assertEqual(inputs[0]['_input_presentation'], 'coordinator_steer')

    def test_explicit_resume_reuses_the_same_child_after_registry_recreation(self):
        child_store_registry = TaskRegistry()

        def child_run(child, child_store, provider, gate, **kwargs):
            child['status'] = 'completed'
            child['completion'] = {'summary': 'resumed findings'}
            child['messages'].append({'role': 'assistant', 'content': 'resumed findings'})
            child_store.save(child)

        first = run_subagent(
            Gate(self.root), object(), [], 'inspect', None, depth=0, max_depth=1,
            registry=child_store_registry, parent_session=self.sid, state_dir=self.state,
            task_id='task-restart', gate_class=Gate, run_fn=child_run,
            base_system='read-only system', max_steps=2, summary_max=4000,
        )
        self.assertTrue(first['ok'], first)
        child_id = first['childSessionId']
        saved_child = ChildStore(self.state, self.sid, task_id='task-restart',
                                 root=self.root).find_task('task-restart')
        self.parent['task_runs'] = [projection(saved_child)]
        self.store.save(self.parent)

        # The registry is intentionally new, as it would be after app restart.
        registry = TaskRegistry()
        parent = self.store.load(self.sid)
        coordinator = TaskCoordinator(parent, registry)
        coordinator.bind_executor(
            lambda tid, stop, args: run_subagent(
                Gate(self.root), object(), [], args.get('prompt'), args.get('agent'),
                depth=0, max_depth=1, registry=registry, parent_session=self.sid,
                parent_should_stop=stop, state_dir=self.state, task_id=tid,
                resume_session_id=args.get('resume_session_id'), gate_class=Gate,
                run_fn=child_run, base_system='read-only system', max_steps=2,
                summary_max=4000), state_dir=self.state)
        self.addCleanup(coordinator.close)
        result = coordinator.resume('resume-once', {
            'task_id': 'task-restart', 'message': 'Continue with the security review.'})
        self.assertTrue(result['ok'], result)
        collected = coordinator.collect({'task_ids': ['task-restart'], 'wait_seconds': 5,
                                         'reason': 'dependency',
                                         'detail': 'Wait for this explicit recovery.'})
        self.assertTrue(collected['ok'], collected)
        resumed = ChildStore(self.state, self.sid, task_id='task-restart',
                             root=self.root).find_task('task-restart')
        self.assertEqual(resumed['id'], child_id)
        self.assertEqual(resumed['delegation']['resumeCount'], 1)
        self.assertEqual(resumed['messages'][-2]['content'],
                         'Continue with the security review.')
        self.assertEqual(resumed['completion']['summary'], 'resumed findings')


if __name__ == '__main__':
    unittest.main()
