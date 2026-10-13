"""ACP adapter checks using real, disposable local protocol children."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

from xueness import process_runtime
from xueness.bundled_plugins.mcp.acp_adapter import (
    AcpAdapterError, AcpCancelled, MAX_FRAME_BYTES, MAX_OUTPUT_BYTES, run_agent,
)


FIXTURE = r'''
import json, os, subprocess, sys, time
from pathlib import Path
mode, pid_path, record_path = sys.argv[1:]

def send(item):
    print(json.dumps({'jsonrpc': '2.0', **item}), flush=True)

def read():
    line = sys.stdin.readline()
    if not line: raise SystemExit(0)
    return json.loads(line)

def log(item):
    with open(record_path, 'a', encoding='utf-8') as stream:
        stream.write(json.dumps(item) + '\n')

def reply(request, result):
    send({'id': request['id'], 'result': result})

for expected in ('initialize', 'session/new', 'session/prompt'):
    request = read()
    assert request['method'] == expected
    log(request)
    if expected == 'initialize':
        if mode == 'wrong-id':
            send({'id': str(request['id']), 'result': {'protocolVersion': 1}})
            time.sleep(10)
        elif mode == 'both-result-error':
            send({'id': request['id'], 'result': {}, 'error': {'code': -1, 'message': 'PRIVATE_REMOTE_DATA'}})
            time.sleep(10)
        elif mode == 'oversized-frame':
            print('x' * 1000001, flush=True)
            time.sleep(10)
        elif mode == 'nonfinite-number':
            print('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"untrusted":1e999}}', flush=True)
            time.sleep(10)
        else:
            reply(request, {'protocolVersion': 1, 'agentCapabilities': {}})
    elif expected == 'session/new':
        reply(request, {'sessionId': 'session-fixture'})
    elif mode == 'cancel':
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        Path(pid_path).write_text(json.dumps({'parent': os.getpid(), 'child': child.pid}))
        time.sleep(60)
    elif mode == 'large-output':
        send({'method': 'session/update', 'params': {'sessionId': 'session-fixture', 'update': {
            'sessionUpdate': 'agent_message_chunk',
            'content': {'type': 'text', 'text': 'x' * 256001}}}})
        reply(request, {'stopReason': 'end_turn'})
        time.sleep(10)
    else:
        send({'id': 'permission', 'method': 'session/request_permission', 'params': {
            'sessionId': 'session-fixture', 'toolCall': {'toolCallId': 'call-1'},
            'options': [{'optionId': 'permit', 'kind': 'allow_once', 'name': 'Allow'}]}})
        log(read())
        for method in ('fs/write_text_file', 'terminal/create'):
            send({'id': method, 'method': method, 'params': {'sessionId': 'session-fixture'}})
            log(read())
        for text in ('真实 ', 'ACP 回复'):
            send({'method': 'session/update', 'params': {'sessionId': 'session-fixture', 'update': {
                'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': text}}}})
        # Thoughts and tools do not become assistant text.
        send({'method': 'session/update', 'params': {'sessionId': 'session-fixture', 'update': {
            'sessionUpdate': 'agent_thought_chunk', 'content': {'type': 'text', 'text': 'PRIVATE_THOUGHT'}}}})
        reply(request, {'stopReason': 'end_turn'})
        time.sleep(10)
'''


class ExternalAcpAdapterTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.script = self.root / 'agent.py'
        self.script.write_text(FIXTURE, encoding='utf-8')
        self.pids = self.root / 'pids.json'
        self.record = self.root / 'requests.jsonl'

    def argv(self, mode):
        return [sys.executable, '-u', str(self.script), mode,
                str(self.pids), str(self.record)]

    def test_real_child_returns_text_and_denies_permissions_and_host_services(self):
        text = run_agent(self.argv('success'), self.root, 'inspect this fixture', timeout=5)
        self.assertEqual(text, '真实 ACP 回复')
        rows = [json.loads(line) for line in self.record.read_text(encoding='utf-8').splitlines()]
        self.assertEqual(rows[0]['params']['protocolVersion'], 1)
        self.assertEqual(rows[0]['params']['clientCapabilities'], {})
        self.assertEqual(rows[1]['params']['mcpServers'], [])
        self.assertEqual(rows[2]['params']['prompt'], [{'type': 'text', 'text': 'inspect this fixture'}])
        self.assertEqual(rows[3], {'jsonrpc': '2.0', 'id': 'permission',
                                  'result': {'outcome': {'outcome': 'cancelled'}}})
        self.assertEqual([row['error']['code'] for row in rows[4:]], [-32601, -32601])

    def test_cancel_reclaims_child_and_spawned_descendant(self):
        started = time.monotonic()
        with self.assertRaises(AcpCancelled):
            run_agent(self.argv('cancel'), self.root, 'wait', timeout=5,
                      should_stop=lambda: self.pids.exists())
        pids = json.loads(self.pids.read_text())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and any(process_runtime._pid_alive(pid) for pid in pids.values()):
            time.sleep(0.05)
        self.assertFalse(process_runtime._pid_alive(pids['parent']))
        # POSIX orphan zombies can remain until init reaps them, but cannot
        # execute. Windows Job Object cleanup proves both process exits.
        if os.name == 'nt':
            self.assertFalse(process_runtime._pid_alive(pids['child']))
        self.assertLess(time.monotonic() - started, 4)

    def test_protocol_and_resource_failures_are_safe(self):
        for mode in ('wrong-id', 'both-result-error', 'oversized-frame', 'large-output', 'nonfinite-number'):
            with self.subTest(mode=mode), self.assertRaises(AcpAdapterError) as error:
                run_agent(self.argv(mode), self.root, 'fixture', timeout=5)
            self.assertNotIn('PRIVATE_REMOTE_DATA', str(error.exception))
            self.assertLess(len(str(error.exception)), 100)


if __name__ == '__main__':
    unittest.main()
