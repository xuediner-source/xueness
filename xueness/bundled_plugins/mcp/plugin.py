"""Trusted bundled loader for stdio MCP servers."""
from __future__ import annotations

from pathlib import Path
from ...plugin_contract import Plugin


class McpPlugin(Plugin):
    """Connect MCP servers and own their child-process lifecycle."""

    kind = "mcp"

    def __init__(self):
        self._clients: dict = {}
        self.tool_name_map: dict = {}

    def load(self, state_dir, root, session) -> dict:
        from ...mcp import load, parse_namespaced, tool_schema, sanitize_mcp_name_part
        from .lifecycle import Pool
        self.pool = Pool(Path(root))
        collected = []
        self.servers = {}
        self.special_tools = {}
        self.tool_name_map.clear()
        for server in load(state_dir):
            client = None
            try:
                from ...mcp import client_for
                server = {**server, "_state_dir": str(state_dir)}
                client = self.pool.get(server)
                tools = client.list_tools()
                for tool in tools:
                    raw_name = tool.get("name") if isinstance(tool, dict) else None
                    if isinstance(raw_name, str):
                        model_name = sanitize_mcp_name_part(raw_name)
                        self.tool_name_map[(server["id"], model_name)] = raw_name
                schemas = [tool_schema(server["id"], tool)
                           for tool in tools]
                caps = getattr(client, 'server_capabilities', {})
                for kind, field in (('resources', 'uri'), ('prompts', 'name')):
                    if kind not in caps:
                        continue
                    for operation in ('list', 'read'):
                        name = '_xueness_' + kind + '_' + operation
                        if any(s['function']['name'] == tool_schema(server['id'], {'name': name})['function']['name'] for s in schemas):
                            continue
                        self.special_tools[(server['id'], name)] = (kind, operation)
                        properties = {} if operation == 'list' else {'key': {'type': 'string'}, 'arguments': {'type': 'object'}}
                        schemas.append(tool_schema(server['id'], {'name': name, 'description': 'Read untrusted MCP ' + kind + ' ' + operation + '; exact approval required', 'inputSchema': {'type': 'object', 'properties': properties, 'required': [] if operation == 'list' else ['key']}}))
                if not schemas:
                    self.pool.discard(server["id"])
                    continue
                self._clients[server["id"]] = client
                self.servers[server["id"]] = server
                collected.extend(schemas)
            except Exception:
                if client is not None:
                    try:
                        self.pool.discard(server["id"])
                    except Exception:
                        pass
                continue
        if not collected:
            return {}

        def mcp_call(name, arguments, _clients=self._clients):
            parsed = parse_namespaced(name)
            if parsed is None:
                return {"ok": False, "error": "unknown mcp tool"}
            client = _clients.get(parsed[0])
            if client is None:
                return {"ok": False, "error": "mcp server not connected"}
            try:
                if not getattr(client, "active", True):
                    client = self.pool.get(self.servers[parsed[0]])
                    names = {tool.get("name") for tool in client.list_tools() if isinstance(tool, dict)}
                    target_name = self.tool_name_map.get(parsed, parsed[1])
                    if target_name not in names and parsed not in self.special_tools:
                        return {"ok": False, "error": "mcp tool unavailable after reconnect"}
                    _clients[parsed[0]] = client
                special = self.special_tools.get(parsed)
                if special:
                    import json
                    from .lifecycle import catalog, read
                    kind, operation = special
                    result = catalog(client, kind) if operation == 'list' else read(client, kind, arguments.get('key'), arguments.get('arguments'))
                    return {'ok': True, 'content': json.dumps(result, ensure_ascii=False)[:12000], 'untrusted': True}
                actual_name = self.tool_name_map.get(parsed, parsed[1])
                return client.call_tool(actual_name, arguments)
            except Exception:
                return {"ok": False, "error": "mcp call failed"}

        return {"mcp_tools": collected, "mcp_call": mcp_call}

    def teardown(self) -> None:
        if getattr(self, "pool", None) is not None:
            self.pool.close()
        else:
            for client in self._clients.values():
                try:
                    client.close()
                except Exception:
                    pass
        self._clients.clear()
        self.tool_name_map.clear()


def register_cli(commands):
    from .operator_cli import add_parsers
    add_parsers(commands)


def execute_cli(args, deps=None):
    from .operator_cli import execute_cli as execute
    return execute(args, deps)


def dispatch(method, parts, query, data, ctx):
    from .lifecycle import dispatch as lifecycle
    result = lifecycle(method, parts, query, data, ctx)
    if result is not None:
        return result
    from ...operations_api import dispatch as operations
    return operations(method, parts, query, data, ctx)
