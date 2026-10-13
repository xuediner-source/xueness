"""Trusted MCP facade for one explicitly activated ACP source package."""
from __future__ import annotations

import json
from pathlib import Path
import signal
import sys
import threading

from .package_binding import require_package, source_command, server_id, launch_environment
from .acp_adapter import run_agent

TOOL = 'agent_prompt'


def main(state, package_id, sha256):
    stopped = threading.Event()
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    server = {'id': server_id(package_id), 'package': {'id': package_id, 'archiveSha256': sha256},
              '_state_dir': str(Path(state).absolute())}

    def emit(value):
        sys.stdout.buffer.write((json.dumps(value, ensure_ascii=False, allow_nan=False,
                                           separators=(',', ':')) + '\n').encode('utf-8'))
        sys.stdout.buffer.flush()

    while not stopped.is_set():
        raw = sys.stdin.buffer.readline(1_000_002)
        if not raw:
            break
        if len(raw) > 1_000_001 or not raw.endswith(b'\n'):
            return 2
        request = None
        try:
            request = json.loads(raw)
            if not isinstance(request, dict) or request.get('jsonrpc') != '2.0':
                return 2
            if 'id' not in request:
                continue
            rid = request['id']
            package = require_package(server)
            if package['manifest']['transport'] != 'acp-stdio':
                raise ValueError('package is not an ACP agent')
            method, params = request.get('method'), request.get('params') or {}
            if method == 'initialize':
                result = {'protocolVersion': params.get('protocolVersion'), 'capabilities': {'tools': {}},
                          'serverInfo': {'name': 'Xueness ACP adapter', 'version': '1.0.0'}}
            elif method == 'tools/list':
                result = {'tools': [{'name': TOOL, 'description': 'Run the approved external ACP agent once. Client permissions are denied.',
                                     'inputSchema': {'type': 'object', 'properties': {'prompt': {'type': 'string', 'maxLength': 32000}},
                                                     'required': ['prompt'], 'additionalProperties': False}}]}
            elif method == 'tools/call':
                arguments = params.get('arguments') or {}
                if (params.get('name') != TOOL or not isinstance(arguments, dict)
                        or set(arguments) != {'prompt'} or not isinstance(arguments['prompt'], str)
                        or not 0 < len(arguments['prompt']) <= 32000):
                    raise ValueError('invalid external agent request')
                text = run_agent(source_command(package), Path.cwd(), arguments['prompt'],
                                 timeout=60, should_stop=stopped.is_set,
                                 env={key: value for key, value in launch_environment(server).items()
                                      if key == 'ELECTRON_RUN_AS_NODE'})
                result = {'content': [{'type': 'text', 'text': text}]}
            else:
                emit({'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32601, 'message': 'unsupported method'}})
                continue
            emit({'jsonrpc': '2.0', 'id': rid, 'result': result})
        except Exception:
            emit({'jsonrpc': '2.0', 'id': request.get('id') if isinstance(request, dict) else None,
                  'error': {'code': -32000, 'message': 'external ACP request refused or failed'}})
    return 0
