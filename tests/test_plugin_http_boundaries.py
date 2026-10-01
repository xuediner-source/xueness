"""Cross-surface plugin policy and new API integration without live services."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from xueness import web
from xueness.core import Gate,run
from xueness.plugin_runtime import set_enabled

class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();base=Path(self.temp.name)
        self.ctx=web.build_context(base/'state',base/'work',base/'project',csrf='test')
        self.server=web.create_server(0,self.ctx);threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.base='http://127.0.0.1:'+str(self.server.server_address[1])
        self.session=self.ctx['store'].new('test',self.ctx['web_runs'])
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.temp.cleanup()
    def request(self,path,data=None,csrf=True):
        body=None if data is None else json.dumps(data).encode()
        req=urllib.request.Request(self.base+path,data=body,headers={'Content-Type':'application/json',**({'X-CSRF-Token':'test'} if csrf else {})})
        try:
            with urllib.request.urlopen(req,timeout=5) as res:return res.status,json.loads(res.read())
        except urllib.error.HTTPError as error:
            with error:return error.code,json.loads(error.read())
    def test_plugin_manager_survives_sessions_disabled_and_requires_csrf(self):
        self.assertEqual(self.request('/api/plugins/sessions',{'enabled':False},csrf=False)[0],403)
        self.assertEqual(self.request('/api/plugins/sessions',{'enabled':False})[0],200)
        self.assertEqual(self.request('/api/sessions')[0],403)
        self.assertEqual(self.request('/api/plugins')[0],200)
        self.assertEqual(self.request('/api/plugins/sessions',{'enabled':True})[0],200)
        self.assertEqual(self.request('/api/sessions')[0],200)
    def test_disabled_resource_and_workspace_api_cannot_bypass_ui(self):
        set_enabled(self.ctx['state_dir'],'hooks',False)
        self.assertEqual(self.request('/api/resources/hooks')[0],403)
        set_enabled(self.ctx['state_dir'],'files',False)
        sid=self.session['id']
        self.assertEqual(self.request(f'/api/sessions/{sid}/files')[0],403)
        self.assertEqual(self.request('/api/workflows')[0],403)
        self.assertEqual(self.request(f'/api/sessions/{sid}')[0],200)
    def test_terminal_disable_closes_service_and_reenable_recreates(self):
        old=self.ctx['terminals']
        self.assertEqual(self.request('/api/plugins/terminal',{'enabled':False})[0],200)
        self.assertIsNone(self.ctx['terminals'])
        self.assertEqual(self.request('/api/terminals')[0],403)
        self.assertEqual(self.request('/api/plugins/terminal',{'enabled':True})[0],200)
        self.assertIsNot(self.ctx['terminals'],old)
    def test_model_workflow_action_exact_digest_can_be_approved_and_replayed(self):
        sid=self.session['id']
        code,workflow=self.request('/api/workflows',{'root':str(self.ctx['web_runs']),'plan':{'nodes':[{'id':'actor','kind':'agent','prompt':'inspect'}]}})
        self.assertEqual(code,200)
        args={'workflow_id':workflow['id'],'plan_digest':workflow['plan_digest'],'allow_real':False}
        call={'id':'run-workflow','type':'function','function':{'name':'workflow_run','arguments':json.dumps(args)}}
        self.session['messages'].append({'role':'assistant','content':'','tool_calls':[call]})
        self.session['messages'].append({'role':'tool','tool_call_id':call['id'],'content':'{"ok":false,"error":"denied"}'})
        self.session['results'][call['id']]={'ok':False,'error':'denied'};self.ctx['store'].save(self.session)
        pending=self.request(f'/api/sessions/{sid}')[1]['pending'][0]
        self.assertEqual(pending['kind'],'exec');self.assertIn(workflow['plan_digest'],pending['subject'])
        self.assertEqual(self.request(f'/api/sessions/{sid}/approvals',{'kind':'exec','tool_call_id':call['id']})[0],200)
        gate=web.WebGate(Path(self.session['root']),sid,self.ctx['approvals'],self.ctx['lock'],session=self.session)
        # Avoid spawning a background worker in this approval contract test.
        from unittest.mock import patch
        with patch('xueness.bundled_plugins.workflows.workflows.WorkflowStore.launch',return_value=workflow):
            web.replay_approved(self.session,self.ctx['store'],gate,self.ctx['approvals'],self.ctx['lock'])
        self.assertTrue(self.session['results'][call['id']]['ok'])
        self.assertFalse(self.ctx['approvals'][sid]['exec'])
    def test_durable_model_delta_cursor_survives_completion(self):
        class Provider:
            def stream(self,messages,tools,on_delta):
                on_delta('hello ');on_delta('world');return {'content':'hello world'}
        run(self.session,self.ctx['store'],Provider(),Gate(Path(self.session['root'])),max_steps=1)
        sid=self.session['id'];stream=self.session['stream_history'][-1]['id']
        code,result=self.request(f'/api/sessions/{sid}/deltas?stream_id={stream}&cursor=6')
        self.assertEqual(code,200);self.assertEqual(result['text'],'world');self.assertTrue(result['done'])
        self.assertEqual(self.request(f'/api/sessions/{sid}/deltas?stream_id={stream}&cursor=999')[0],400)
        self.assertEqual(self.request(f'/api/sessions/{sid}/deltas?stream_id={"0"*32}')[0],404)
    def test_diagnostics_omits_transcripts_and_tokens(self):
        self.session['messages'].append({'role':'user','content':'private secret message'});self.ctx['store'].save(self.session)
        code,result=self.request('/api/diagnostics/export')
        self.assertEqual(code,200);self.assertTrue(result['redacted'])
        self.assertNotIn('private secret message',json.dumps(result))
        self.assertNotIn('csrf',json.dumps(result))

if __name__=='__main__': unittest.main()
