"""Saved workflow template library: save, list, run-by-name and its boundaries.

Covers the ``workflows.saved_library`` feature end to end with an isolated
state directory and real DAG workers: named storage with explicit overwrite,
name validation, plan validation at save and instantiation, the three model
tools (Gate subjects, host real-provider ceiling, disable boundary) and the
``xueness workflows`` CLI face. No network, no real model calls.
"""
import argparse
import contextlib
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness import plugin_runtime
from xueness.bundled_plugins.workflows import saved_library, tools as workflow_tools
from xueness.bundled_plugins.workflows.saved_library import (
    SavedWorkflowLibrary, _latest_run_plan, _source_plan, template_plan_digest, validate_name)
from xueness.bundled_plugins.workflows.workflows import ACTIVE, WorkflowStore
from xueness.core import Store
from xueness.tool_contract import bind_execution
from xueness.tool_registry import REGISTRY, dispatch


def node(id, code='print("ok")', **extra):
    return dict(id=id, argv=[sys.executable, '-c', code], timeout=15, **extra)


class GateStub:
    def __init__(self, refuse=False):
        self.calls = []
        self.refuse = refuse

    def check(self, kind, subject, call_id=None):
        self.calls.append((kind, subject, call_id))
        if self.refuse:
            raise PermissionError('approval required')


class SavedWorkflowLibraryTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.workspace = base / 'workspace'
        self.workspace.mkdir()
        self.state = base / 'state'
        self.library = SavedWorkflowLibrary(self.state)
        self.store = WorkflowStore(self.state)

    def plan(self, name='Saved flow', **node_extra):
        return {'name': name, 'nodes': [node('a', **node_extra)]}

    def test_save_and_list_round_trip_reports_names_descriptions_and_counts(self):
        saved = self.library.save(self.plan(), 'review-flow', self.workspace,
                                  description='  每次评审都跑一遍  ')
        self.assertEqual(saved['name'], 'review-flow')
        self.assertEqual(saved['description'], '每次评审都跑一遍')
        self.assertEqual(saved['node_count'], 1)
        self.assertEqual(saved['plan_name'], 'Saved flow')
        self.assertEqual(saved['concurrency'], 2)
        self.assertLess(abs(saved['saved_at'] - time.time()), 60)
        rows = self.library.list()
        self.assertEqual([row['name'] for row in rows], ['review-flow'])
        self.assertEqual(rows[0]['description'], '每次评审都跑一遍')
        self.assertEqual(rows[0]['node_count'], 1)
        # The stored file is pure validated data; the plan is exactly what
        # validate_plan normalized, with no extra executable fields.
        stored = json.loads((self.library.directory / 'review-flow.json').read_text(encoding='utf-8'))
        self.assertEqual(stored['plan'], self.library.load('review-flow')['plan'])

    def test_overwriting_a_name_requires_the_explicit_flag(self):
        self.library.save(self.plan(name='before'), 'flow', self.workspace)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.library.save(self.plan(name='after'), 'flow', self.workspace)
        replaced = self.library.save(self.plan(name='after'), 'flow', self.workspace,
                                     overwrite=True)
        self.assertEqual(replaced['plan_name'], 'after')
        self.assertEqual([row['name'] for row in self.library.list()], ['flow'])
        self.assertEqual(self.library.load('flow')['plan']['name'], 'after')

    def test_concurrent_create_does_not_silently_overwrite_a_template(self):
        original_write = saved_library._atomic_write_json
        first_writer_entered = threading.Event()
        release_first_writer = threading.Event()
        second_call_started = threading.Event()
        second_path_checked = threading.Event()
        write_lock = threading.Lock()
        writes = 0
        results = []
        errors = []
        original_path = self.library.path

        def pause_first_write(path, record):
            nonlocal writes
            with write_lock:
                writes += 1
                current = writes
            if current == 1:
                first_writer_entered.set()
                if not release_first_writer.wait(5):
                    raise TimeoutError('first template write was not released')
            original_write(path, record)

        def track_path(name):
            if threading.current_thread().name == 'saved-workflow-second':
                second_path_checked.set()
            return original_path(name)

        def save(plan_name):
            try:
                results.append(self.library.save(self.plan(name=plan_name), 'shared',
                                                 self.workspace))
            except Exception as exc:
                errors.append(exc)

        with patch.object(saved_library, '_atomic_write_json', side_effect=pause_first_write), \
                patch.object(self.library, 'path', side_effect=track_path):
            first = threading.Thread(target=save, args=('first',),
                                     name='saved-workflow-first')
            first.start()
            self.assertTrue(first_writer_entered.wait(2), 'first writer did not reach publication')

            def save_second():
                second_call_started.set()
                save('second')

            second = threading.Thread(target=save_second, name='saved-workflow-second')
            second.start()
            self.assertTrue(second_call_started.wait(2), 'second writer did not start')
            # The second writer has entered save while the first publication is
            # paused. It must wait for the per-name lock before checking exists.
            self.assertFalse(second_path_checked.wait(.1),
                             'second writer checked the name outside its lock')
            release_first_writer.set()
            first.join(5)
            second.join(5)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(len(results), 1)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValueError)
        self.assertIn('already exists', str(errors[0]))
        self.assertIn(self.library.load('shared')['plan']['name'], ('first', 'second'))

    def test_invalid_names_are_refused_and_write_nothing(self):
        bad = ['', 'a' * 65, 'a' * 64 + 'x', '.hidden', '../escape', 'a/b', 'a\\b',
               'a b', 'con', 'NUL', 'Com1.json', '.', '-', 5, None]
        for name in bad:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.library.save(self.plan(), name, self.workspace)
        self.assertEqual(list(self.library.directory.glob('*.json')), [])
        with self.assertRaises(ValueError):
            validate_name('x' * 65)

    def test_valid_name_boundaries(self):
        self.assertEqual(validate_name('a' * 64), 'a' * 64)
        self.assertEqual(validate_name('A9._-'), 'A9._-')

    def test_template_validation_rejects_bad_dags_and_writes_nothing(self):
        bad_plans = (
            {'nodes': [node('a', needs=['b']), node('b', needs=['a'])]},
            {'nodes': [node('a'), node('a')]},
            {'nodes': [node('a', cwd='..')]},
            {'nodes': [node('a')], 'concurrency': 0},
            {'nodes': [dict(node('a'), script='__import__("os")')]},
            {'nodes': [dict(node('a'), writable=True)]},
        )
        for plan in bad_plans:
            with self.subTest(plan=plan), self.assertRaises(ValueError):
                self.library.save(plan, 'bad', self.workspace)
        self.assertEqual(list(self.library.directory.glob('*.json')), [])

    def test_unknown_and_damaged_templates_fail_closed(self):
        with self.assertRaisesRegex(ValueError, 'unknown saved workflow'):
            self.library.load('missing')
        (self.library.directory / 'broken.json').write_text('{not json', encoding='utf-8')
        self.assertEqual(self.library.list(), [])
        with self.assertRaises(ValueError):
            self.library.load('broken')

    def test_save_from_a_run_is_workspace_bounded(self):
        record = self.store.create(self.plan(name='from run'), self.workspace)
        plan, source = _source_plan(self.state, record['id'], self.workspace)
        self.assertEqual(source, {'kind': 'run', 'workflow_id': record['id']})
        saved = self.library.save(plan, 'from-run', self.workspace, source=source)
        self.assertEqual(saved['node_count'], 1)
        other = self.workspace.parent / 'other'
        other.mkdir()
        foreign = self.store.create(self.plan(name='foreign'), other)
        with self.assertRaises(PermissionError):
            _source_plan(self.state, foreign['id'], self.workspace)

    def test_latest_run_plan_picks_the_newest_run_in_the_workspace(self):
        first = self.store.create(self.plan(name='first'), self.workspace)
        time.sleep(.02)
        second = self.store.create(self.plan(name='second'), self.workspace)
        plan, source = _latest_run_plan(self.state, self.workspace)
        self.assertEqual(source['workflow_id'], second['id'])
        self.assertEqual(plan['name'], 'second')
        other = self.workspace.parent / 'other'
        other.mkdir()
        self.store.create(self.plan(name='foreign'), other)
        plan, source = _latest_run_plan(self.state, self.workspace)
        self.assertEqual(source['workflow_id'], second['id'])
        # A later touch (update() stamps updated_at itself) reorders the pick.
        time.sleep(.02)
        self.store.update(first['id'], lambda row: None)
        plan, _ = _latest_run_plan(self.state, self.workspace)
        self.assertEqual(plan['name'], 'first')

    def test_latest_run_plan_without_runs_is_a_clear_refusal(self):
        with self.assertRaisesRegex(ValueError, 'no workflow runs'):
            _latest_run_plan(self.state, self.workspace)

    def test_template_plan_digest_binds_content(self):
        plan = self.plan()
        digest = template_plan_digest(plan)
        self.assertEqual(digest, template_plan_digest(json.loads(json.dumps(plan))))
        changed = json.loads(json.dumps(plan))
        changed['nodes'][0]['argv'][-1] = 'print("changed")'
        self.assertNotEqual(digest, template_plan_digest(changed))


class SavedWorkflowToolTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.workspace = base / 'workspace'
        self.workspace.mkdir()
        self.state = base / 'state'
        self.store = WorkflowStore(self.state)
        self.library = SavedWorkflowLibrary(self.state)
        # A real owning session: the engine re-reads its permission ceiling
        # while driving nodes, and an unloadable owner fails closed.
        owner = Store(self.state).new('saved workflow test', self.workspace)
        self.session = {'root': str(self.workspace), 'id': owner['id']}
        self.context = {'state_dir': self.state, 'store': self.store, 'registry': None}

    def plan(self, name='Saved flow', **node_extra):
        return {'name': name, 'nodes': [node('a', **node_extra)]}

    def wait(self, wid, seconds=15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            row = self.store.load(wid)
            if row['status'] not in ACTIVE:
                return row
            time.sleep(.03)
        self.fail('workflow did not settle: ' + str(self.store.load(wid)))

    def test_save_workflow_tool_stores_validated_template(self):
        with bind_execution(**self.context):
            result = workflow_tools._save_workflow(self.workspace, GateStub(),
                                                   {'name': 'flow', 'plan': self.plan(),
                                                    'description': 'demo'},
                                                   self.session, 'call-1')
            self.assertTrue(result['ok'])
            self.assertEqual(result['saved']['name'], 'flow')
            listing = workflow_tools._list_saved_workflows(self.workspace, GateStub(), {},
                                                           self.session, 'call-2')
            self.assertEqual([row['name'] for row in listing['saved']], ['flow'])

    def test_save_workflow_tool_requires_exactly_one_source(self):
        with bind_execution(**self.context):
            for args in ({'name': 'x'}, {'name': 'x', 'plan': self.plan(), 'script': 'agent("a")'},
                         {'name': 'x', 'plan': self.plan(), 'latest': True},
                         {'name': 'x', 'plan': self.plan(), 'workflow_id': '0' * 32},
                         {'name': 'x', 'latest': 'yes', 'plan': self.plan()}):
                with self.subTest(args=args), self.assertRaises(ValueError):
                    workflow_tools._save_workflow(self.workspace, GateStub(), args,
                                                  self.session, 'call')

    def test_save_workflow_tool_rejects_overwrite_without_flag(self):
        with bind_execution(**self.context):
            workflow_tools._save_workflow(self.workspace, GateStub(),
                                          {'name': 'flow', 'plan': self.plan()},
                                          self.session, 'call-1')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                workflow_tools._save_workflow(self.workspace, GateStub(),
                                              {'name': 'flow', 'plan': self.plan(name='two')},
                                              self.session, 'call-2')
            result = workflow_tools._save_workflow(self.workspace, GateStub(),
                                                   {'name': 'flow', 'plan': self.plan(name='two'),
                                                    'overwrite': True},
                                                   self.session, 'call-3')
            self.assertEqual(result['saved']['plan_name'], 'two')

    def test_run_saved_workflow_requires_exec_approval_on_exact_subject(self):
        with bind_execution(**self.context):
            workflow_tools._save_workflow(self.workspace, GateStub(),
                                          {'name': 'flow', 'plan': self.plan()},
                                          self.session, 'call-0')
            record = self.library.load('flow')
            gate = GateStub(refuse=True)
            with self.assertRaises(PermissionError):
                workflow_tools._run_saved_workflow(self.workspace, gate, {'name': 'flow'},
                                                   self.session, 'call-1')
            digest = template_plan_digest(record['plan'])
            self.assertEqual(gate.calls, [
                ('exec', '{"allow_real":false,"approved":true,"plan_digest":"' + digest +
                 '","saved_workflow":"flow"}', 'call-1')])
            # Refused before any effect: no durable run was created.
            self.assertEqual(self.store.list(), [])
            # The registry approval subject agrees with the handler subject.
            self.assertEqual(workflow_tools._run_saved_workflow_subject({'name': 'flow'}),
                             gate.calls[0][1])

    def test_run_saved_workflow_executes_and_stamps_the_session(self):
        with bind_execution(**self.context):
            workflow_tools._save_workflow(self.workspace, GateStub(),
                                          {'name': 'flow',
                                           'plan': self.plan(name='e2e',
                                                             code='from pathlib import Path; '
                                                                  'Path("done.txt").write_text("ok")')},
                                          self.session, 'call-0')
            result = workflow_tools._run_saved_workflow(self.workspace, GateStub(),
                                                        {'name': 'flow'}, self.session, 'call-1')
            self.assertTrue(result['ok'])
            self.assertEqual(result['saved_workflow'], 'flow')
            settled = self.wait(result['workflow']['id'])
            self.assertEqual(settled['status'], 'completed')
            self.assertEqual((self.workspace / 'done.txt').read_text(), 'ok')
            self.assertEqual(settled.get('owner_session'), self.session['id'])

    def test_run_saved_workflow_validates_against_the_target_workspace(self):
        sub = self.workspace / 'sub'
        sub.mkdir()
        other = self.workspace.parent / 'other'
        other.mkdir()
        with bind_execution(**self.context):
            workflow_tools._save_workflow(self.workspace, GateStub(),
                                          {'name': 'flow',
                                           'plan': {'nodes': [node('a', cwd='sub')]}},
                                          self.session, 'call-0')
            session = {'root': str(other), 'id': 'b' * 32}
            with self.assertRaisesRegex(ValueError, 'inside root'):
                workflow_tools._run_saved_workflow(other, GateStub(), {'name': 'flow'},
                                                   session, 'call-1')

    def test_run_saved_workflow_unknown_name_is_a_clean_value_error(self):
        with bind_execution(**self.context):
            with self.assertRaisesRegex(ValueError, 'unknown saved workflow'):
                workflow_tools._run_saved_workflow(self.workspace, GateStub(), {'name': 'ghost'},
                                                   self.session, 'call-1')
            with self.assertRaises(ValueError):
                workflow_tools._run_saved_workflow(self.workspace, GateStub(), {'name': '../x'},
                                                   self.session, 'call-2')

    def test_run_saved_workflow_obeys_web_host_real_provider_ceiling(self):
        from xueness.web import WebGate
        with bind_execution(**self.context):
            workflow_tools._save_workflow(self.workspace, GateStub(),
                                          {'name': 'agents',
                                           'plan': {'nodes': [{'id': 'agent', 'kind': 'agent',
                                                               'prompt': 'inspect'}]}},
                                          self.session, 'call-0')
            web_gate = WebGate(self.workspace, 'web-session', {}, threading.Lock(),
                               session=self.session)
            web_gate.allow_real = False
            denied = workflow_tools._run_saved_workflow(self.workspace, web_gate,
                                                        {'name': 'agents', 'allow_real': True},
                                                        self.session, 'web-call')
            self.assertEqual(denied, {'ok': False, 'error': 'real provider disabled by host'})
            self.assertEqual(self.store.list(), [])

    def test_saved_tools_are_declared_with_their_gate_kinds(self):
        names = {tool.name: tool for tool in REGISTRY}
        for name in ('save_workflow', 'list_saved_workflows', 'run_saved_workflow'):
            self.assertIn(name, names)
            self.assertEqual(plugin_runtime.tool_owner(name), 'workflows')
        self.assertEqual(names['save_workflow'].gate_kind, 'planning')
        self.assertIs(names['save_workflow'].mutating, False)
        self.assertEqual(names['list_saved_workflows'].gate_kind, 'planning')
        self.assertIs(names['list_saved_workflows'].concurrency_safe, True)
        self.assertEqual(names['run_saved_workflow'].gate_kind, 'exec')
        self.assertIs(names['run_saved_workflow'].mutating, True)
        self.assertIsNotNone(names['run_saved_workflow'].approval_subject)

    def test_disabled_workflows_plugin_stops_the_saved_tools(self):
        from xueness.core import Gate
        plugin_runtime.set_enabled(self.state, 'workflows', False)
        self.addCleanup(plugin_runtime.set_enabled, self.state, 'workflows', True)
        root = self.workspace
        gate = Gate(root, allow_exec=True, allow_write=True)
        with bind_execution(**self.context):
            self.assertEqual(dispatch(root, gate, 'list_saved_workflows', {}),
                             {'ok': False, 'error': 'plugin disabled'})
            self.assertEqual(dispatch(root, gate, 'save_workflow', {'name': 'flow', 'plan': self.plan()}),
                             {'ok': False, 'error': 'plugin disabled'})
            self.assertEqual(dispatch(root, gate, 'run_saved_workflow', {'name': 'flow'}),
                             {'ok': False, 'error': 'plugin disabled'})
        self.assertEqual(list(self.library.directory.glob('*.json')), [])


class SavedWorkflowCliTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.workspace = base / 'workspace'
        self.workspace.mkdir()
        self.state = base / 'state'
        self.store = WorkflowStore(self.state)
        self.library = SavedWorkflowLibrary(self.state)
        parser = argparse.ArgumentParser()
        self.parser = parser
        self.commands = parser.add_subparsers(dest='cmd')
        plugin_runtime.register_cli_parsers(self.commands)

    def parse(self, argv):
        args = self.parser.parse_args(argv)
        args.state = Path(self.state)
        return args

    def execute(self, argv, expect=0):
        """Run the real plugin execute_cli face; return JSON (or stderr text on failure)."""
        args = self.parse(argv)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = plugin_runtime.entrypoint('workflows').execute_cli(args)
        self.assertEqual(code, expect, err.getvalue())
        return json.loads(out.getvalue()) if code == 0 else err.getvalue()

    def test_cli_save_list_run_round_trip(self):
        plan_file = self.workspace.parent / 'flow.json'
        plan_file.write_text(json.dumps(
            {'name': 'CLI flow', 'nodes': [node('a', code='from pathlib import Path; '
                                                   'Path("cli-done.txt").write_text("ok")')]}),
            encoding='utf-8')
        saved = self.execute(['workflows', 'save', 'cli-flow', str(plan_file),
                              '--root', str(self.workspace), '--description', 'from CLI'])
        self.assertEqual(saved['saved']['name'], 'cli-flow')
        self.assertEqual(saved['saved']['description'], 'from CLI')
        listed = self.execute(['workflows', 'list'])
        self.assertEqual([row['name'] for row in listed['saved']], ['cli-flow'])
        # CLI run still requires the explicit approval for command nodes; the
        # refusal is the machine-readable exit contract, not a crash.
        refusal = self.execute(['workflows', 'run', 'cli-flow', '--root', str(self.workspace)],
                               expect=1)
        self.assertIn('explicit approval', refusal)
        pending = self.store.list()
        self.assertEqual([row['status'] for row in pending], ['created'])
        self.assertFalse((self.workspace / 'cli-done.txt').exists())
        launched = self.execute(['workflows', 'run', 'cli-flow', '--root', str(self.workspace),
                                 '--approve'])
        wid = launched['id']
        row, end = None, time.monotonic() + 15
        while time.monotonic() < end:
            row = self.store.load(wid)
            if row['status'] not in ACTIVE:
                break
            time.sleep(.03)
        self.assertIsNotNone(row)
        self.assertEqual(row['status'], 'completed')
        self.assertEqual((self.workspace / 'cli-done.txt').read_text(), 'ok')

    def test_cli_save_from_run_and_latest(self):
        record = self.store.create({'name': 'run flow', 'nodes': [node('a')]}, self.workspace)
        saved = self.execute(['workflows', 'save', 'copied', '--from-run', record['id'],
                              '--root', str(self.workspace)])
        self.assertEqual(saved['saved']['node_count'], 1)
        self.assertEqual(self.library.load('copied')['source']['workflow_id'], record['id'])
        time.sleep(.02)
        self.store.create({'name': 'newest', 'nodes': [node('b')]}, self.workspace)
        latest = self.execute(['workflows', 'save', 'newest-template', '--latest',
                               '--root', str(self.workspace)])
        self.assertEqual(latest['saved']['plan_name'], 'newest')

    def test_cli_save_requires_exactly_one_source(self):
        plan_file = self.workspace.parent / 'flow.json'
        plan_file.write_text(json.dumps({'nodes': [node('a')]}), encoding='utf-8')
        record = self.store.create({'nodes': [node('a')]}, self.workspace)
        err = self.execute(['workflows', 'save', 'x', str(plan_file), '--from-run', record['id'],
                            '--root', str(self.workspace)], expect=1)
        self.assertIn('exactly one', err)
        err = self.execute(['workflows', 'save', 'x', '--root', str(self.workspace)], expect=1)
        self.assertIn('exactly one', err)

    def test_cli_face_is_disabled_with_the_plugin(self):
        from xueness.cli import _require_cli_plugins
        plugin_runtime.set_enabled(self.state, 'workflows', False)
        self.addCleanup(plugin_runtime.set_enabled, self.state, 'workflows', True)
        args = self.parse(['workflows', 'list'])
        self.assertEqual(plugin_runtime.cli_owner('workflows'), 'workflows')
        refusal = _require_cli_plugins(args)
        self.assertIn('workflows', refusal)
        plugin_runtime.set_enabled(self.state, 'workflows', True)
        self.assertIsNone(_require_cli_plugins(args))


if __name__ == '__main__':
    unittest.main()
