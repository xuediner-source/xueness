"""Explicit MCP connection checks, shared by CLI and Web."""
from pathlib import Path
from ...mcp import load, client_for


def check_mcp(state, server_id, root):
    server = next((s for s in load(state) if s['id'] == server_id), None)
    if server is None:
        raise ValueError('enabled MCP server not found')
    client = client_for({**server, "_state_dir": str(state)}, cwd=Path(root))
    try:
        client.start()
        if client.error:
            return {'ok': False, 'id': server_id, 'error': 'connection failed'}
        tools = client.list_tools()
        return {'ok': not bool(client.error), 'id': server_id,
                'protocol': client.negotiated_protocol_version,
                'tools': [t.get('name', '') for t in tools],
                'error': 'tool discovery failed' if client.error else None}
    finally:
        client.close()
