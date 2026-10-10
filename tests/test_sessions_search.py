import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from xueness import web, plugin_runtime
from xueness.bundled_plugins.sessions import search


class SessionSearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.ctx = web.build_context(base / 'state', base / 'runs', base / 'project', allow_real=False)
        self.store = self.ctx['store']

    def session(self, text, *, archive=False):
        session = self.store.new('unrelated title', self.ctx['web_runs'])
        session['messages'].append({'role': 'assistant', 'content': text})
        session['archived'] = archive
        self.store.save(session)
        return session

    def query(self, needle, **query):
        return search.dispatch('GET', ['api', 'sessions', 'search'], {'q': [needle], **query}, None, self.ctx)

    def test_searches_chinese_content_and_compacted_messages_without_title_match(self):
        first = self.session('背景资料中的独特中文关键词与解释')
        second = self.session('not a hit')
        second['archived_messages'] = [{'role': 'user', 'content': '请查询独特中文关键词'}]
        self.store.save(second)
        status, page = self.query('独特中文关键词')
        self.assertEqual(status, 200)
        hits = {hit['session']['id']: hit for hit in page['matches']}
        self.assertEqual(set(hits), {first['id'], second['id']})
        self.assertTrue(hits[second['id']]['compacted'])
        self.assertIn('独特中文关键词', hits[first['id']]['snippet'])

    def test_does_not_search_system_tools_reasoning_or_archived_conversations(self):
        self.session('unique-hidden', archive=True)
        session = self.session('public answer')
        session['messages'].extend([{'role': 'system', 'content': 'unique-hidden'},
                                    {'role': 'tool', 'content': 'unique-hidden'},
                                    {'role': 'assistant', 'content': 'answer', 'reasoning_content': 'unique-hidden'}])
        self.store.save(session)
        self.assertEqual(self.query('unique-hidden')[1]['matches'], [])

    def test_casefold_and_text_content_blocks(self):
        session = self.session('nothing')
        session['messages'].append({'role': 'user', 'content': [{'type': 'text', 'text': 'Straße overview'}, {'type': 'image_url', 'image_url': {'url': 'strasse-secret'}}]})
        self.store.save(session)
        self.assertEqual(len(self.query('STRASSE')[1]['matches']), 1)
        self.assertEqual(self.query('strasse-secret')[1]['matches'], [])

    def test_pagination_advances_even_when_pages_have_no_matches(self):
        for index in range(4):
            self.session('last hit' if index == 3 else 'no match')
        cursor, scanned, hits, seen = '', 0, [], set()
        with patch.object(search, '_MAX_PAGE_FILES', 1):
            while True:
                status, page = self.query('last hit', after=[cursor])
                self.assertEqual(status, 200)
                scanned += page['scanned']
                hits.extend(page['matches'])
                cursor = page['nextCursor']
                if cursor is None:
                    break
                self.assertNotIn(cursor, seen)
                seen.add(cursor)
        self.assertEqual(scanned, 4)
        self.assertEqual(len(hits), 1)

    def test_plugin_disabled_never_reads_journals(self):
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'sessions', False)
        with patch.object(search, '_read_session', side_effect=AssertionError('disabled search read')):
            self.assertEqual(self.query('test')[0], 403)

    def test_validates_parameters_and_excludes_disallowed_roots(self):
        for query in ({'q': ['']}, {'q': ['a', 'b']}, {'q': ['x' * 201]}, {'q': ['ok'], 'after': ['../../secret']}, {'q': ['ok'], 'root': ['/']}):
            self.assertEqual(search.dispatch('GET', ['api', 'sessions', 'search'], query, None, self.ctx)[0], 400)
        session = self.session('outside-root-keyword')
        session['root'] = str(Path(self.temp.name) / 'outside')
        self.store.save(session)
        status, page = self.query('outside-root-keyword')
        self.assertEqual(status, 200)
        self.assertEqual(page['matches'], [])
        self.assertEqual(page['skipped'], 1)

    def test_skips_corrupt_and_oversize_journals(self):
        session = self.session('public')
        self.store._path(session['id']).write_text('{', encoding='utf-8')
        oversized = self.store.directory / ('a' * 32 + '.json')
        oversized.write_bytes(b'x' * (8 * 1024 * 1024 + 1))
        status, page = self.query('public')
        self.assertEqual(status, 200)
        self.assertEqual(page['matches'], [])
        self.assertEqual(page['skipped'], 2)
