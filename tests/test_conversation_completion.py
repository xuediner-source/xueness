"""Conversation regressions use deterministic providers, never live models."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from xueness.core import Gate, Store, run, assess, append_user_turn, _tool_execution_status
from xueness.events import derive_events
from xueness.bundled_plugins.providers.lightweight import stream_answer_text, decode_text_response
from xueness.bundled_plugins.sessions.completion_policy import requires_evidence


class AnswerProvider:
    def __init__(self, content):
        self.content = content

    def complete(self, messages, tools):
        return {'role': 'assistant', 'content': self.content}


class ConversationCompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root / 'state')

    def finish(self, prompt, content):
        session = self.store.new(prompt, self.root)
        return run(session, self.store, AnswerProvider(content), Gate(self.root))

    def test_extended_greeting_is_completed_without_fabricating_tool_evidence(self):
        result = self.finish('你好，请用一句中文打招呼。', json.dumps({'answer': '你好！', 'evidence': []}))
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['completion']['status'], 'not_applicable')
        self.assertFalse(result['completion']['verified'])
        self.assertEqual(result['messages'][-1]['content'], '你好！')

    def test_explicit_workspace_action_without_tools_is_unverified(self):
        result = self.finish('读取工作区 missing.txt，并确认读取成功。', json.dumps({'answer': '读取成功。', 'evidence': []}))
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(result['completion']['status'], 'unverified')
        self.assertFalse(result['completion']['verified'])

    def test_arbitrary_json_is_preserved_instead_of_becoming_a_private_envelope(self):
        content = json.dumps({'summary': 'example', 'values': [1, 2], 'evidence': []})
        self.assertEqual(assess(content, {})['summary'], content)

    def test_markdown_answer_with_terminal_evidence_is_verified_and_preserves_prose(self):
        prose = 'Created **report.docx** and read back both required paragraphs.'
        envelope = json.dumps({'summary': 'Created document', 'evidence': [
            {'evidence_id': 'E2', 'observation': 'Both paragraphs returned by office_read'}]})
        content = prose + '\n\n```json\n' + envelope + '\n```'
        result = assess(content, {'actual-read': {'ok': True}}, {'E2': 'actual-read'})
        self.assertTrue(result['verified'])
        self.assertEqual(result['summary'], prose)
        self.assertEqual(result['evidence'][0]['tool_call_id'], 'actual-read')
        invalid = assess(content, {'actual-read': {'ok': True}}, {'E1': 'actual-read'})
        self.assertFalse(invalid['verified'])
        self.assertEqual(invalid['error_code'], 'invalid_evidence_reference')

    def test_markdown_completion_examples_or_ambiguous_trailers_are_not_stripped(self):
        envelope = json.dumps({'summary': 'Example', 'evidence': [
            {'evidence_id': 'E1', 'observation': 'Example observation'}]})
        trailer = '\n\n```json\n' + envelope + '\n```'
        for content in ('Example:' + trailer, 'Example:' + trailer + '\nMore prose',
                        'Example:' + trailer + trailer):
            with self.subTest(content=content):
                self.assertEqual(assess(content, {}, {})['summary'], content)
        for content in ('Done' + trailer + trailer,
                        'Done\n```json\n{"summary":"sample","evidence":[],"extra":true}\n```'):
            with self.subTest(content=content):
                self.assertEqual(assess(content, {'actual': {'ok': True}}, {'E1': 'actual'})['summary'], content)

    def test_markdown_evidence_between_answer_and_readback_table_preserves_both(self):
        envelope = json.dumps({'summary': 'Created report', 'evidence': [
            {'evidence_id': 'E1', 'observation': 'Read back the unique fixture code'}]})
        before = 'Created **report.docx**.'
        after = '| Paragraph | Content |\n| --- | --- |\n| 1 | bluebird-731 |'
        content = before + '\n\n```json\n' + envelope + '\n```\n\n' + after
        result = assess(content, {'actual': {'ok': True}}, {'E1': 'actual'})
        self.assertTrue(result['verified'])
        self.assertEqual(result['summary'], before + '\n\n' + after)
        self.assertEqual(result['evidence'][0]['tool_call_id'], 'actual')
        self.assertFalse(assess(content, {'actual': {'ok': False}}, {'E1': 'actual'})['verified'])

    def test_successful_tools_remain_successful_when_final_evidence_is_missing(self):
        (self.root / 'note.txt').write_text('known fixture', encoding='utf-8')
        class Provider:
            def __init__(self): self.calls = 0
            def complete(self, messages, tools):
                self.calls += 1
                if self.calls == 1:
                    return {'content':'', 'tool_calls':[{'id':'real-read','type':'function',
                        'function':{'name':'read','arguments':'{"path":"note.txt"}'}}]}
                return {'content':'The file was read, but this answer has no evidence envelope.'}
        session = self.store.new('Read note.txt in this workspace.', self.root)
        result = run(session, self.store, Provider(), Gate(self.root))
        self.assertEqual(result['status'], 'needs_review')
        self.assertTrue(result['completion']['tool_execution_success'])
        self.assertEqual(result['completion']['tool_execution_status'], 'succeeded')
        self.assertFalse(result['completion']['verified'])
        self.assertFalse(result['completion']['delivery_check_passed'])

    def test_plain_code_explanation_and_snippet_do_not_require_tools(self):
        for prompt in ('解释这段 Python 代码：print(1 + 1)', '给我一个计算斐波那契数的 Python 示例。',
                       'How do I implement a binary search in Python?',
                       'Explain how to debug a Python loop.',
                       'Show an example of refactoring a loop.',
                       '解释如何实现二分查找。', '给我一个调试递归的示例。', '解释重构的原则。'):
            with self.subTest(prompt=prompt):
                result = self.finish(prompt, 'A text-only explanation.')
                self.assertEqual(result['status'], 'completed')
                self.assertEqual(result['completion']['status'], 'not_applicable')

    def test_programming_actions_with_workspace_targets_still_require_evidence(self):
        for prompt in ('Implement binary search in this repository.', 'Debug tests/test_core.py.',
                       'Refactor my project.', '请在当前项目实现二分查找。',
                       '调试工作区的程序。', '重构这个文件。', 'Search this repo for configuration files.',
                       '查找工作区里的配置。', '联网搜索最新的 Python 版本。'):
            with self.subTest(prompt=prompt):
                self.assertTrue(requires_evidence({'messages': [{'role': 'user', 'content': prompt}]}))

    def test_json_protocol_normalizes_answer_only_without_unwrapping_ordinary_json(self):
        class JsonProvider(AnswerProvider):
            runtime_profile = 'lightweight'
            context_window = 8192
            max_output_tokens = 512
            tool_calling = 'json'
            compatibility = {}

        for field in ('answer', 'summary'):
            with self.subTest(field=field):
                content = json.dumps({field: '你好！'}, ensure_ascii=False)
                session = self.store.new('你好', self.root)
                result = run(session, self.store, JsonProvider(content), Gate(self.root))
                self.assertEqual(result['status'], 'completed')
                self.assertEqual(result['messages'][-1]['content'], '你好！')
                ordinary = self.finish('请给我一个 JSON 对象。', content)
                self.assertEqual(ordinary['messages'][-1]['content'], content)

    def test_json_protocol_invalid_unicode_finishes_with_review_instead_of_stale_running(self):
        class JsonProvider(AnswerProvider):
            runtime_profile = 'lightweight'
            context_window = 8192
            max_output_tokens = 512
            tool_calling = 'json'
            compatibility = {}

        for content in ('{"answer":"\\ud800","evidence":[]}',
                        '{"tool":"read","arguments":{"path":"\\udc00"}}'):
            with self.subTest(content=content):
                decoded = decode_text_response({'content': content}, [])
                self.assertIn('Unicode', decoded['_protocol_error'])
                session = self.store.new('你好', self.root)
                result = run(session, self.store, JsonProvider(content), Gate(self.root))
                self.assertEqual(result['status'], 'needs_review')
                self.assertEqual(self.store.load(session['id'])['status'], 'needs_review')
                self.assertEqual(result['results'], {})
                for row in result['messages']:
                    if isinstance(row.get('content'), str):
                        row['content'].encode('utf-8')

    def test_multimodal_text_preserves_an_explicit_workspace_evidence_obligation(self):
        blocks = [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,fixture'}},
                  {'type': 'text', 'text': '读取工作区 missing.txt，确认内容。'}]
        self.assertTrue(requires_evidence({'messages': [{'role': 'user', 'content': blocks}]}))
        blocks[-1]['text'] = '请解释图片。'
        self.assertFalse(requires_evidence({'messages': [{'role': 'user', 'content': blocks}]}))

    def test_stream_prefix_hides_wire_data_and_handles_partial_escapes(self):
        self.assertEqual(stream_answer_text('{"tool":"read","arguments":{"path":"private"}}'), '')
        self.assertEqual(stream_answer_text('{"answer":"第一行\\n第二行\\u4e'), '第一行\n第二行')
        self.assertEqual(stream_answer_text('{"answer":"emoji \\ud83d'), 'emoji ')
        self.assertEqual(stream_answer_text('{"answer":"emoji \\ud83d\\ude00","evidence":[]}'), 'emoji 😀')
        self.assertEqual(stream_answer_text('{"answer":"safe \\ude00 suffix"}'), 'safe ')
        self.assertEqual(stream_answer_text('{"answer":"safe \\ud83d suffix"}'), 'safe ')
        self.assertEqual(stream_answer_text('{"answer":"done","evidence":[{"secret":"wire-only"}]}'), 'done')

    def test_json_runtime_stream_publishes_markdown_incrementally(self):
        store = self.store
        snapshots = []
        class StreamingProvider(AnswerProvider):
            runtime_profile = 'lightweight'
            context_window = 8192
            max_output_tokens = 512
            tool_calling = 'json'
            compatibility = {}
            def stream(self, messages, tools, on_delta, **kwargs):
                for chunk in ('{"answer":"Hello', '\\nworld', '","evidence":[]}'):
                    on_delta(chunk)
                    snapshots.append(store.load(session['id'])['streaming'].copy())
                return {'role': 'assistant', 'content': '{"answer":"Hello\\nworld","evidence":[]}'}
        session = self.store.new('你好', self.root)
        result = run(session, self.store, StreamingProvider(''), Gate(self.root))
        self.assertEqual([row['text'] for row in snapshots], ['Hello', 'Hello\nworld', 'Hello\nworld'])
        self.assertTrue(all(row['text_format'] == 'markdown' for row in snapshots))
        self.assertEqual(result['messages'][-1]['content'], 'Hello\nworld')

    def test_successful_retry_recovers_only_the_same_failed_operation(self):
        def call(cid, path):
            return {'id': cid, 'function': {'name': 'read', 'arguments': json.dumps({'path': path})}}
        session = {'messages': [{'role': 'assistant', 'tool_calls': [call('failed', 'a.txt'), call('retry', 'a.txt')]}],
                   'results': {'failed': {'ok': False}, 'retry': {'ok': True}}}
        self.assertEqual(_tool_execution_status(session, ['failed', 'retry']), 'succeeded')
        session['messages'][0]['tool_calls'][1] = call('retry', 'b.txt')
        self.assertEqual(_tool_execution_status(session, ['failed', 'retry']), 'failed')

    def test_completion_events_keep_each_turn_and_do_not_reclassify_previous_answers(self):
        result = self.finish('读取工作区 missing.txt', '{"answer":"未检查","evidence":[]}')
        append_user_turn(result, self.store, '你好')
        result = run(result, self.store, AnswerProvider('你好！'), Gate(self.root))
        events = derive_events(result)
        completions = [row for row in events if row['type'] == 'session.completion']
        self.assertEqual([(row['turnId'], row['status']) for row in completions], [('turn-1', 'unverified'), ('turn-2', 'not_applicable')])
        first = next(row for row in events if row['type'] == 'turn.user')
        self.assertLess(completions[0]['seq'], first['seq'])

    def test_delivery_checker_receives_the_full_answer(self):
        content = 'x' * 4100 + 'required-at-tail'
        with patch('xueness.plugin_runtime.completion_checks', return_value={}) as checker:
            self.finish('给我一段文字', content)
        self.assertEqual(checker.call_args.args[-1], content)

    def test_completed_checklist_allows_ordinary_followups_but_not_new_actions(self):
        (self.root / 'note.txt').write_text('bluebird-731', encoding='utf-8')
        session = self.store.new('Read note.txt.', self.root)
        session['delivery_requirements'] = [{'id': 'note', 'label': 'Note content',
            'path': 'note.txt', 'contains': ['bluebird-731'], 'min_links': 0}]
        class Provider:
            def __init__(self): self.calls = 0
            def complete(self, messages, tools):
                self.calls += 1
                if self.calls == 1:
                    return {'content': '', 'tool_calls': [{'id': 'note-read', 'type': 'function',
                        'function': {'name': 'read', 'arguments': '{"path":"note.txt"}'}}]}
                return {'content': json.dumps({'summary': 'bluebird-731', 'evidence': [
                    {'evidence_id': 'E1', 'observation': 'Read the actual note'}]})}
        result = run(session, self.store, Provider(), Gate(self.root))
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['completion']['delivery_status'], 'passed')
        for prompt in ('What unique code appeared?', 'Explain that code in a sentence.'):
            append_user_turn(result, self.store, prompt)
            result = run(result, self.store, AnswerProvider('bluebird-731'), Gate(self.root))
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(result['completion']['status'], 'not_applicable')
            self.assertEqual(result['completion']['delivery_status'], 'passed')
        append_user_turn(result, self.store, 'Modify note.txt to add a second line.')
        result = run(result, self.store, AnswerProvider('Done without using tools'), Gate(self.root))
        self.assertEqual(result['status'], 'needs_review')

    def test_settled_checklist_exemption_fails_closed_for_missing_changed_and_failed_proofs(self):
        import copy
        import hashlib
        plan = [{'id': 'note', 'label': 'Note', 'path': 'note.txt', 'contains': [], 'min_links': 0}]
        digest = hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=True).encode('ascii')).hexdigest()
        base = {'delivery_requirements': plan, 'messages': [
            {'role': 'user', 'content': 'Read note.txt'}, {'role': 'assistant', 'content': 'Done'},
            {'role': 'user', 'content': 'Hello'}], 'completion_history': [
            {'turn_id': 'turn-1', 'status': 'verified', 'delivery_status': 'passed', 'delivery_plan_digest': digest}]}
        self.assertFalse(requires_evidence(base))
        self.assertTrue(requires_evidence(base, ['new-call']))
        for change in ('changed-plan', 'missing-digest', 'failed-check', 'unverified-turn', 'same-turn'):
            session = copy.deepcopy(base)
            if change == 'changed-plan': session['delivery_requirements'][0]['contains'] = ['new content']
            elif change == 'missing-digest': session['completion_history'][-1].pop('delivery_plan_digest')
            elif change == 'failed-check': session['completion_history'][-1]['delivery_status'] = 'failed'
            elif change == 'unverified-turn': session['completion_history'][-1]['status'] = 'unverified'
            else: session['completion_history'][-1]['turn_id'] = 'turn-2'
            with self.subTest(change=change): self.assertTrue(requires_evidence(session))
