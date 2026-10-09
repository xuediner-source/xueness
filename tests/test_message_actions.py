"""Message history mutations must retain ordering, attachments and CAS safety."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from xueness import web, plugin_runtime
from xueness.bundled_plugins.sessions import message_actions as actions
from xueness.bundled_plugins.sessions.forking import ForkError
from xueness.bundled_plugins.sessions.queue import MessageQueue
from xueness.session_lease import lease


class MessageActionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        project = base / 'project'; project.mkdir()
        self.ctx = web.build_context(base / 'state', base / 'runs', project, allow_real=False, csrf='test-csrf')
        self.store = self.ctx['store']
        self.session = self.store.new('first user', project)
        self.session['messages'] += [
            {'role': 'assistant', 'content': 'first answer'},
            {'role': 'user', 'content': 'second user'},
            {'role': 'assistant', 'content': 'second answer'},
        ]
        self.session.update(status='completed', completion={'summary': 'second answer'},
            message_annotations={'2': {'feedback':'like'}, '4': {'feedback':'dislike'}},
            completion_history=[{'turn_id':'turn-1', 'summary':'first answer'}, {'turn_id':'turn-2', 'summary':'second answer'}],
            reasoning_history=[{'message_index':2, 'text':'first thought'}, {'message_index':4, 'text':'second thought'}])
        self.store.save(self.session)
        self.sid = self.session['id']

    def update(self, index, action='edit', **values):
        return actions.update(self.ctx, self.sid, {'messageIndex':index, 'revision':actions.revision(self.session), 'action':action, **values})

    def test_edit_truncates_only_target_turn_and_later_transcript(self):
        self.update(3, text='new second user')
        result = self.store.load(self.sid)
        self.assertEqual(result['messages'][:-1], self.session['messages'][:3])
        self.assertEqual(result['messages'][-1], {'role':'user','content':'new second user'})
        self.assertEqual(result['completion_history'], self.session['completion_history'][:1])
        self.assertEqual(result['reasoning_history'], self.session['reasoning_history'][:1])
        self.assertEqual(result['message_annotations'], {'2':{'feedback':'like'}})
        self.assertEqual(result['status'], 'pending')
        self.assertIsNone(result['completion'])
        self.assertEqual(list(Path(result['root']).iterdir()), [])

    def test_first_prompt_updates_task_and_keeps_system(self):
        self.update(1, text='replacement first prompt')
        result = self.store.load(self.sid)
        self.assertEqual(result['task'], 'replacement first prompt')
        self.assertEqual(result['messages'][0], self.session['messages'][0])
        self.assertEqual(len(result['messages']), 2)

    def test_attachment_parts_survive_text_edit(self):
        image = {'type':'image_url', 'image_url':{'url':'data:image/png;base64,AA=='}}
        self.session['messages'][3]['content'] = [{'type':'text','text':'old'}, image]
        self.store.save(self.session)
        self.update(3, text='replacement')
        self.assertEqual(self.store.load(self.sid)['messages'][3]['content'], [{'type':'text','text':'replacement'}, image])

    def test_feedback_persists_and_can_be_removed(self):
        self.update(2, 'feedback', feedback='dislike')
        self.session = self.store.load(self.sid)
        self.assertEqual(self.session['message_annotations']['2']['feedback'], 'dislike')
        self.update(2, 'feedback', feedback=None)
        result = self.store.load(self.sid)
        self.assertNotIn('feedback', result['message_annotations']['2'])
        self.assertEqual(result['messages'], self.session['messages'])

    def test_stale_revision_never_overwrites_new_content(self):
        newer = copy.deepcopy(self.session); newer['title']='renamed'; self.store.save(newer)
        with self.assertRaises(ForkError) as error: self.update(3, text='stale edit')
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.store.load(self.sid), newer)

    def test_active_session_and_live_stream_reject_mutation(self):
        for marker in ['running', 'streaming']:
            with self.subTest(marker=marker):
                if marker == 'running': self.ctx['running'].add(self.sid)
                else: self.session['streaming']={'status':'streaming'}; self.store.save(self.session)
                with self.assertRaises(ForkError) as error: self.update(3, text='blocked')
                self.assertEqual(error.exception.status, 409)
                self.ctx['running'].discard(self.sid)

    def test_lease_rejects_competing_process(self):
        with lease(self.store, self.sid):
            with self.assertRaises(ForkError) as error: self.update(2, 'feedback', feedback='like')
            self.assertEqual(error.exception.status, 409)

    def test_input_and_role_validation_leave_journal_unchanged(self):
        for index, action, values in [(True,'edit',{'text':'no'}), (-1,'edit',{'text':'no'}),
                (0,'edit',{'text':'no'}), (2,'edit',{'text':'no'}), (3,'feedback',{'feedback':'like'}),
                (3,'edit',{'text':''}), (3,'edit',{'text':'bad\x00input'}), (2,'feedback',{'feedback':'bad'})]:
            with self.subTest(index=index,action=action,values=values):
                with self.assertRaises(ForkError): self.update(index,action,**values)
                self.assertEqual(self.store.load(self.sid), self.session)

    def test_orphan_tool_results_removed_and_earlier_results_retained(self):
        self.session['messages'][2]['tool_calls']=[{'id':'earlier'}]
        self.session['messages'][4]['tool_calls']=[{'id':'later'}]
        self.session['results']={'earlier':{'ok':True}, 'later':{'ok':True}}
        self.store.save(self.session)
        self.update(3,text='replacement')
        self.assertEqual(self.store.load(self.sid)['results'], {'earlier':{'ok':True}})

    def test_queue_prevents_history_replacement(self):
        queue = MessageQueue(self.store)
        with queue.session_lock(self.sid):
            record=queue._read(self.sid)
            record['items']=[{'id':'a'*32,'text':'pending','status':'paused','created_at':'now'}]
            queue._atomic_save(self.sid,record)
        with self.assertRaises(ForkError) as error: self.update(3,text='replacement')
        self.assertEqual(error.exception.status,409)

    def test_http_requires_csrf_and_enabled_plugin_and_journal_revision(self):
        server=web.create_server(0,self.ctx)
        worker=threading.Thread(target=server.serve_forever,daemon=True); worker.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        origin=f'http://127.0.0.1:{server.server_address[1]}'
        with urllib.request.urlopen(f'{origin}/api/sessions/{self.sid}/journal',timeout=5) as response:
            journal=json.load(response)
        self.assertEqual(journal['message_revision'],actions.revision(self.session))
        with urllib.request.urlopen(f'{origin}/api/sessions/{self.sid}/conversation',timeout=5) as response:
            snapshot=json.load(response)
        self.assertEqual(snapshot['journal'],journal)
        self.assertEqual(snapshot['session']['status'],snapshot['timeline']['status'])
        self.assertEqual(snapshot['timeline']['hasMore'],False)
        payload={'action':'feedback','messageIndex':2,'revision':journal['message_revision'],'feedback':'like'}
        def request(csrf=True):
            headers={'Content-Type':'application/json','Origin':origin}
            if csrf:headers['X-CSRF-Token']='test-csrf'
            return urllib.request.urlopen(urllib.request.Request(f'{origin}/api/sessions/{self.sid}/message-actions',
                data=json.dumps(payload).encode(),headers=headers,method='PATCH'),timeout=5)
        with self.assertRaises(urllib.error.HTTPError) as denied:request(False)
        self.assertEqual(denied.exception.code,403)
        with request() as response:self.assertEqual(response.status,200)
        plugin_runtime.set_enabled(self.ctx['state_dir'],'sessions',False)
        with self.assertRaises(urllib.error.HTTPError) as disabled:request()
        self.assertEqual(disabled.exception.code,403)

    def test_snapshot_contains_history_beyond_cursor_page_limit(self):
        from xueness.bundled_plugins.sessions.conversation_snapshot import snapshot
        self.session['messages'] += [{'role':'assistant','content':f'part {i}'} for i in range(601)]
        self.store.save(self.session)
        value=snapshot(self.ctx,self.sid)
        self.assertGreater(len(value['timeline']['events']),500)
        self.assertEqual(value['timeline']['head'],len(value['timeline']['events']))
        self.assertEqual(value['timeline']['nextCursor'],value['timeline']['head'])
        self.assertEqual(value['journal']['message_revision'],actions.revision(self.session))

    def test_malformed_saved_metadata_refuses_edit_without_changing_journal(self):
        for field, value in [('streaming', 'broken'), ('reasoning_history', {}),
                             ('completion_history', 'broken'), ('message_annotations', [])]:
            with self.subTest(field=field):
                self.session[field] = value
                self.store.save(self.session)
                before = self.store._path(self.sid).read_bytes()
                with self.assertRaises(ForkError) as error:
                    self.update(3, text='replacement')
                self.assertEqual(error.exception.status, 409)
                self.assertEqual(self.store._path(self.sid).read_bytes(), before)
                self.session.pop(field)

    def test_snapshot_reports_missing_and_malformed_journals(self):
        from xueness.bundled_plugins.sessions.conversation_snapshot import dispatch
        missing = dispatch('GET', ['api', 'sessions', 'a'*32, 'conversation'], {}, {}, self.ctx)
        self.assertEqual(missing[0], 404)
        self.store._path(self.sid).write_text('[]', encoding='utf-8')
        invalid = dispatch('GET', ['api', 'sessions', self.sid, 'conversation'], {}, {}, self.ctx)
        self.assertEqual(invalid[0], 409)

class FeedbackCompactionTests(unittest.TestCase):
    def test_retained_feedback_moves_with_its_original_message(self):
        from xueness.core import compact
        from tests.test_batch5 import _long_journal
        session=_long_journal()
        old_messages=session['messages']
        session['message_annotations']={str(i):{'feedback':'like','marker':i} for i,m in enumerate(old_messages) if m['role']=='assistant'}
        compact(session,4000)
        self.assertTrue(session['compactions'])
        for index,annotation in session['message_annotations'].items():
            self.assertIs(session['messages'][int(index)],old_messages[annotation['marker']])
        self.assertLess(len(session['message_annotations']),sum(m['role']=='assistant' for m in old_messages))
