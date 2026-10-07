import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tests.fs_link_helpers import make_symlink
from xueness.core import Store, Gate, run, assess, evidence_aliases
from xueness.plugin_runtime import set_enabled
from xueness.bundled_plugins.planning.delivery import check, plan, seed, normalize
from xueness.bundled_plugins.providers.activity import RequestActivity, public_activity


class QueueProvider:
    def __init__(self, messages):
        self.messages = list(messages)
        self.requests = []
    def complete(self, messages, tools):
        self.requests.append(messages)
        return self.messages.pop(0)


def call(ident, name, args):
    return {'content': '', 'tool_calls': [{'id': ident, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}


class DeliveryReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / 'state')
        self.gate = Gate(self.root)

    def test_short_evidence_survives_reload_and_does_not_accept_invented_references(self):
        session = self.store.new('inspect', self.root)
        session['results'] = {'real-long-call': {'ok': True, 'evidence_id': 'E999'}, 'failed': {'ok': False}}
        aliases = evidence_aliases(session)
        self.assertEqual(aliases, {'E1': 'real-long-call'})
        self.store.save(session)
        self.assertEqual(evidence_aliases(self.store.load(session['id'])), aliases)
        self.assertTrue(assess(json.dumps({'summary': 'read', 'evidence': [{'evidence_id': 'E1', 'observation': 'read file'}]}), session['results'], aliases)['verified'])
        self.assertFalse(assess(json.dumps({'summary': 'read', 'evidence': [{'evidence_id': 'E999', 'observation': 'read file'}]}), session['results'], aliases)['verified'])

    def test_invalid_reference_gets_one_repair_and_no_tool_is_reexecuted(self):
        (self.root / 'input.txt').write_text('known', encoding='utf-8')
        session = self.store.new('inspect', self.root)
        bad = {'content': json.dumps({'summary': 'read', 'evidence': [{'tool_call_id': 'invented', 'observation': 'read'}]})}
        good = {'content': json.dumps({'summary': 'read', 'evidence': [{'evidence_id': 'E1', 'observation': 'read'}]})}
        provider = QueueProvider([call('real', 'read', {'path': 'input.txt'}), bad, good])
        out = run(session, self.store, provider, self.gate, max_steps=5)
        self.assertEqual(out['status'], 'completed')
        self.assertEqual(out['completion_reference_repairs'], 1)
        self.assertEqual(len(out['results']), 1)
        self.assertEqual(out['completion']['delivery_status'], 'not_assessed')
        self.assertTrue(out['completion']['tool_execution_success'])

    def test_second_invalid_reference_stops_review_without_more_requests(self):
        session = self.store.new('inspect', self.root)
        bad = {'content': json.dumps({'summary': 'read', 'evidence': [{'tool_call_id': 'invented', 'observation': 'read'}]})}
        provider = QueueProvider([call('real', 'list', {'path': '.'}), bad, bad])
        out = run(session, self.store, provider, self.gate, max_steps=10)
        self.assertEqual(out['status'], 'needs_review')
        self.assertEqual(len(provider.requests), 3)

    def test_permanent_network_error_stops_without_eleven_retries(self):
        session = self.store.new('research', self.root)
        provider = QueueProvider([call('blocked', 'web_fetch', {'url': 'https://example.com'})])
        with patch('xueness.core.dispatch', return_value={'ok': False, 'error': 'dns_blocked', 'error_code': 'dns_blocked', 'retryable': False, 'user_reason': 'DNS 地址被拦截'}):
            out = run(session, self.store, provider, self.gate, max_steps=20)
        self.assertEqual(out['status'], 'needs_review')
        self.assertEqual(out['pause_reason'], 'DNS 地址被拦截')
        self.assertIs(out['completion']['verified'], False)
        self.assertFalse(out['completion']['tool_execution_success'])
        self.assertEqual(out['pause_reason'], out['completion']['summary'])
        self.assertEqual('not_assessed', out['completion']['delivery_status'])
        self.assertEqual(len(provider.requests), 1)

    def test_approval_pauses_then_host_can_resume(self):
        from xueness.web import WebGate
        import threading
        session = self.store.new('research', self.root)
        provider = QueueProvider([call('approval', 'web_fetch', {'url': 'https://example.com'})])
        gate = WebGate(self.root, session['id'], {}, threading.Lock())
        out = run(session, self.store, provider, gate, max_steps=20)
        self.assertEqual(out['status'], 'paused')
        self.assertEqual(out['pause_code'], 'approval_required')
        self.assertEqual(len(provider.requests), 1)

    def test_tool_success_does_not_certify_missing_person_links_or_file(self):
        session = self.store.new('report', self.root)
        plan(self.root, self.gate, {'items': [{'id': 'report', 'label': '人物资料', 'path': 'report.md', 'contains': ['甲', '乙'], 'min_links': 2}]}, session, None)
        (self.root / 'report.md').write_text('甲 https://example.com/a', encoding='utf-8')
        result = check(self.root, self.gate, session, 'all done', state_dir=self.store.directory)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('缺少内容：乙', result['items'][0]['missing'])
        self.assertTrue(any('链接不足' in text for text in result['items'][0]['missing']))
        (self.root / 'report.md').write_text('甲 乙 https://example.com/a https://example.com/b', encoding='utf-8')
        self.assertEqual(check(self.root, self.gate, session, '', state_dir=self.store.directory)['status'], 'passed')
        set_enabled(self.store.directory, 'files', False)
        self.assertEqual(check(self.root, self.gate, session, '', state_dir=self.store.directory)['status'], 'failed')

    def test_model_cannot_drop_requirements_or_escape_workspace(self):
        session = self.store.new('report', self.root)
        requirement = {'id': 'one', 'label': 'report', 'path': '../private.txt', 'contains': ['required']}
        plan(self.root, self.gate, {'items': [requirement]}, session, None)
        self.assertEqual(check(self.root, self.gate, session, 'required')['status'], 'failed')
        with self.assertRaises(ValueError):
            plan(self.root, self.gate, {'items': [{'id': 'one', 'label': 'report', 'contains': ['easier']}]}, session, None)

    def test_empty_report_file_fails_but_general_zero_byte_file_is_valid(self):
        report = self.store.new('Write a report to report.md', self.root)
        plan(self.root, self.gate, {'items': [{
            'id': 'report-file', 'label': 'Report output', 'path': 'report.md',
        }]}, report, None)
        (self.root / 'report.md').write_bytes(b'')
        rejected = check(self.root, self.gate, report, '')
        self.assertEqual('failed', rejected['status'])
        self.assertIn('报告文件为空', rejected['items'][0]['missing'])
        (self.root / 'report.md').write_text('A short report.', encoding='utf-8')
        self.assertEqual('passed', check(self.root, self.gate, report, '')['status'])

        empty_task = self.store.new('Create an empty file named empty.txt', self.root)
        plan(self.root, self.gate, {'items': [{
            'id': 'empty-file', 'label': 'Requested empty file', 'path': 'empty.txt',
        }]}, empty_task, None)
        (self.root / 'empty.txt').write_bytes(b'')
        self.assertEqual('passed', check(self.root, self.gate, empty_task, '')['status'])

    def test_delivery_checks_visible_content_in_authored_office_formats(self):
        from xueness.bundled_plugins.office import tooling

        authored = {
            'docx': ('brief.docx', 'DOCX_VISIBLE_MARKER', {
                'title': 'Brief title',
                'paragraphs': [{'text': 'DOCX_VISIBLE_MARKER', 'style': 'Normal'}],
            }),
            'pptx': ('slides.pptx', 'PPTX_VISIBLE_MARKER', {
                'slides': [{'title': 'PPTX_VISIBLE_MARKER'}],
            }),
            'xlsx': ('metrics.xlsx', 'XLSX_VISIBLE_MARKER', {
                'sheets': [{'name': 'Data', 'rows': [['XLSX_VISIBLE_MARKER']]}],
            }),
            'pdf': ('notes.pdf', 'PDF_VISIBLE_MARKER', {
                'paragraphs': [{'text': 'PDF_VISIBLE_MARKER', 'style': 'body'}],
            }),
        }
        items = []
        for fmt, (path, marker, document) in authored.items():
            (self.root / path).write_bytes(tooling._build_document(fmt, document))
            items.append({'id': fmt, 'label': fmt.upper(), 'path': path,
                          'contains': [marker], 'min_links': 0})
        session = self.store.new('Create Office deliverables', self.root)
        plan(self.root, self.gate, {'items': items}, session, None)

        result = check(self.root, self.gate, session, '', state_dir=self.store.directory)
        self.assertEqual('passed', result['status'])
        self.assertEqual({'docx', 'pptx', 'xlsx', 'pdf'},
                         {item['id'] for item in result['items'] if item['passed']})

    def test_delivery_does_not_treat_workbook_metadata_as_cell_content(self):
        from xueness.bundled_plugins.office import tooling

        marker = 'XLSX_METADATA_ONLY_MARKER'
        document = {'title': marker, 'sheets': [{'name': 'Data', 'rows': []}]}
        (self.root / 'metadata.xlsx').write_bytes(tooling._build_document('xlsx', document))
        session = self.store.new('Create a workbook', self.root)
        plan(self.root, self.gate, {'items': [{
            'id': 'metadata', 'label': 'Workbook content', 'path': 'metadata.xlsx',
            'contains': [marker],
        }]}, session, None)

        result = check(self.root, self.gate, session, '', state_dir=self.store.directory)
        self.assertEqual('failed', result['status'])
        self.assertIn('缺少内容：' + marker, result['items'][0]['missing'])

    def test_delivery_office_checks_fail_closed_for_missing_and_truncated_content(self):
        from docx import Document
        from xueness.bundled_plugins.office import tooling

        missing_marker = 'REQUESTED_VISIBLE_MARKER'
        (self.root / 'missing.docx').write_bytes(tooling._build_document('docx', {
            'paragraphs': [{'text': 'Different visible content'}],
        }))
        large = Document()
        large.add_paragraph('TRUNCATION_PREFIX ' + ('x' * 9_000))
        large.save(self.root / 'truncated.docx')
        session = self.store.new('Create Word deliverables', self.root)
        plan(self.root, self.gate, {'items': [
            {'id': 'missing', 'label': 'Missing content', 'path': 'missing.docx',
             'contains': [missing_marker]},
            {'id': 'truncated', 'label': 'Truncated content', 'path': 'truncated.docx',
             'contains': ['TRUNCATION_PREFIX']},
        ]}, session, None)

        result = check(self.root, self.gate, session, '', state_dir=self.store.directory)
        self.assertEqual('failed', result['status'])
        self.assertIn('缺少内容：' + missing_marker, result['items'][0]['missing'])
        self.assertFalse(result['items'][1]['passed'])

    def test_delivery_skips_office_parser_when_office_plugin_is_disabled(self):
        from xueness.bundled_plugins.office import tooling

        marker = 'DISABLED_OFFICE_MARKER'
        (self.root / 'disabled.docx').write_bytes(tooling._build_document('docx', {
            'paragraphs': [{'text': marker}],
        }))
        session = self.store.new('Create a Word file', self.root)
        plan(self.root, self.gate, {'items': [{
            'id': 'disabled', 'label': 'Disabled Office file', 'path': 'disabled.docx',
            'contains': [marker],
        }]}, session, None)
        set_enabled(self.store.directory, 'office', False)

        with patch.object(tooling, 'delivery_content_text', side_effect=AssertionError('Office parser called')):
            result = check(self.root, self.gate, session, '', state_dir=self.store.directory)
        self.assertEqual('failed', result['status'])
        self.assertTrue(any('插件已禁用' in text for text in result['items'][0]['missing']))

    def test_delivery_rejects_office_symlink_that_escapes_workspace(self):
        from xueness.bundled_plugins.office import tooling

        outside = self.root.parent / (self.root.name + '-outside.docx')
        outside.write_bytes(tooling._build_document('docx', {
            'paragraphs': [{'text': 'PRIVATE OFFICE CONTENT'}],
        }))
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        make_symlink(self.root / 'linked.docx', outside)
        session = self.store.new('Create a Word file', self.root)
        plan(self.root, self.gate, {'items': [{
            'id': 'linked-office', 'label': 'Linked Office file', 'path': 'linked.docx',
            'contains': ['REQUIRED OFFICE CONTENT'],
        }]}, session, None)

        result = check(self.root, self.gate, session, '', state_dir=self.store.directory)
        self.assertEqual('failed', result['status'])
        self.assertNotIn('PRIVATE OFFICE CONTENT', json.dumps(result))

    def test_delivery_check_rejects_symlinks_that_escape_workspace(self):
        outside = self.root.parent / (self.root.name + '-outside.txt')
        outside.write_text('private content', encoding='utf-8')
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        link = self.root / 'linked-report.md'
        make_symlink(link, outside)
        session = self.store.new('Write a report to linked-report.md', self.root)
        plan(self.root, self.gate, {'items': [{
            'id': 'linked-report', 'label': 'Report output', 'path': 'linked-report.md',
        }]}, session, None)
        result = check(self.root, self.gate, session, '')
        self.assertEqual('failed', result['status'])
        self.assertNotIn('private content', json.dumps(result))

    def test_task_seed_avoids_existing_ids_and_is_idempotent(self):
        session = self.store.new('Write report.md and appendix.csv', self.root)
        session['delivery_requirements'] = [{
            'id': 'output_1', 'label': 'Existing target', 'path': 'existing.txt',
            'contains': [], 'min_links': 0,
        }]
        seed(session)
        seeded = session['delivery_requirements']
        self.assertEqual(['output_1', 'output_2', 'output_3'], [item['id'] for item in seeded])
        self.assertEqual(3, len(normalize(seeded)))
        seed(session)
        self.assertEqual(seeded, session['delivery_requirements'])

    def test_web_document_url_is_not_seeded_as_a_local_output(self):
        session = self.store.new('请读取 https://example.com/docs/guide.md 并报告设置。', self.root)
        seed(session)
        self.assertEqual(session.get('delivery_requirements'), [])

    def test_url_and_local_report_only_seed_the_requested_local_file(self):
        session = self.store.new('Read [source](https://example.com/guide.md), write report.md', self.root)
        seed(session)
        self.assertEqual([item['path'] for item in session['delivery_requirements']], ['report.md'])

    def test_actual_usage_and_observed_phase_times_are_distinct(self):
        now = [0.0]
        session = {}
        with patch('xueness.bundled_plugins.providers.activity.time.monotonic', side_effect=lambda: now[0]):
            activity = RequestActivity(session)
            now[0] = 2; activity.delta('think', reasoning=True)
            now[0] = 5; activity.delta('answer')
            now[0] = 6; activity.complete({'content': 'answer'}, {'prompt_tokens': 200, 'completion_tokens': 20, 'prompt_tokens_details': {'cached_tokens': 100}}, 2)
            activity.tool('read', 'real', 0.25, True)
        record = public_activity(session['runtime_activity'])
        self.assertEqual((record['waitingSeconds'], record['thinkingSeconds'], record['generatingSeconds'], record['toolSeconds']), (2, 3, 1, .25))
        self.assertEqual((record['reportedInputTokens'], record['reportedCachedTokens'], record['retryCount']), (200, 100, 1))
