"""Feature boundary and persistent policy integration regressions."""
import importlib
import json
from pathlib import Path
import tempfile
import unittest
from xueness import plugin_runtime as runtime
from xueness.core import Store, Gate, run
from xueness.tool_contract import bind_execution
from xueness.tool_registry import dispatch

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.state=Path(self.temp.name)/'state';self.root=Path(self.temp.name)/'work';self.root.mkdir()
    def test_switch_survives_process_import_and_blocks_dependencies(self):
        runtime.set_enabled(self.state,'files',False)
        rows={p['id']:p for p in runtime.catalog(self.state)}
        for name in ('files','office','subagents','workflows','automation'):
            self.assertFalse(rows[name]['effective'],name)
        self.assertTrue(rows['office']['enabled'])
        self.assertTrue(rows['providers']['effective'])
        self.assertTrue(rows['terminal']['effective'])
        runtime.set_enabled(self.state,'files',True)
        self.assertTrue(runtime.is_enabled(self.state,'automation'))
    def test_enable_does_not_grant_missing_dependencies(self):
        runtime.set_enabled(self.state,'shell',False)
        with self.assertRaises(ValueError): runtime.set_enabled(self.state,'terminal',True)
        self.assertFalse(runtime.is_enabled(self.state,'shell'))
    def test_untrusted_configuration_fails_closed_but_catalog_remains_available(self):
        self.state.mkdir();(self.state/runtime.CONFIG_NAME).write_text(json.dumps({'apiVersion':1,'enabled':{'files':'false'}}))
        self.assertTrue(all(not row['effective'] for row in runtime.catalog(self.state)))
        self.assertTrue(all(row.get('configurationError') for row in runtime.catalog(self.state)))
    def test_state_cannot_name_or_import_code(self):
        with self.assertRaises(ValueError): runtime.entrypoint('__import__')
        self.state.mkdir();(self.state/runtime.CONFIG_NAME).write_text(json.dumps({'apiVersion':1,'enabled':{},'entrypoint':'evil.py'}))
        self.assertFalse(runtime.is_enabled(self.state,'sessions'))
    def test_tool_schema_and_routes_stop_with_plugin(self):
        runtime.set_enabled(self.state,'network',False)
        names={s['function']['name'] for s in runtime.tool_schemas(self.state)}
        self.assertNotIn('web_fetch',names);self.assertIn('read',names)
        self.assertEqual(runtime.route_owner(['api','sessions','a'*32,'git','commit']),'git')
        self.assertEqual(runtime.route_owner(['api','plugins','marketplace']),'extensions')
    def test_old_imports_are_identity_aliases(self):
        for old,new in [('provider','providers.provider'),('git_api','git.git_api'),('workflows','workflows.workflows'),('memory','memory.memory')]:
            self.assertIs(importlib.import_module('xueness.'+old),importlib.import_module('xueness.bundled_plugins.'+new))
    def test_history_search_is_limited_to_active_workspace(self):
        store=Store(self.state);session=store.new('local',self.root)
        session['messages'].append({'role':'assistant','content':'needle local answer'});store.save(session)
        outside=self.root.parent/'other';outside.mkdir();other=store.new('needle secret',outside)
        with bind_execution(store=store,state_dir=self.state):
            result=dispatch(self.root,Gate(self.root),'read_session_context',{'query':'needle'},session)
        self.assertTrue(result['ok']);self.assertEqual(len(result['matches']),1)
        self.assertEqual(result['matches'][0]['session_id'],session['id'])
    def test_individual_disallow_applies_to_contributed_tools(self):
        result=dispatch(self.root,Gate(self.root,disallow=['workflow_create']),'workflow_create',{'plan':{}},{})
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'denied')
        self.assertEqual(result['error_code'], 'permission_denied')
        self.assertFalse(result['awaiting_approval'])
        self.assertFalse(result['retryable'])

if __name__=='__main__': unittest.main()
