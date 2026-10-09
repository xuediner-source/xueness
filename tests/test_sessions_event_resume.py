"""sessions.event_resume: epoch snapshot, resume, and forced resync.

The frozen events.v1 route stays numeric and still treats a cursor past head
as an empty page. This route is the opt-in replacement for reconnects.
"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from xueness import events as events_protocol
from xueness import web
from xueness.bundled_plugins.sessions import event_resume
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.plugin_runtime import set_enabled


def _session(messages, *, status='running', steps=2, mode=''):
    return {
        'id': 'ignored',
        'task': 'test task',
        'root': '/tmp',
        'status': status,
        'steps': steps,
        'mode': mode,
        'messages': [
            {'role': 'system', 'content': 's'},
            {'role': 'user', 'content': 'task'},
            *messages,
        ],
        'results': {},
    }


def _texts(n):
    return [{'role': 'assistant', 'content': f'line-{index}'} for index in range(n)]


class ParseTests(unittest.TestCase):
    def test_absent_base_is_a_snapshot(self):
        self.assertIsNone(event_resume.requested_base({}, ''))
        self.assertIsNone(event_resume.requested_base({'limit': ['10']}, '  '))

    def test_epoch_and_seq_are_required_together(self):
        with self.assertRaises(event_resume.ResumeError):
            event_resume.requested_base({'seq': ['1']}, '')
        with self.assertRaises(event_resume.ResumeError):
            event_resume.requested_base({'log_epoch': ['a' * 64]}, '')

    def test_aliases_must_agree(self):
        epoch = 'ab' * 32
        base = event_resume.requested_base(
            {'log_epoch': [epoch], 'logEpoch': [epoch], 'seq': ['3']}, '')
        self.assertEqual(base, event_resume.Base(3, epoch))
        with self.assertRaises(event_resume.ResumeError):
            event_resume.requested_base(
                {'log_epoch': [epoch], 'logEpoch': ['cd' * 32], 'seq': ['3']}, '')

    def test_header_and_query_conflict(self):
        epoch = 'ab' * 32
        other = 'cd' * 32
        header = '4.' + epoch
        self.assertEqual(
            event_resume.requested_base({'logEpoch': [epoch], 'seq': ['4']}, header),
            event_resume.Base(4, epoch))
        with self.assertRaises(event_resume.ResumeError):
            event_resume.requested_base({'logEpoch': [other], 'seq': ['4']}, header)

    def test_malformed_values_are_400(self):
        for query in (
            {'seq': ['-1'], 'logEpoch': ['ab' * 32]},
            {'seq': ['1'], 'logEpoch': ['AB' * 32]},
            {'seq': ['1'], 'logEpoch': ['ab' * 31]},
            {'seq': ['1.5'], 'logEpoch': ['ab' * 32]},
            {'profile': ['desktop']},
            {'limit': ['nope']},
        ):
            with self.subTest(query=query):
                with self.assertRaises(event_resume.ResumeError) as raised:
                    if 'profile' in query:
                        event_resume.requested_profile(query)
                    elif 'limit' in query:
                        event_resume.requested_limit(query, snapshot=True)
                    else:
                        event_resume.requested_base(query, '')
                self.assertEqual(raised.exception.status, 400)

    def test_limit_defaults_follow_the_mode(self):
        self.assertEqual(event_resume.requested_limit({}, snapshot=True), 60)
        self.assertEqual(event_resume.requested_limit({}, snapshot=False), 200)
        self.assertEqual(event_resume.requested_limit({'limit': ['0']}, snapshot=True), 1)
        self.assertEqual(event_resume.requested_limit({'limit': ['900']}, snapshot=False), 500)


class PageTests(unittest.TestCase):
    def setUp(self):
        self.session = _session(_texts(3), status='running', steps=4, mode='build')
        self.events = events_protocol.derive_events(self.session)

    def test_status_is_not_part_of_the_epoch(self):
        first = event_resume.page(self.session, None, 60, 'replayable')
        moved = json.loads(json.dumps(self.session))
        moved['status'] = 'completed'
        moved['steps'] = 9
        moved['mode'] = 'plan'
        second = event_resume.page(moved, None, 60, 'replayable')
        self.assertEqual(first['logEpoch'], second['logEpoch'])
        self.assertEqual(second['status'], 'completed')
        self.assertEqual(second['steps'], 9)
        self.assertEqual(second['mode'], 'plan')
        self.assertNotIn('session.status', [event['type'] for event in second['events']])

    def test_profiles_share_an_epoch_and_close_status_in_the_envelope(self):
        replayable = event_resume.page(self.session, None, 60, 'replayable')
        continuous = event_resume.page(self.session, None, 60, 'continuous')
        self.assertEqual(replayable['logEpoch'], continuous['logEpoch'])
        self.assertEqual(replayable['status'], continuous['status'])
        self.assertTrue(any(event['type'] == 'session.status' for event in continuous['events']))
        self.assertFalse(any(event['type'] == 'session.status' for event in replayable['events']))
        self.assertEqual(
            [event for event in continuous['events'] if event['type'] != 'session.status'],
            replayable['events'])

    def test_append_keeps_the_old_base_and_returns_only_new_rows(self):
        first = event_resume.page(self.session, None, 60, 'replayable')
        longer = _session(_texts(4), status='running', steps=4)
        longer['id'] = self.session['id']
        base = event_resume.Base(first['nextCursor'], first['logEpoch'])
        resumed = event_resume.page(longer, base, 200, 'replayable')
        self.assertEqual(resumed['resumeMode'], 'resume')
        self.assertEqual([event['type'] for event in resumed['events']], ['assistant.text'])
        self.assertIn('line-3', resumed['events'][0]['preview'])
        self.assertFalse(resumed['hasMore'])
        self.assertNotEqual(resumed['logEpoch'], first['logEpoch'])

    def test_rewritten_prefix_is_a_snapshot_not_an_empty_page(self):
        first = event_resume.page(self.session, None, 60, 'continuous')
        rewritten = _session(
            [{'role': 'assistant', 'content': 'replaced'}], status='paused', steps=1)
        rewritten['id'] = self.session['id']
        base = event_resume.Base(first['nextCursor'], first['logEpoch'])
        with self.assertRaises(event_resume.ResyncRequired) as raised:
            event_resume.page(rewritten, base, 60, 'replayable')
        body = raised.exception.body
        self.assertTrue(body['resync'])
        self.assertEqual(body['resumeMode'], 'snapshot')
        self.assertNotEqual(body['logEpoch'], first['logEpoch'])
        self.assertNotIn('line-0', json.dumps(body['events']))
        self.assertIn('replaced', json.dumps(body['events']))

    def test_seq_past_head_resyncs(self):
        origin = event_resume.page(self.session, None, 60, 'replayable')
        with self.assertRaises(event_resume.ResyncRequired) as raised:
            event_resume.page(
                self.session,
                event_resume.Base(origin['head'] + 5, origin['logEpoch']),
                60, 'replayable')
        self.assertIn('ahead', str(raised.exception))

    def test_origin_pages_the_full_log_after_a_tail_snapshot(self):
        long = _session(_texts(70))
        long['id'] = 'abc'
        snap = event_resume.page(long, None, 60, 'replayable')
        self.assertTrue(snap['gapBefore'])
        self.assertEqual(snap['head'], 71)
        self.assertEqual(len(snap['events']), 60)
        self.assertFalse(snap['hasMore'])
        full = event_resume.page(
            long, event_resume.Base(0, snap['originEpoch']), 500, 'replayable')
        self.assertEqual(full['resumeMode'], 'resume')
        self.assertEqual(full['fromSeq'], 0)
        self.assertEqual(full['nextCursor'], 71)
        self.assertEqual(len(full['events']), 70)

    def test_same_length_replacement_does_not_look_caught_up(self):
        # events.v1 would return an empty page for a cursor equal to the old
        # head after the text changed but the count did not. Resume must not.
        first = event_resume.page(self.session, None, 60, 'replayable')
        replaced = _session(_texts(3))
        replaced['id'] = self.session['id']
        replaced['messages'][-1]['content'] = 'different tail'
        with self.assertRaises(event_resume.ResyncRequired):
            event_resume.page(
                replaced,
                event_resume.Base(first['nextCursor'], first['logEpoch']),
                60, 'replayable')

    def test_sse_cursor_id_round_trips(self):
        envelope = event_resume.page(self.session, None, 60, 'replayable')
        body = event_resume.sse_body(self.session, envelope).decode()
        self.assertIn('event: resume.cursor', body)
        last_id = [line[4:] for line in body.splitlines() if line.startswith('id: ')][-1]
        base = event_resume.requested_base({}, last_id)
        resumed = event_resume.page(self.session, base, 200, 'replayable')
        self.assertEqual(resumed['events'], [])
        self.assertEqual(resumed['nextCursor'], envelope['nextCursor'])


def _start(ctx):
    server = web.create_server(0, ctx)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class EventResumeRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.ctx = web.build_context(base / 'state', base / 'runs', base / 'project',
                                     allow_real=False, csrf='test-csrf-token')
        self.server = _start(self.ctx)
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.sid = self.ctx['store'].new('test task', self.ctx['web_runs'])['id']
        session = _session(_texts(2), status='running', steps=2)
        session['id'] = self.sid
        session['root'] = str(self.ctx['web_runs'])
        self.ctx['store'].save(session)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def _enable(self, enabled=True):
        save_settings(self.ctx['state_dir'],
                      {'general': {'sessionsEventResumeEnabled': enabled}})

    def _get(self, path, accept=None, headers=None):
        req = urllib.request.Request(self.base + path)
        if accept:
            req.add_header('Accept', accept)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read().decode('utf-8'), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, exc.read().decode('utf-8', 'replace'), dict(exc.headers)
            finally:
                exc.close()

    def _post(self, path, data, csrf='test-csrf-token'):
        header = {'Content-Type': 'application/json'}
        if csrf is not None:
            header['X-CSRF-Token'] = csrf
        req = urllib.request.Request(self.base + path, data=json.dumps(data).encode(),
                                     headers=header)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read())
            finally:
                exc.close()

    def _path(self, query=''):
        suffix = ('?' + query) if query else ''
        return f'/api/sessions/{self.sid}/events.resume{suffix}'

    def test_flag_off_does_not_reveal_the_session_and_v1_is_unchanged(self):
        code, body, _ = self._get(self._path())
        self.assertEqual(code, 400)
        payload = json.loads(body)
        self.assertEqual(payload['error'], 'sessions.event_resume not enabled')
        missing = self._get('/api/sessions/' + ('b' * 32) + '/events.resume')
        self.assertEqual(missing[0], 400)
        v1 = self._get(f'/api/sessions/{self.sid}/events.v1?cursor=999')
        self.assertEqual(v1[0], 200)
        envelope = json.loads(v1[1])
        self.assertEqual(envelope['schema'], 'xueness.events.v1')
        self.assertEqual(envelope['events'], [])
        self.assertEqual(envelope['nextCursor'], 999)

    def test_flag_toggles_without_restart_and_rejects_non_booleans(self):
        self._enable(True)
        self.assertEqual(self._get(self._path())[0], 200)
        self._enable(False)
        self.assertEqual(self._get(self._path())[0], 400)
        save_settings(self.ctx['state_dir'],
                      {'general': {'sessionsEventResumeEnabled': 'true'}})
        self.assertEqual(self._get(self._path())[0], 400)
        code, payload = self._post('/api/settings/general',
                                   {'values': {'sessionsEventResumeEnabled': True}})
        self.assertEqual(code, 200, payload)
        self.assertEqual(self._get(self._path())[0], 200)
        code, payload = self._post('/api/settings/general',
                                   {'values': {'sessionsEventResumeEnabled': 'yes'}})
        self.assertEqual(code, 400)
        self.assertIn('sessionsEventResumeEnabled', payload['error'])

    def test_snapshot_resume_and_rewrite_over_http(self):
        self._enable(True)
        code, body, _ = self._get(self._path('profile=continuous'))
        self.assertEqual(code, 200)
        snap = json.loads(body)
        self.assertEqual(snap['schema'], 'xueness.events.resume.v1')
        self.assertEqual(snap['resumeMode'], 'snapshot')
        self.assertEqual(snap['deliveryProfile'], 'continuous')
        self.assertFalse(snap['gapBefore'])
        session = self.ctx['store'].load(self.sid)
        session['messages'].append({'role': 'assistant', 'content': 'later line'})
        self.ctx['store'].save(session)
        query = f"log_epoch={snap['logEpoch']}&seq={snap['nextCursor']}"
        code, body, _ = self._get(self._path(query))
        self.assertEqual(code, 200)
        resumed = json.loads(body)
        self.assertEqual(resumed['resumeMode'], 'resume')
        self.assertEqual(len(resumed['events']), 1)
        # Rewrite a row the client already consumed. A change past the base
        # would still resume; a change inside the prefix must resync.
        session['messages'][2]['content'] = 'rewritten line'
        self.ctx['store'].save(session)
        code, body, _ = self._get(self._path(query))
        self.assertEqual(code, 409)
        rejected = json.loads(body)
        self.assertEqual(rejected['errorCode'], 'sessions.event_resume.resync_required')
        self.assertTrue(rejected['resync'])
        self.assertEqual(rejected['resumeMode'], 'snapshot')

    def test_sse_last_event_id_resumes(self):
        self._enable(True)
        code, body, headers = self._get(self._path(), accept='text/event-stream')
        self.assertEqual(code, 200)
        self.assertIn('text/event-stream', headers.get('Content-Type', ''))
        last_id = [line[4:] for line in body.splitlines() if line.startswith('id: ')][-1]
        code, body, _ = self._get(self._path(), headers={'Last-Event-ID': last_id})
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual(payload['resumeMode'], 'resume')
        self.assertEqual(payload['events'], [])

    def test_post_is_405_and_cross_origin_is_403(self):
        self._enable(True)
        code, payload = self._post(self._path(), {})
        self.assertEqual(code, 405, payload)
        code, body, _ = self._get(self._path(), headers={'Origin': 'http://evil.example'})
        self.assertEqual(code, 403)
        self.assertIn('host not permitted', body)

    def test_disabled_plugin_wins(self):
        self._enable(True)
        set_enabled(self.ctx['state_dir'], 'sessions', False)
        self.assertEqual(self._get(self._path())[0], 403)
        set_enabled(self.ctx['state_dir'], 'sessions', True)
        self.assertEqual(self._get(self._path())[0], 200)

    def test_bad_sid_is_not_found(self):
        self._enable(True)
        self.assertEqual(self._get('/api/sessions/not-a-sid/events.resume')[0], 404)
        self.assertEqual(self._get('/api/sessions/' + ('c' * 32) + '/events.resume')[0], 404)
