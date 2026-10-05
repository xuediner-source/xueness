"""Expert workflow (workflows.expert): definition, runtime mapping and entries.

Runs use the real DAG engine in-process with a stub node executor and a launch
stub, so no provider, detached worker or network is involved; the worker path
itself is covered by the plain workflow regressions.
"""
import argparse
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness.bundled_plugins.workflows import expert, operations_api
from xueness.core import Store
from xueness.plugin_runtime import PluginDisabled, dispatch_slash
from xueness.workflows import WorkflowStore, drive


def stub_executor(store, record, spec):
    return {'status': 'completed', 'summary': spec['id'] + ' 阶段产物'}


class ExpertWorkflowTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.base = Path(holder.name)
        self.state = self.base / 'state'
        self.root = self.base / 'workspace'
        self.root.mkdir()
        self.experts = expert.ExpertStore(self.state)
        self.workflows = WorkflowStore(self.state)
        # Tests never spawn the detached worker: launch just queues the run.
        patcher = patch.object(WorkflowStore, 'launch',
                               new=ExpertWorkflowTests._fake_launch)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _fake_launch(self, wid, approved=False, allow_real=False, expected_digest=None):
        self.update(wid, lambda row: row.update(status='queued', control='run'))
        return self.load(wid)

    # -- start -----------------------------------------------------------

    def start(self, session_id=None, permission_mode=None, root=None):
        return expert.start(self.state, '修复登录超时', root or self.root,
                            session_id=session_id, permission_mode=permission_mode)

    def test_start_creates_four_phase_agent_plan_and_run_record(self):
        record = self.start()
        workflow = self.workflows.load(record['workflow'])
        self.assertEqual([n['id'] for n in workflow['plan']['nodes']],
                         ['research', 'plan', 'implement', 'review'])
        self.assertEqual(workflow['plan']['nodes'][1]['needs'], ['research'])
        self.assertEqual(workflow['plan']['nodes'][3]['needs'], ['implement'])
        for node in workflow['plan']['nodes']:
            self.assertEqual(node['kind'], 'agent')
            self.assertNotIn('writable', node)
            self.assertIn('完成条件', node['prompt'])
        self.assertEqual(record['session'], None)
        self.assertEqual(record['permission_mode'], 'build')
        self.assertEqual(record['status'], 'running')
        self.assertEqual(record['phase'], 'research')
        self.assertEqual(self.experts.load(record['id'])['workflow'], record['workflow'])

    def test_yolo_and_edit_sessions_make_implement_phase_writable(self):
        for mode in ('yolo', 'edit'):
            plan = expert.expert_plan('任务', mode)
            self.assertTrue(plan['nodes'][2].get('writable'), mode)
            for node in plan['nodes'][:2] + plan['nodes'][3:]:
                self.assertNotIn('writable', node)
        for mode in ('build', 'plan'):
            plan = expert.expert_plan('任务', mode)
            self.assertNotIn('writable', plan['nodes'][2], mode)

    def test_session_bound_start_derives_permission_mode_from_the_session(self):
        sessions = Store(self.state)
        session = sessions.new('聊天', self.root)
        session['permission_mode'] = 'yolo'
        sessions.save(session)
        record = expert.start(self.state, '任务', self.root, session_id=session['id'])
        self.assertEqual(record['session'], session['id'])
        self.assertEqual(record['permission_mode'], 'yolo')
        workflow = self.workflows.load(record['workflow'])
        self.assertTrue(workflow['plan']['nodes'][2]['writable'])
        with self.assertRaisesRegex(ValueError, 'invalid session id'):
            expert.start(self.state, '任务', self.root, session_id='nope')
        with self.assertRaisesRegex(ValueError, 'derived from the bound session'):
            expert.start(self.state, '任务', self.root,
                         session_id=session['id'], permission_mode='yolo')

    def test_failed_launch_marks_the_expert_run_failed_without_blocking_retry(self):
        with patch.object(WorkflowStore, 'launch',
                          side_effect=ValueError('real model execution is not enabled')):
            with self.assertRaisesRegex(ValueError, 'real model'):
                self.start()
        failed = self.experts.list()[0]
        self.assertEqual(failed['status'], 'failed')
        self.assertIn('real model', failed['error'])
        record = self.start()
        self.assertEqual(record['status'], 'running')

    # -- phase advancement -------------------------------------------------

    def test_phases_advance_on_the_existing_dag_engine_and_summaries_flow(self):
        record = self.start()
        drive(self.workflows, record['workflow'], executor=stub_executor)
        final = expert.load(self.state, record['id'])
        self.assertEqual(final['status'], 'done')
        self.assertEqual(final['phase'], 'complete')
        self.assertEqual(final['phases']['research']['status'], 'completed')
        self.assertEqual(final['phases']['implement']['summary'], 'implement 阶段产物')
        self.assertEqual(final['phases']['review']['summary'], 'review 阶段产物')

    def test_failed_implement_phase_maps_to_failed_run(self):
        def failing(store, record, spec):
            if spec['id'] == 'implement':
                return {'status': 'failed', 'error': 'boom'}
            return stub_executor(store, record, spec)
        record = self.start()
        drive(self.workflows, record['workflow'], executor=failing)
        final = expert.load(self.state, record['id'])
        self.assertEqual(final['status'], 'failed')
        self.assertEqual(final['phase'], 'implement')
        self.assertEqual(final['phases']['implement']['error'], 'boom')
        self.assertEqual(final['phases']['review']['status'], 'blocked')

    # -- status / target resolution ----------------------------------------

    def test_status_reads_latest_run_for_a_session_without_touching_others(self):
        other = Store(self.state).new('其他会话', self.root)
        record = self.start(session_id=other['id'])
        target = expert.resolve_target(self.state, session_id=other['id'])
        self.assertEqual(target['id'], record['id'])
        with self.assertRaises(FileNotFoundError):
            expert.resolve_target(self.state, session_id='0' * 32)
        listed = expert.list_runs(self.state, other['id'])
        self.assertEqual([row['id'] for row in listed], [record['id']])

    # -- resume / stop ------------------------------------------------------

    def test_resume_restarts_paused_run_and_keeps_terminal_runs_settled(self):
        record = self.start()
        self.workflows.update(record['workflow'],
                              lambda row: row.update(status='paused', control='pause'))
        resumed = expert.resume(self.state, record['id'])
        self.assertEqual(resumed['status'], 'running')
        self.assertEqual(self.workflows.load(record['workflow'])['status'], 'queued')
        self.workflows.update(record['workflow'], lambda row: row.update(status='completed'))
        settled = expert.resume(self.state, record['id'])
        self.assertEqual(settled['status'], 'done')

    def test_resume_repairs_a_stale_active_run(self):
        record = self.start()
        self.workflows.update(record['workflow'], lambda row: row.update(status='running'))
        with patch.object(WorkflowStore, 'launch',
                          side_effect=[ValueError('run already active; recover a stale run first'),
                                       None]) as launch, \
                patch.object(WorkflowStore, 'control', return_value=None) as control:
            expert.resume(self.state, record['id'])
            control.assert_called_once_with(record['workflow'], 'recover')
            self.assertEqual(launch.call_count, 2)

    def test_stop_cancels_active_run_and_settles_unowned_paused_run(self):
        record = self.start()
        self.workflows.update(record['workflow'], lambda row: row.update(status='running'))
        expert.stop(self.state, record['id'])
        self.assertEqual(self.workflows.load(record['workflow'])['status'], 'stopping')
        self.workflows.update(record['workflow'], lambda row: row.update(status='cancelled'))
        again = expert.stop(self.state, record['id'])
        self.assertEqual(again['status'], 'stopped')

        paused = self.start()
        self.workflows.update(paused['workflow'],
                              lambda row: row.update(status='paused', control='pause'))
        settled = expert.stop(self.state, paused['id'])
        self.assertEqual(settled['status'], 'stopped')
        self.assertEqual(self.workflows.load(paused['workflow'])['status'], 'cancelled')

    def test_stop_mid_flight_through_the_real_engine_lands_on_stopped(self):
        record = self.start()
        def slow(store, row, spec):
            time.sleep(0.2)
            return {'status': 'completed', 'summary': 'partial'}
        worker = threading.Thread(
            target=drive, args=(self.workflows, record['workflow']),
            kwargs={'executor': slow}, daemon=True)
        worker.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.workflows.load(record['workflow'])['status'] == 'running':
                break
            time.sleep(0.02)
        expert.stop(self.state, record['id'])
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(expert.load(self.state, record['id'])['status'], 'stopped')
        self.assertEqual(self.workflows.load(record['workflow'])['status'], 'cancelled')

    # -- one active run per session -----------------------------------------

    def test_same_session_mutex_blocks_second_active_run(self):
        sessions = Store(self.state)
        session = sessions.new('聊天', self.root)
        first = self.start(session_id=session['id'])
        with self.assertRaisesRegex(ValueError, 'active expert run'):
            self.start(session_id=session['id'])
        # A settled run does not block the next one for the same session.
        self.workflows.update(first['workflow'],
                              lambda row: row.update(status='completed'))
        second = self.start(session_id=session['id'])
        self.assertNotEqual(first['id'], second['id'])
        # A different session is never blocked.
        other = sessions.new('另一个', self.root)
        self.start(session_id=other['id'])

    # -- plugin disabled -----------------------------------------------------

    def test_disabled_workflows_plugin_rejects_every_entry(self):
        def disable(pid):
            (self.state / 'plugin-state.json').write_text(json.dumps(
                {'apiVersion': 1, 'enabled': {pid: False}}), encoding='utf-8')
        disable('workflows')
        with self.assertRaises(PluginDisabled):
            self.start()
        # Disabling a dependency blocks the workflows plugin just the same.
        disable('shell')
        with self.assertRaises(PluginDisabled):
            self.start()
        (self.state / 'plugin-state.json').unlink()
        record = self.start()
        disable('workflows')
        with self.assertRaises(PluginDisabled):
            expert.resume(self.state, record['id'])
        with self.assertRaises(PluginDisabled):
            expert.stop(self.state, record['id'])

    def test_disabled_slash_command_reports_instead_of_becoming_a_prompt(self):
        (self.state / 'plugin-state.json').write_text(json.dumps(
            {'apiVersion': 1, 'enabled': {'workflows': False}}), encoding='utf-8')
        reply = dispatch_slash('/expert status', {'state_dir': self.state})
        self.assertIn('plugin disabled', reply)
        self.assertIsNone(dispatch_slash('/totally-unknown cmd', {'state_dir': self.state}))
        (self.state / 'plugin-state.json').unlink()

    # -- slash / CLI entries --------------------------------------------------

    def test_slash_expert_status_resume_stop_and_start_share_the_runtime(self):
        self.assertIn('暂无专家工作流',
                      dispatch_slash('/expert status', {'state_dir': self.state}))
        sessions = Store(self.state)
        session = sessions.new('聊天', self.root)
        ctx = {'state_dir': self.state, 'session': session, 'root': str(self.root)}
        self.assertIn('已启动专家工作流', dispatch_slash('/expert 修好登录', ctx))
        record = expert.resolve_target(self.state, session_id=session['id'])
        self.assertEqual(record['task'], '修好登录')
        self.assertEqual(record['permission_mode'], 'build')
        self.assertIn('运行中', dispatch_slash('/expert status', ctx))
        self.workflows.update(record['workflow'],
                              lambda row: row.update(status='paused', control='pause'))
        self.assertIn('运行中', dispatch_slash('/expert resume', ctx))
        self.assertEqual(self.workflows.load(record['workflow'])['status'], 'queued')
        self.assertIn('运行中', dispatch_slash('/expert stop', ctx))
        self.assertEqual(self.workflows.load(record['workflow'])['status'], 'stopping')
        self.workflows.update(record['workflow'], lambda row: row.update(status='cancelled'))
        self.assertIn('已停止', dispatch_slash('/expert stop', ctx))

    def test_cli_parser_and_execute_share_the_same_implementation(self):
        parser = argparse.ArgumentParser()
        commands = parser.add_subparsers(dest='cmd')
        from xueness.bundled_plugins.workflows.workflow_cli import add_parsers
        add_parsers(commands)
        self.assertEqual(parser.parse_args(['expert', 'status']).task, ['status'])
        self.assertEqual(parser.parse_args(['expert', 'start', '修', '好']).task,
                         ['start', '修', '好'])
        record = self.start()
        args = parser.parse_args(['expert', 'status', '--run', record['id']])
        args.state = self.state
        self.assertEqual(expert.execute_cli(args)['id'], record['id'])
        args = parser.parse_args(['expert'])
        args.state = self.state
        with self.assertRaisesRegex(ValueError, 'needs a task'):
            expert.execute_cli(args)

    # -- HTTP entry -------------------------------------------------------------

    def ctx(self):
        return {'state_dir': self.state, 'web_runs': self.base / 'web-runs',
                'project_dir': self.base / 'project', 'allow_real': False,
                'workspace_roots': (self.root,)}

    def test_http_start_status_resume_and_stop_routes(self):
        sessions = Store(self.state)
        session = sessions.new('聊天', self.root)
        ctx = self.ctx()
        code, record = operations_api.dispatch(
            'POST', ['api', 'workflows', 'expert'],
            {}, {'task': '任务', 'root': str(self.root), 'session': session['id']}, ctx)
        self.assertEqual(code, 200)
        self.assertEqual(record['session'], session['id'])
        self.assertEqual(record['permission_mode'], 'build')
        code, listed = operations_api.dispatch(
            'GET', ['api', 'workflows', 'expert'], {'session': [session['id']]}, {}, ctx)
        self.assertEqual(code, 200)
        self.assertEqual([row['id'] for row in listed['expert_runs']], [record['id']])
        code, shown = operations_api.dispatch(
            'GET', ['api', 'workflows', 'expert', record['id']], {}, {}, ctx)
        self.assertEqual(code, 200)
        self.assertEqual(shown['id'], record['id'])
        code, payload = operations_api.dispatch(
            'POST', ['api', 'workflows', 'expert', record['id'], 'stop'], {}, {}, ctx)
        self.assertEqual(code, 200)
        self.assertEqual(self.workflows.load(record['workflow'])['status'], 'stopping')
        self.workflows.update(record['workflow'], lambda row: row.update(status='cancelled'))
        code, shown = operations_api.dispatch(
            'GET', ['api', 'workflows', 'expert', record['id']], {}, {}, ctx)
        self.assertEqual(code, 200)
        self.assertEqual(shown['status'], 'stopped')
        self.assertEqual(operations_api.dispatch(
            'POST', ['api', 'workflows', 'expert', record['id'], 'nope'], {}, {}, ctx)[0], 404)

    def test_http_start_outside_allowed_roots_is_refused(self):
        outside = self.base / 'outside'
        outside.mkdir()
        code, _ = operations_api.dispatch(
            'POST', ['api', 'workflows', 'expert'], {},
            {'task': '任务', 'root': str(outside)}, self.ctx())
        self.assertEqual(code, 400)

    def test_http_list_hides_runs_from_other_roots(self):
        outside = self.base / 'outside'
        outside.mkdir()
        record = self.start(root=outside)
        code, listed = operations_api.dispatch(
            'GET', ['api', 'workflows', 'expert'], {}, {}, self.ctx())
        self.assertEqual(code, 200)
        self.assertEqual(listed['expert_runs'], [])
        code, _ = operations_api.dispatch(
            'GET', ['api', 'workflows', 'expert', record['id']], {}, {}, self.ctx())
        self.assertEqual(code, 400)

    def test_http_awaiting_actor_needs_answer_and_resume_delivers_it(self):
        record = self.start()
        def asking(store, row, spec):
            if spec['id'] == 'implement':
                sessions = Store(self.workflows.directory / (record['workflow'] + '-sessions'))
                child = sessions.new('问题', self.root)
                child['status'] = 'awaiting_user'
                child['pending_question'] = '要改哪个文件?'
                sessions.save(child)
                return {'status': 'awaiting_user', 'question': '要改哪个文件?',
                        'summary': '', 'session_id': child['id']}
            return stub_executor(store, row, spec)
        drive(self.workflows, record['workflow'], executor=asking)
        paused = expert.load(self.state, record['id'])
        self.assertEqual(paused['status'], 'paused')
        with self.assertRaisesRegex(ValueError, 'answer'):
            expert.resume(self.state, record['id'])
        answered = expert.resume(self.state, record['id'], answer='改 auth.py')
        self.assertEqual(answered['status'], 'running')
        workflow = self.workflows.load(record['workflow'])
        child = Store(self.workflows.directory / (record['workflow'] + '-sessions')).load(
            workflow['nodes']['implement']['session_id'])
        self.assertIn('auth.py', child['messages'][-1]['content'])

    def test_expert_records_stay_out_of_the_plain_workflow_listing(self):
        record = self.start()
        self.assertEqual([row['id'] for row in self.workflows.list()],
                         [record['workflow']])


if __name__ == '__main__':
    unittest.main()
