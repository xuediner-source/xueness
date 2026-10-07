"""Creator tools validate data, honour policy and never install/execute it."""
import tempfile
import unittest
from pathlib import Path
from xueness import plugin_runtime
from xueness.tool_contract import bind_execution
from xueness.tool_registry import dispatch


class ReadGate:
    def __init__(self): self.calls = []
    def check(self, kind, subject): self.calls.append((kind, subject))


class CreatorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / 'state'
        self.gate = ReadGate()

    def call(self, tool, args):
        with bind_execution(state_dir=self.state):
            return dispatch(self.root, self.gate, tool, args, {})

    def test_valid_skill_uses_discovery_contract_without_execution(self):
        result = self.call('skill_validate', {'content': '---\nname: test-skill\ndescription: A precise reusable task.\n---\nNever execute data.'})
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['metadata']['name'], 'test-skill')
        self.assertFalse(result['executed'])
        self.assertEqual(self.gate.calls, [('read', '')])

    def test_invalid_skill_frontmatter_and_empty_body(self):
        for content in ('plain text', '---\nname: BAD\ndescription: Test\n---\nbody',
                        '---\nname: test\ndescription: "has --- inside"\n---\n'):
            self.assertFalse(self.call('skill_validate', {'content': content})['ok'])

    def test_executable_manifest_is_rejected_without_installing(self):
        result = self.call('plugin_manifest_validate', {'manifest': {'id': 'bad', 'entrypoint': 'os.system'}})
        self.assertFalse(result['ok'])
        self.assertFalse(result['executed'])
        self.assertFalse(result['installed'])
        self.assertFalse((self.state / 'resources').exists())

    def test_disabling_owners_blocks_direct_state_bound_calls(self):
        for owner, tool, args in (
            ('extensions', 'plugin_manifest_validate', {'manifest': {}}),
            ('skills', 'skill_validate', {'content': 'example'}),
        ):
            plugin_runtime.set_enabled(self.state, owner, False)
            result = self.call(tool, args)
            self.assertEqual(result, {'ok': False, 'error': 'plugin disabled'})
        self.assertEqual(self.gate.calls, [])
