"""New gap capabilities exercised against real local state and mock transports."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from xueness.bundled_plugins.automation.scheduler import Automations, next_run
from xueness.bundled_plugins.extensions.marketplace import catalog, install
from xueness.bundled_plugins.git.actions import checkpoint, restore, action, checkpoints
from xueness.bundled_plugins.mcp import oauth
from xueness.bundled_plugins.memory import editor
from xueness.bundled_plugins.settings.preferences import validate
from xueness.bundled_plugins.network import transport as network
from xueness.plugin_runtime import set_enabled

class GapTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'work';self.root.mkdir();self.state=Path(self.temp.name)/'state'
    def git(self,*argv):
        return subprocess.run(['git',*argv],cwd=self.root,text=True,capture_output=True,check=True).stdout.strip()
    def init_git(self):
        self.git('init');self.git('config','user.name','test');self.git('config','user.email','test@example.test')
        (self.root/'file.txt').write_text('base');self.git('add','file.txt');self.git('commit','-m','base')
    def test_checkpoint_preserves_index_and_restores_with_recovery(self):
        self.init_git();(self.root/'file.txt').write_text('staged');self.git('add','file.txt')
        (self.root/'file.txt').write_text('snapshot');(self.root/'new.txt').write_text('new')
        before=self.git('diff','--cached');snap=checkpoint(str(self.root),'first')
        self.assertEqual(before,self.git('diff','--cached'))
        (self.root/'file.txt').write_text('later')
        result=restore(str(self.root),snap['id'])
        self.assertEqual((self.root/'file.txt').read_text(),'snapshot')
        self.assertEqual(before,self.git('diff','--cached'))
        self.assertEqual(len(checkpoints(str(self.root))),2)
        restore(str(self.root),result['recovery']['id'])
        self.assertEqual((self.root/'file.txt').read_text(),'later')
    def test_git_requires_review_and_jails_paths(self):
        self.init_git()
        with self.assertRaises(ValueError): action(str(self.root),'stage',{'paths':['file.txt']})
        with self.assertRaises(ValueError): action(str(self.root),'stage',{'confirmed':True,'paths':['../outside']})
        self.assertTrue(action(str(self.root),'branch',{'confirmed':True,'create':True,'name':'test-next'})['ok'])
        self.assertEqual(self.git('branch','--show-current'),'test-next')
    def test_schedule_timezone_and_due_claim_only_once(self):
        from datetime import datetime,timezone
        now=datetime(2026,9,30,0,0,tzinfo=timezone.utc).timestamp()
        self.assertEqual(next_run('0 9 * * *','Asia/Shanghai',now),now+3600)
        store=Automations(self.state)
        item=store.save({'name':'daily','enabled':True,'schedule':'* * * * *','timezone':'UTC','workflow':{'root':str(self.root),'nodes':[{'id':'a','argv':['echo','hi']}]}})
        future=item['nextRunAt']+1
        run=store.run(item['id'],due=True,now=future)
        self.assertEqual(run['status'],'awaiting_approval')
        self.assertIsNone(store.run(item['id'],due=True,now=future))
        self.assertEqual(len(store.list()[0]['history']),1)
    def test_automation_amendment_resets_execution_grant_and_disable_blocks(self):
        store=Automations(self.state);item=store.save({'name':'test','enabled':False,'schedule':'* * * * *','workflow':{'root':str(self.root),'nodes':[{'id':'a','argv':['echo','hi']}]}})
        self.assertTrue(store.approve(item['id'])['approved'])
        changed=store.save({'workflow':{'root':str(self.root),'nodes':[{'id':'a','argv':['echo','other']}]}},item['id'])
        self.assertFalse(changed['approved'])
        set_enabled(self.state,'automation',False)
        with self.assertRaises(ValueError): store.run(item['id'])
    def test_marketplace_digest_and_disabled_install(self):
        with patch.dict(os.environ,{'XUENESS_MARKETPLACE_URL':''}):
            row=catalog(self.state)[0]
            with self.assertRaises(ValueError): install(self.state,row['id'],'0'*64)
            self.assertTrue(install(self.state,row['id'],row['sha256'])['ok'])
            raw=json.loads((self.state/'resources/plugins'/f"{row['id']}.json").read_text())
            self.assertFalse(raw['enabled'])
            self.assertEqual(catalog(self.state)[0]['installedVersion'],'1.0.0')
    def server(self):
        return {'id':'test','url':'https://mcp.example.test/mcp','oauth':{'authorizationEndpoint':'https://auth.example.test/authorize','tokenEndpoint':'https://auth.example.test/token','clientId':'local','redirectUri':'http://127.0.0.1:7777/callback'}}
    def test_oauth_pkce_state_token_secrecy_refresh(self):
        server=self.server();start=oauth.begin(self.state,server)
        self.assertIn('code_challenge_method=S256',start['authorizationUrl'])
        self.assertIn('resource=',start['authorizationUrl'])
        with self.assertRaises(ValueError): oauth.finish(self.state,server,'code','wrong')
        with patch.object(oauth,'_post',return_value={'access_token':'private-token','refresh_token':'refresh','expires_at':time.time()+1}) as exchange:
            public=oauth.finish(self.state,server,'code',start['state'])
            self.assertNotIn('private-token',json.dumps(public))
            self.assertEqual(oauth.bearer(self.state,server),'private-token')
            self.assertEqual(exchange.call_count,2)
        self.assertEqual((self.state/'mcp-oauth/test.json').stat().st_mode & 0o777,0o600)
        self.assertFalse(oauth.revoke(self.state,'test')['authorized'])
    def test_memory_conflict_prevents_overwrite_and_symlink_is_denied(self):
        memory=self.root/'memory';memory.mkdir();ctx={'state_dir':self.state,'project_dir':self.root}
        with patch.dict(os.environ,{'XUENESS_MEMORY_ROOT':str(memory)}):
            before=editor.read(ctx,'memory')
            editor.write(ctx,'memory',{'confirmed':True,'digest':before['digest'],'content':'curated'})
            with self.assertRaises(LookupError): editor.write(ctx,'memory',{'confirmed':True,'digest':before['digest'],'content':'stale'})
            (memory/'USER.md').symlink_to(self.root/'outside.txt')
            with self.assertRaises(ValueError): editor.read(ctx,'user')
    def test_automation_persisted_grant_cannot_bypass_host_provider_policy(self):
        store=Automations(self.state)
        item=store.save({'name':'real','enabled':False,'schedule':'* * * * *','workflow':{'root':str(self.root),'nodes':[{'id':'a','kind':'agent','prompt':'work'}]}})
        store.approve(item['id'],allow_real=True)
        with patch('xueness.bundled_plugins.workflows.workflows.WorkflowStore.launch') as launch:
            result=store.run(item['id'],allow_real_host=False)
            self.assertEqual(result['status'],'awaiting_approval')
            launch.assert_not_called()
    def test_marketplace_cannot_write_through_resources_parent_symlink(self):
        from xueness import plugin_sdk
        outside=self.root/'outside';outside.mkdir();self.state.mkdir()
        (self.state/'resources').symlink_to(outside)
        row={'id':'test','version':'1.0.0','apiVersion':1,'builtin':'skills','enabled':False,'capabilities':[]}
        self.assertFalse(plugin_sdk.install_all(self.state,[row])['ok'])
        self.assertFalse(list(outside.iterdir()))
        self.assertEqual(plugin_sdk.load_manifests(self.state),[])

    def test_keyboard_registry_conflicts_reserved_keys_and_appearance_bounds(self):
        with self.assertRaises(ValueError): validate('shortcuts',{'bindings':{'new-session':'Mod+K','command-palette':'Mod+K'}})
        with self.assertRaises(ValueError): validate('shortcuts',{'bindings':{'new-session':'Mod+K'}})
        with self.assertRaises(ValueError): validate('shortcuts',{'bindings':{'new-session':'Meta+K'}})
        with self.assertRaises(ValueError): validate('shortcuts',{'bindings':{'stop-run':'Mod+S'}})
        with self.assertRaises(ValueError): validate('shortcuts',{'bindings':{'open-settings':'Mod+R'}})
        with self.assertRaises(ValueError): validate('shortcuts',{'bindings':{'open-settings':'F5'}})
        with self.assertRaises(ValueError): validate('shortcuts',{'bindings':{'new-session':'Ctrl+K'}})
        self.assertEqual(validate('shortcuts',{'bindings':{
            'new-session':'', 'command-palette':'Mod+N', 'open-settings':'Alt+Shift+S',
            'toggle-sidebar':'Alt+Shift+B', 'refresh-session':'Alt+Shift+R',
        }})['bindings']['new-session'], '')
        with self.assertRaises(ValueError): validate('appearance',{'fontSize':100})
        self.assertEqual(validate('appearance',{'theme':'dark'})['theme'],'dark')
    def test_network_rejects_private_dns_and_redirect_credentials_before_connection(self):
        with patch.object(network.socket, 'getaddrinfo',
                          return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]), \
                patch.object(network, '_PinnedHTTPS') as connect:
            with self.assertRaises(network.NetworkError) as blocked:
                network.fetch('https://public.example.test/')
            self.assertEqual('ssrf_blocked', blocked.exception.error_code)
            connect.assert_not_called()
        for url in ('http://example.com','https://user:secret@example.com','https://example.com:8443'):
            with self.assertRaises(network.NetworkError) as invalid:
                network.fetch(url)
            self.assertEqual('invalid_url', invalid.exception.error_code)

if __name__=='__main__': unittest.main()
