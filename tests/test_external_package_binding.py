"""Installed source bytes, trust and protocol children stay bound together."""
import base64
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
except ImportError:
    Ed25519PrivateKey = None

from tests.test_external_acp_adapter import FIXTURE as ACP_SOURCE
from xueness.bundled_plugins.extensions import package_store as packages
from xueness.bundled_plugins.extensions import package_trust as trust
from xueness.bundled_plugins.mcp import mcp, package_binding
from xueness.bundled_plugins.mcp.lifecycle import Pool
from xueness.bundled_plugins.mcp.plugin import McpPlugin


MCP_SOURCE = r'''
import json, sys
from pathlib import Path
VERSION = VERSION_VALUE
Path('mcp-started.txt').write_text(VERSION, encoding='utf-8')
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if 'id' not in request:
        continue
    if method == 'initialize':
        result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'installed-fixture', 'version': VERSION}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'echo', 'description': 'Package fixture echo',
                            'inputSchema': {'type': 'object',
                                            'properties': {'text': {'type': 'string'}},
                                            'required': ['text']}}]}
    elif method == 'tools/call':
        params = request['params']
        assert params['name'] == 'echo'
        text = VERSION + ':' + params['arguments']['text']
        with open('mcp-calls.txt', 'a', encoding='utf-8') as log:
            log.write(text + '\n')
        result = {'content': [{'type': 'text', 'text': text}], 'isError': False}
    else:
        raise RuntimeError('unexpected method')
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
'''


def source_archive(source, *, package_id='fixture-tool', version='1.0.0', transport='mcp-stdio'):
    manifest = {'apiVersion': 1, 'id': package_id, 'version': version,
                'transport': transport, 'runtime': 'python',
                'entrypoint': 'src/server.py', 'capabilities': ['command']}
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(packages.MANIFEST_NAME, json.dumps(manifest))
        archive.writestr('src/server.py', source)
    data = output.getvalue()
    return data, hashlib.sha256(data).hexdigest()


class ExternalPackageBindingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = self.root / 'state'

    def pool(self):
        pool = Pool(self.root)
        self.addCleanup(pool.close)
        return pool

    def test_exact_source_install_discovers_calls_and_reclaims_on_upgrade_disable(self):
        first, first_hash = source_archive(MCP_SOURCE.replace('VERSION_VALUE', repr('1.0.0')))
        installed = packages.install(self.state, first, expected_sha256=first_hash)
        self.assertFalse(installed['enabled'])
        self.assertEqual(mcp.load(self.state), [])
        self.assertFalse((self.root / 'mcp-started.txt').exists())
        packages.set_enabled(self.state, 'fixture-tool', True,
                             expected_sha256=first_hash, grants=['command'])
        server = mcp.load(self.state)[0]
        self.assertEqual(server['package'], {'id': 'fixture-tool', 'archiveSha256': first_hash})
        client = self.pool().get(server)
        proc = client.proc
        self.assertEqual([tool['name'] for tool in client.list_tools()], ['echo'])
        self.assertEqual(client.call_tool('echo', {'text': 'reviewed'})['content'], '1.0.0:reviewed')

        # An upgrade revokes activation and kills the prior child before any
        # later approved call could be redirected to the replacement source.
        second, second_hash = source_archive(MCP_SOURCE.replace('VERSION_VALUE', repr('2.0.0')),
                                              version='2.0.0')
        upgraded = packages.upgrade(self.state, second, expected_sha256=second_hash,
                                    package_id='fixture-tool')
        self.assertFalse(upgraded['enabled'])
        self.assertIsNotNone(proc.poll())
        self.assertFalse(client.call_tool('echo', {'text': 'stale'})['ok'])
        with self.assertRaises(ValueError):
            self.pool().get(server)
        packages.set_enabled(self.state, 'fixture-tool', True,
                             expected_sha256=second_hash, grants=['command'])
        current = mcp.load(self.state)[0]
        replacement = self.pool().get(current)
        replacement_proc = replacement.proc
        self.assertEqual(replacement.call_tool('echo', {'text': 'replacement'})['content'],
                         '2.0.0:replacement')
        packages.set_enabled(self.state, 'fixture-tool', False, expected_sha256=second_hash)
        self.assertIsNotNone(replacement_proc.poll())
        self.assertFalse(replacement.call_tool('echo', {'text': 'disabled'})['ok'])
        self.assertEqual(mcp.load(self.state), [])
        self.assertEqual((self.root / 'mcp-calls.txt').read_text(encoding='utf-8').splitlines(),
                         ['1.0.0:reviewed', '2.0.0:replacement'])

    @unittest.skipIf(Ed25519PrivateKey is None, 'optional Ed25519 verifier is unavailable')
    def test_ed25519_operator_pin_rechecks_digest_signature_receipt_and_revocation(self):
        data, digest = source_archive(MCP_SOURCE.replace('VERSION_VALUE', repr('1.0.0')))
        private = Ed25519PrivateKey.generate()
        public = private.public_key().public_bytes(serialization.Encoding.Raw,
                                                   serialization.PublicFormat.Raw)
        encoded = base64.b64encode(public).decode('ascii')
        fingerprint = hashlib.sha256(public).hexdigest()
        signature = {'keyId': 'reviewed-publisher', 'signature': base64.b64encode(
            private.sign(trust.DOMAIN + digest.encode('ascii'))).decode('ascii')}
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            trust.add_key(self.state, signature['keyId'], encoded, '0' * 64)
        self.assertEqual(trust.list_keys(self.state), [])
        pinned = trust.add_key(self.state, signature['keyId'], encoded, fingerprint)
        self.assertEqual(pinned['fingerprint'], fingerprint)
        provenance = trust.verify(self.state, digest, signature)
        installed = packages.install(self.state, data, expected_sha256=digest,
                                     provenance=provenance)
        trust.verify_receipt(self.state, installed['receipt'], digest)
        with self.assertRaisesRegex(ValueError, 'verification failed'):
            trust.verify(self.state, '0' * 64, signature)
        with self.assertRaisesRegex(ValueError, 'verification failed'):
            trust.verify(self.state, digest, {**signature, 'signature': base64.b64encode(bytes(64)).decode('ascii')})
        with self.assertRaisesRegex(ValueError, 'verification failed'):
            trust.verify_receipt(self.state, installed['receipt'], '0' * 64)
        altered = {**installed['receipt'], 'provenance': {**provenance, 'fingerprint': '0' * 64}}
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            trust.verify_receipt(self.state, altered, digest)
        packages.set_enabled(self.state, 'fixture-tool', True,
                             expected_sha256=digest, grants=['command'])
        client = self.pool().get(mcp.load(self.state)[0])
        proc = client.proc
        trust.revoke_key(self.state, signature['keyId'])
        self.assertIsNotNone(proc.poll())
        self.assertFalse(client.call_tool('echo', {'text': 'revoked'})['ok'])
        with self.assertRaisesRegex(ValueError, 'not trusted'):
            trust.verify(self.state, digest, signature)
        with self.assertRaisesRegex(ValueError, 'not trusted'):
            trust.verify_receipt(self.state, installed['receipt'], digest)
        self.assertEqual(package_binding.managed_servers(self.state), [])

    def test_acp_source_package_runs_through_mcp_facade_and_denies_client_permissions(self):
        # The fixture remains self-contained under Python isolated mode; its
        # protocol log goes to the workspace, never the immutable source tree.
        source = ACP_SOURCE.replace('mode, pid_path, record_path = sys.argv[1:]',
                                    "mode, pid_path, record_path = 'success', 'acp-pids.json', 'acp-requests.jsonl'")
        data, digest = source_archive(source, package_id='fixture-agent', transport='acp-stdio')
        packages.install(self.state, data, expected_sha256=digest)
        self.assertFalse((self.root / 'acp-requests.jsonl').exists())
        packages.set_enabled(self.state, 'fixture-agent', True,
                             expected_sha256=digest, grants=['command'])
        plugin = McpPlugin()
        self.addCleanup(plugin.teardown)
        loaded = plugin.load(self.state, self.root, {})
        self.assertEqual(len(loaded.get('mcp_tools', [])), 1)
        tool_name = loaded['mcp_tools'][0]['function']['name']
        self.assertTrue(tool_name.endswith('__agent_prompt'))
        sid = package_binding.server_id('fixture-agent')
        client = plugin._clients[sid]
        proc = client.proc
        self.assertEqual(client.server_info['name'], 'Xueness ACP adapter')
        result = loaded['mcp_call'](tool_name, {'prompt': 'inspect the installed agent'})
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['content'], '真实 ACP 回复')
        rows = [json.loads(line) for line in (self.root / 'acp-requests.jsonl').read_text(
            encoding='utf-8').splitlines()]
        self.assertEqual([row.get('method') for row in rows[:3]],
                         ['initialize', 'session/new', 'session/prompt'])
        self.assertEqual(rows[0]['params']['clientCapabilities'], {})
        self.assertEqual(rows[1]['params']['mcpServers'], [])
        self.assertEqual(rows[2]['params']['prompt'],
                         [{'type': 'text', 'text': 'inspect the installed agent'}])
        self.assertEqual(rows[3], {'jsonrpc': '2.0', 'id': 'permission',
                                  'result': {'outcome': {'outcome': 'cancelled'}}})
        self.assertEqual([row['error']['code'] for row in rows[4:]], [-32601, -32601])
        self.assertTrue(packages.review(self.state, 'fixture-agent')['valid'])
        packages.set_enabled(self.state, 'fixture-agent', False, expected_sha256=digest)
        self.assertIsNotNone(proc.poll())
        self.assertFalse(loaded['mcp_call'](tool_name, {'prompt': 'after disable'})['ok'])
        self.assertEqual(len((self.root / 'acp-requests.jsonl').read_text(
            encoding='utf-8').splitlines()), len(rows))


if __name__ == '__main__':
    unittest.main()
