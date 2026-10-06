"""The experimental tool dry-run: ``tools.dry_run_experimental``.

These tests pin the two properties that make the feature safe to ship behind a
default-off switch:

* with the flag off nothing changes at all -- the same results, the same writes,
  the same subprocesses, and no new field anywhere;
* with the flag on a side effect is never performed. ``write``, ``edit`` and
  ``exec`` answer with a structured preview instead, every other tool the
  existing Gate/registry classification counts as a side effect is refused
  before its handler runs, and read-only tools keep running.

And the property that keeps both of those honest: the switch only ever
*tightens*. Gate refusals stay refusals with their original payload, a path
outside the workspace stays denied, an approval the call would have needed is
never consumed by a preview, and a disabled owning plugin restores the plain
behaviour even with the flag on.
"""
import json
import os
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch

from xueness import plugin_runtime
from xueness.bundled_plugins.settings import preferences
from xueness.bundled_plugins.tools import dry_run
from xueness.core import Gate, Store
from xueness.tool_contract import bind_execution
from xueness.tool_registry import REGISTRY_BY_NAME, dispatch
from xueness.web import WebGate

from unittest import TestCase

SESSION_ID = 'f' * 32


def _session(**extra) -> dict:
    session = {'id': SESSION_ID, 'status': 'pending', 'steps': 0,
               'messages': [], 'results': {}}
    session.update(extra)
    return session


class _Fixture(TestCase):
    """One isolated state directory, workspace and bound execution context.

    Acceptance always runs against a temporary state dir, never a real one, so
    a toggle written here cannot leak into another session's plugin or settings
    state.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.state = base / 'state'
        self.state.mkdir()
        self.root = base / 'project'
        self.root.mkdir()
        (self.root / 'note.txt').write_text('alpha\nbeta\ngamma\n', encoding='utf-8')
        self.store = Store(self.state)
        self.session = _session()

    def tearDown(self):
        self.temp.cleanup()

    # -- switch plumbing ----------------------------------------------------

    def set_flag(self, value):
        if value is None:
            (self.state / 'settings.json').unlink(missing_ok=True)
            return
        (self.state / 'settings.json').write_text(
            json.dumps({'general': {'toolsDryRunEnabled': value}}), encoding='utf-8')

    def call(self, name, args, gate, session=None):
        with bind_execution(store=self.store, state_dir=self.state):
            return dispatch(self.root, gate, name, args,
                            self.session if session is None else session)


class ClassificationTests(_Fixture):
    """The feature borrows the existing Gate/registry classification."""

    def test_read_only_tools_are_not_side_effects(self):
        for name in ('read', 'list', 'glob', 'grep', 'todo_read', 'todo_write',
                     'tool_result_read', 'read_session_context', 'workflow_status'):
            with self.subTest(tool=name):
                self.assertFalse(dry_run.side_effecting(name), name)

    def test_mutating_and_approval_bearing_tools_are_side_effects(self):
        for name in ('write', 'edit', 'exec', 'remote_exec', 'browser_click',
                     'browser_fill', 'workflow_run', 'background_exec',
                     'offpeak_create', 'web_fetch', 'web_search'):
            with self.subTest(tool=name):
                self.assertTrue(dry_run.side_effecting(name), name)

    def test_unknown_names_are_not_judged_here(self):
        # MCP tools reach their server through the capability seam, so this
        # feature never sees them and must not claim they were previewed.
        self.assertFalse(dry_run.side_effecting('mcp__demo__write'))

    def test_cooperative_handlers_stay_aligned_with_the_registry(self):
        # The probe asks the gate kind recorded here; a handler replying with a
        # different kind would preview a call Gate never saw.
        for name, kind in dry_run.COOPERATIVE_TOOLS.items():
            with self.subTest(tool=name):
                self.assertIs(REGISTRY_BY_NAME[name].gate_kind, kind)

    def test_no_side_effecting_tool_can_silently_escape_the_switch(self):
        self.set_flag(True)
        for tool in REGISTRY_BY_NAME.values():
            if not dry_run.side_effecting(tool.name):
                continue
            with self.subTest(tool=tool.name):
                outcome = plugin_runtime.before_tool_execution(
                    self.state, self.session, self.store, tool.name, tool.gate_kind)
                if tool.name in dry_run.COOPERATIVE_TOOLS:
                    # Its handler answers with a preview, so the seam stands aside.
                    self.assertIsNone(outcome, tool.name)
                else:
                    # The kernel turns a participant deny into this structured
                    # error, which is what ``dispatch`` hands back to the model.
                    self.assertIsInstance(outcome, dict, tool.name)
                    self.assertEqual(outcome['error'], 'denied by plugin tools', outcome)
                    self.assertEqual(outcome['error_code'], 'plugin_denied', outcome)
                    self.assertEqual(outcome['plugin'], 'tools', outcome)
                    self.assertIn(dry_run.FEATURE_ID, outcome['user_reason'], outcome)


class FlagTests(_Fixture):
    """Only an explicit boolean turns the feature on, and only while effective."""

    def test_absent_settings_file_keeps_it_off(self):
        self.assertFalse(dry_run.flag_enabled(self.state))
        self.assertFalse(dry_run.active(self.state))

    def test_enabled_only_by_an_explicit_boolean(self):
        for value, expected in ((True, True), (False, False), ('true', False),
                                (1, False), (None, False)):
            with self.subTest(value=repr(value)):
                self.set_flag(value)
                self.assertIs(dry_run.flag_enabled(self.state), expected)
                self.assertIs(dry_run.active(self.state), expected)

    def test_environment_override_reaches_unbound_callers(self):
        self.set_flag(False)
        with patch.dict(os.environ, {dry_run.ENV_FLAG: '1'}):
            self.assertTrue(dry_run.env_enabled())
            self.assertTrue(dry_run.active(self.state))
            self.assertTrue(dry_run.active(None))
        with patch.dict(os.environ, {dry_run.ENV_FLAG: 'maybe'}):
            self.assertFalse(dry_run.env_enabled())
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(dry_run.env_enabled())
            self.assertFalse(dry_run.active(None))

    def test_disabled_owning_plugin_beats_the_flag(self):
        self.set_flag(True)
        self.assertTrue(dry_run.active(self.state))
        plugin_runtime.set_enabled(self.state, 'tools', False)
        self.assertFalse(dry_run.active(self.state))
        # The feature never runs on another plugin's authority: the handlers go
        # back to their own behaviour, effects included.
        gate = Gate(self.root, allow_write=True)
        result = self.call('write', {'path': 'after.csv', 'content': 'x\n'}, gate)
        self.assertTrue(result['ok'], result)
        self.assertTrue((self.root / 'after.csv').is_file())

    def test_settings_only_accept_a_boolean_toggle(self):
        self.assertEqual(
            preferences.validate('general', {'toolsDryRunEnabled': True}),
            {'toolsDryRunEnabled': True})
        for value in ('true', 1, None, {'on': True}):
            with self.subTest(value=repr(value)):
                with self.assertRaises(ValueError) as raised:
                    preferences.validate('general', {'toolsDryRunEnabled': value})
                self.assertEqual(str(raised.exception),
                                 'toolsDryRunEnabled must be boolean')


class PreviewShapeTests(_Fixture):
    """The preview answers "what would happen" without growing with the file."""

    def gate(self):
        return Gate(self.root, allow_write=True, allow_edit=True, allow_exec=True)

    def test_write_preview_describes_a_new_file(self):
        self.set_flag(True)
        result = self.call('write', {'path': 'new.txt', 'content': 'one\ntwo\n'},
                           self.gate())
        preview = result['preview']
        self.assertEqual(preview['action'], 'write')
        self.assertEqual(preview['path'], 'new.txt')
        self.assertEqual(Path(preview['target']), (self.root / 'new.txt').resolve())
        self.assertTrue(preview['creates_new_file'])
        self.assertFalse(preview['file_exists'])
        self.assertIsNone(preview['readable'])
        self.assertIsNone(preview['previous_chars'])
        self.assertEqual(preview['content_chars'], 8)
        self.assertEqual(preview['content_preview'], 'one\ntwo\n')
        self.assertEqual(preview['diff']['added_lines'], 2)
        self.assertEqual(preview['diff']['removed_lines'], 0)

    def test_write_preview_diffs_against_the_current_file(self):
        self.set_flag(True)
        result = self.call('write', {'path': 'note.txt', 'content': 'alpha\nBETA\ngamma\n'},
                           self.gate())
        diff = result['preview']['diff']
        self.assertEqual(diff['added_lines'], 1)
        self.assertEqual(diff['removed_lines'], 1)
        self.assertIn('-beta', diff['excerpt'])
        self.assertIn('+BETA', diff['excerpt'])
        self.assertEqual(self.root.joinpath('note.txt').read_text(encoding='utf-8'),
                         'alpha\nbeta\ngamma\n')

    def test_previews_stay_bounded_for_large_payloads(self):
        self.set_flag(True)
        result = self.call('write', {'path': 'big.txt', 'content': 'x' * 200000},
                           self.gate())
        preview = result['preview']
        self.assertEqual(preview['content_chars'], 200000)
        self.assertTrue(preview['content_truncated'])
        self.assertLessEqual(len(preview['content_preview']), dry_run.MAX_PREVIEW_CHARS)
        self.assertLessEqual(len(preview['diff']['excerpt']), dry_run.MAX_DIFF_CHARS)
        self.assertTrue(preview['diff']['truncated'])
        self.assertFalse((self.root / 'big.txt').exists())

    def test_existing_unreadable_file_is_not_reported_as_new_or_written(self):
        self.set_flag(True)
        target = self.root / 'note.txt'
        original = target.read_bytes()
        original_open = Path.open
        target_resolved = target.resolve()

        def deny_target(path, *args, **kwargs):
            if path.resolve() == target_resolved:
                raise PermissionError('fixture unreadable')
            return original_open(path, *args, **kwargs)

        with patch.object(Path, 'open', deny_target):
            result = self.call('write', {'path': 'note.txt', 'content': 'replacement'},
                               self.gate())
        self.assertTrue(result['dry_run'], result)
        self.assertTrue(result['preview']['preview_unavailable'], result)
        self.assertEqual(result['preview']['reason'], 'cannot read existing target')
        self.assertTrue(result['preview']['file_exists'])
        self.assertFalse(result['preview']['readable'])
        self.assertFalse(result['preview'].get('creates_new_file', False), result)
        self.assertEqual(target.read_bytes(), original)

    def test_large_existing_file_is_refused_before_unbounded_read(self):
        self.set_flag(True)
        target = self.root / 'large.txt'
        target.write_bytes(b'x' * (dry_run.MAX_SOURCE_BYTES + 1))
        result = self.call('edit', {'path': 'large.txt', 'old': 'x', 'new': 'y'},
                           self.gate())
        self.assertTrue(result['dry_run'], result)
        self.assertTrue(result['preview']['preview_unavailable'], result)
        self.assertEqual(result['preview']['reason'], 'target exceeds preview size limit')
        self.assertTrue(result['preview']['file_exists'])
        self.assertFalse(result['preview']['readable'])
        self.assertEqual(target.stat().st_size, dry_run.MAX_SOURCE_BYTES + 1)

    def test_binary_existing_file_is_distinguished_from_a_missing_file(self):
        self.set_flag(True)
        target = self.root / 'binary.dat'
        target.write_bytes(b'\xff\xfe\x00')
        result = self.call('write', {'path': 'binary.dat', 'content': 'replacement'},
                           self.gate())
        preview = result['preview']
        self.assertTrue(preview['preview_unavailable'], result)
        self.assertEqual(preview['reason'], 'cannot read existing target')
        self.assertTrue(preview['file_exists'])
        self.assertFalse(preview['readable'])
        self.assertEqual(target.read_bytes(), b'\xff\xfe\x00')

    def test_diff_refuses_to_compare_inputs_over_line_or_character_bound(self):
        self.set_flag(True)
        target = self.root / 'many-lines.txt'
        count = dry_run.MAX_DIFF_COMPARE_LINES // 2 + 1
        old = '\n'.join('old-%04d' % index for index in range(count))
        target.write_text(old, encoding='utf-8')
        replacement = '\n'.join('new-%04d' % index for index in range(count))
        result = self.call('write', {'path': target.name, 'content': replacement},
                           self.gate())
        preview = result['preview']
        self.assertTrue(preview['preview_unavailable'], result)
        self.assertEqual(preview['reason'], 'diff exceeds comparison limit')
        self.assertTrue(preview['file_exists'])
        self.assertTrue(preview['readable'])
        self.assertEqual(target.read_text(encoding='utf-8'), old)
        with self.assertRaises(dry_run.PreviewUnavailable):
            dry_run._diff('a' * (dry_run.MAX_DIFF_COMPARE_CHARS // 2 + 1),
                          'b' * (dry_run.MAX_DIFF_COMPARE_CHARS // 2 + 1))

    def test_exec_previews_the_exact_argv_without_running_it(self):
        self.set_flag(True)
        argv = ['python3', '-c', 'open("ran.txt", "w").write("yes")']
        result = self.call('exec', {'argv': argv}, self.gate())
        preview = result['preview']
        self.assertEqual(preview['action'], 'exec')
        self.assertEqual(preview['argv'], argv)
        self.assertFalse(preview['argv_truncated'])
        self.assertEqual(Path(preview['cwd']), self.root.resolve())
        self.assertFalse(preview['shell'])
        self.assertFalse((self.root / 'ran.txt').exists())

    def test_long_argv_is_truncated_rather_than_dropped(self):
        self.set_flag(True)
        result = self.call('exec', {'argv': ['echo', 'y' * 900]}, self.gate())
        preview = result['preview']
        self.assertTrue(preview['argv_truncated'])
        self.assertEqual(len(preview['argv'][1]), dry_run.MAX_ARG_CHARS)

    def test_edit_preview_reports_whether_the_match_would_apply(self):
        self.set_flag(True)
        gate = self.gate()
        matched = self.call('edit', {'path': 'note.txt', 'old': 'beta', 'new': 'BETA'}, gate)
        self.assertTrue(matched['preview']['would_apply'])
        self.assertEqual(matched['preview']['matches'], 1)
        self.assertEqual(matched['preview']['diff']['added_lines'], 1)
        missing = self.call('edit', {'path': 'note.txt', 'old': 'absent', 'new': 'x'}, gate)
        self.assertEqual(missing['preview']['matches'], 0)
        self.assertFalse(missing['preview']['would_apply'])

    def test_preview_results_are_json_serialisable(self):
        self.set_flag(True)
        for name, args in (('write', {'path': 'w.txt', 'content': 'a'}),
                           ('edit', {'path': 'note.txt', 'old': 'beta', 'new': 'B'}),
                           ('exec', {'argv': ['true']})):
            with self.subTest(tool=name):
                result = self.call(name, args, self.gate())
                json.dumps(result, ensure_ascii=False)
                self.assertTrue(result['dry_run'])
                self.assertFalse(result['executed'])
                self.assertEqual(result['error_code'], 'dry_run_preview')


class DryRunExecutionTests(_Fixture):
    """Nothing lands on disk and no process starts while the switch is on."""

    def gate(self):
        return Gate(self.root, allow_write=True, allow_edit=True, allow_exec=True)

    def test_switch_off_changes_nothing_at_all(self):
        self.set_flag(None)
        gate = self.gate()
        written = self.call('write', {'path': 'off.txt', 'content': 'data\n'}, gate)
        edited = self.call('edit', {'path': 'off.txt', 'old': 'data', 'new': 'DATA'}, gate)
        ran = self.call('exec', {'argv': ['python3', '-c',
                                          'open("marker.txt", "w").write("ran")']}, gate)
        self.assertTrue(written['ok'], written)
        self.assertTrue(edited['ok'], edited)
        self.assertTrue(ran['ok'], ran)
        self.assertEqual((self.root / 'off.txt').read_text(encoding='utf-8'), 'DATA\n')
        self.assertEqual((self.root / 'marker.txt').read_text(encoding='utf-8'), 'ran')
        # A result that grew a dry-run field would mean the flag leaked.
        for result in (written, edited, ran):
            self.assertNotIn('dry_run', result, result)
            self.assertNotIn('preview', result, result)

    def test_write_edit_and_exec_are_previewed_instead_of_run(self):
        self.set_flag(True)
        gate = self.gate()
        results = {
            'write': self.call('write', {'path': 'made.txt', 'content': 'hello\n'}, gate),
            'edit': self.call('edit', {'path': 'note.txt', 'old': 'beta', 'new': 'B'}, gate),
            'exec': self.call('exec', {'argv': ['python3', '-c',
                                                 'open("pwned.txt", "w").write("x")']}, gate),
        }
        for name, result in results.items():
            with self.subTest(tool=name):
                self.assertFalse(result['ok'], result)
                self.assertEqual(result['error'], 'dry_run', result)
                self.assertEqual(result['feature'], 'tools.dry_run_experimental', result)
                self.assertIs(REGISTRY_BY_NAME[name].gate_kind, result['gate_kind'])
        self.assertFalse((self.root / 'made.txt').exists())
        self.assertFalse((self.root / 'pwned.txt').exists())
        self.assertEqual((self.root / 'note.txt').read_text(encoding='utf-8'),
                         'alpha\nbeta\ngamma\n')

    def test_read_only_tools_keep_working(self):
        self.set_flag(True)
        gate = self.gate()
        read = self.call('read', {'path': 'note.txt'}, gate)
        listed = self.call('list', {'path': '.'}, gate)
        globbed = self.call('glob', {'pattern': '*.txt'}, gate)
        grepped = self.call('grep', {'pattern': 'beta'}, gate)
        self.assertTrue(read['ok'] and read['output'].startswith('alpha'), read)
        self.assertIn('note.txt', listed['output'], listed)
        self.assertIn('note.txt', globbed['output'], globbed)
        self.assertEqual(grepped['count'], 1, grepped)
        for result in (read, listed, globbed, grepped):
            self.assertNotIn('dry_run', result, result)

    def test_flag_takes_effect_without_a_restart(self):
        gate = self.gate()
        self.set_flag(False)
        self.assertTrue(self.call('write', {'path': 'toggle.txt', 'content': '1'}, gate)['ok'])
        self.set_flag(True)
        previewed = self.call('write', {'path': 'toggle2.txt', 'content': '2'}, gate)
        self.assertTrue(previewed['dry_run'], previewed)
        self.assertFalse((self.root / 'toggle2.txt').exists())
        self.set_flag(False)
        self.assertTrue(self.call('write', {'path': 'toggle3.txt', 'content': '3'}, gate)['ok'])
        self.assertTrue((self.root / 'toggle3.txt').is_file())

    def test_a_side_effect_without_a_preview_is_refused_and_never_runs(self):
        # web_fetch is a side effect by the Gate's own classification and has no
        # dry-run builder, so the pre-dispatch participant must refuse it before
        # any request leaves the process.
        seen: list = []

        def _fake_fetch(url, *args, **kwargs):
            seen.append(url)
            return {'ok': True, 'output': 'probe', 'dnsSource': 'system'}

        gate = Gate(self.root, allow_write=True, allow_network=True)
        url = 'https://example.invalid/probe'
        with patch('xueness.bundled_plugins.network.tooling.fetch', _fake_fetch):
            self.set_flag(True)
            result = self.call('web_fetch', {'url': url}, gate)
            self.assertFalse(result['ok'], result)
            self.assertEqual(result['error_code'], 'plugin_denied', result)
            self.assertEqual(result['plugin'], 'tools', result)
            self.assertEqual(seen, [], 'the tool ran despite the dry-run refusal')
            # The refusal is recorded for the operator without breaking the run.
            self.assertEqual(
                [row['event'] for row in self.session['tool_event_diagnostics']],
                ['before_tool_execution'])
            self.assertEqual(self.session['tool_event_diagnostics'][0]['kind'], 'deny')
            self.set_flag(False)
            self.assertTrue(self.call('web_fetch', {'url': url}, gate)['ok'], 'baseline')
            self.assertEqual(seen, [url], 'the fetch never reached the transport')


class GateStillDecidesTests(_Fixture):
    """Dry-run replaces an effect, never a decision."""

    def gate(self):
        return Gate(self.root, allow_write=True, allow_edit=True, allow_exec=True)

    def test_plan_mode_refusal_is_untouched(self):
        plan = Gate(self.root, allow_write=True, allow_exec=True,
                    permission_mode='plan')
        self.set_flag(True)
        for name, args in (('write', {'path': 'p.txt', 'content': 'x'}),
                           ('edit', {'path': 'note.txt', 'old': 'beta', 'new': 'B'}),
                           ('exec', {'argv': ['touch', 'p']})):
            with self.subTest(tool=name):
                result = self.call(name, args, plan)
                self.assertEqual(result['error'], 'denied', result)
                self.assertEqual(result['error_code'], 'plan_mode_denied', result)
                self.assertNotIn('dry_run', result, result)
        self.assertFalse((self.root / 'p.txt').exists())

    def test_kernel_plan_mode_refusal_is_untouched(self):
        hard_plan = Gate(self.root, allow_write=True, allow_exec=True, mode='plan')
        self.set_flag(True)
        result = self.call('write', {'path': 'p.txt', 'content': 'x'}, hard_plan)
        self.assertEqual(result['error_code'], 'permission_denied', result)
        self.assertNotIn('dry_run', result, result)
        self.assertFalse((self.root / 'p.txt').exists())

    def test_disallowed_tool_refusal_is_untouched(self):
        self.set_flag(True)
        gate = Gate(self.root, allow_write=True, allow_exec=True, disallow=('exec',))
        result = self.call('exec', {'argv': ['touch', 'never']}, gate)
        self.assertEqual(result['error'], 'denied', result)
        self.assertEqual(result['error_code'], 'permission_denied', result)
        self.assertFalse((self.root / 'never').exists())

    def test_paths_outside_the_workspace_stay_denied(self):
        self.set_flag(True)
        gate = self.gate()
        for name, args in (('write', {'path': '../escape.txt', 'content': 'x'}),
                           ('edit', {'path': '../escape.txt', 'old': 'a', 'new': 'b'}),
                           ('read', {'path': '../escape.txt'})):
            with self.subTest(tool=name):
                result = self.call(name, args, gate)
                self.assertFalse(result['ok'], result)
                self.assertEqual(result['error'], 'denied', result)
                self.assertNotIn('dry_run', result, result)
                self.assertNotIn('preview', result, result)
        self.assertFalse((self.root.parent / 'escape.txt').exists())

    def test_a_preview_never_spends_a_one_shot_approval(self):
        approvals = {SESSION_ID: {'write': {'call-1': 'draft.txt'}}}
        gate = WebGate(self.root, SESSION_ID, approvals, threading.Lock())
        self.set_flag(True)
        result = self.call('write', {'path': 'draft.txt', 'content': 'planned\n',
                                     '_tool_call_id': 'call-1'}, gate)
        self.assertTrue(result['dry_run'], result)
        self.assertTrue(result['requires_approval'], result)
        self.assertFalse(result['awaiting_approval'], result)
        self.assertEqual(result['error'], 'dry_run', result)
        self.assertEqual(approvals[SESSION_ID]['write'], {'call-1': 'draft.txt'},
                         'a preview consumed the operator approval')
        self.assertFalse((self.root / 'draft.txt').exists())
        # The same call with the switch off burns the approval and writes, as it
        # always did -- so the approval path itself is untouched by this feature.
        self.set_flag(False)
        self.assertTrue(self.call('write', {'path': 'draft.txt', 'content': 'planned\n',
                                            '_tool_call_id': 'call-1'}, gate)['ok'])
        self.assertEqual(approvals[SESSION_ID]['write'], {})
        self.assertTrue((self.root / 'draft.txt').is_file())

    def test_an_edit_that_would_fail_is_previewed_without_landing(self):
        # An absent target is not a Gate refusal: with the switch off the handler
        # raises "not a file" after Gate. Dry-run replaces the effect, and the
        # effect it replaces was a failure -- so the preview must say so honestly
        # rather than claim a change, and must not create the file.
        self.set_flag(True)
        result = self.call('edit', {'path': 'absent.txt', 'old': 'a', 'new': 'b'},
                           self.gate())
        self.assertTrue(result['dry_run'], result)
        self.assertFalse(result['executed'], result)
        preview = result['preview']
        self.assertFalse(preview['file_exists'], preview)
        self.assertEqual(preview['matches'], 0, preview)
        self.assertFalse(preview['would_apply'], preview)
        self.assertFalse(preview['diff']['changed'], preview)
        self.assertFalse((self.root / 'absent.txt').exists())
        # Switched back off, the original error is exactly what it always was.
        self.set_flag(False)
        self.assertEqual(self.call('edit', {'path': 'absent.txt', 'old': 'a', 'new': 'b'},
                                   self.gate()), {'ok': False, 'error': 'ValueError'})

    def test_malformed_arguments_keep_their_own_error(self):
        self.set_flag(True)
        gate = self.gate()
        self.assertEqual(self.call('write', {'path': 'bad.txt', 'content': 5}, gate),
                         {'ok': False, 'error': 'ValueError'})
        self.assertEqual(self.call('exec', {'argv': []}, gate),
                         {'ok': False, 'error': 'ValueError'})
        self.assertFalse((self.root / 'bad.txt').exists())


class IsolationTests(_Fixture):
    """The flag belongs to the state directory the call is bound to."""

    def test_other_state_directories_are_unaffected(self):
        other = Path(self.temp.name) / 'other-state'
        other.mkdir()
        gate = Gate(self.root, allow_write=True)
        self.set_flag(True)
        with bind_execution(store=Store(other), state_dir=other):
            plain = dispatch(self.root, gate, 'write',
                             {'path': 'plain.txt', 'content': 'x\n'}, self.session)
        self.assertTrue(plain['ok'], plain)
        self.assertTrue((self.root / 'plain.txt').is_file())
        previewed = self.call('write', {'path': 'shown.txt', 'content': 'y\n'}, gate)
        self.assertTrue(previewed['dry_run'], previewed)
        self.assertFalse((self.root / 'shown.txt').exists())

    def test_sessionless_state_bound_call_still_observes_dry_run(self):
        from xueness.core import execute
        self.set_flag(True)
        gate = Gate(self.root, allow_network=True)
        with patch('xueness.bundled_plugins.network.tooling.fetch') as fetch:
            result = execute(self.root, gate, 'web_fetch',
                             {'url': 'https://example.invalid/no-call'},
                             session=None, state_dir=self.state)
        self.assertEqual(result['error_code'], 'plugin_denied', result)
        fetch.assert_not_called()

    def test_manifest_declares_the_feature_as_data(self):
        manifest = json.loads((Path(dry_run.__file__).parent / 'manifest.json')
                              .read_text(encoding='utf-8'))
        features = {row['id']: row for row in manifest['features']}
        self.assertIn('tools.dry_run_experimental', features)
        self.assertTrue(features['tools.dry_run_experimental']['name'].startswith('工具'))
        self.assertIn('off by default', features['tools.dry_run_experimental']['nameEn'])
        self.assertEqual(manifest['defaultEnabled'], True)
        self.assertEqual(manifest['toolEvents']['events'],
                         ['before_tool_execution', 'before_tool_effect',
                          'after_tool_execution'])
        self.assertIn('tools.call_budget_experimental',
                      {row['id'] for row in manifest['features']})
        self.assertEqual(manifest['tools'], [])
        # Manifests carry no executable code: no module, command or path strings.
        self.assertNotIn('dry_run.py', json.dumps(manifest))
