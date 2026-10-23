"""Actual Python HTTP oracle for migrated feature handlers; isolated state only."""
import http.client
import json
from pathlib import Path
import sys
import threading

from xueness import web, plugin_runtime


def main():
    data = json.load(sys.stdin)
    state, workspace = Path(data['stateDir']), Path(data['workspace'])
    ctx = web.build_context(state, workspace / 'web-runs', workspace, data.get('allowReal', False), csrf='fixture-csrf')
    for plugin in data.get('disabled', []):
        plugin_runtime.set_enabled(state, plugin, False)
    server = web.create_server(0, ctx)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    result = []
    try:
        for row in data['requests']:
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
            body = json.dumps(row.get('data', {}), ensure_ascii=False).encode('utf-8')
            headers = {'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-csrf'}
            connection.request(row['method'], row['path'], body if row['method'] != 'GET' else None, headers)
            response = connection.getresponse()
            raw = response.read()
            result.append([response.status, json.loads(raw)])
            connection.close()
    finally:
        server.shutdown()
        server.server_close()
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
