"""MCP Streamable HTTP request/response transport (JSON or SSE responses).

No OAuth, legacy SSE discovery or automatic reconnection/replay. Authentication
headers can reference explicitly named environment variables; redirects fail
closed so credentials never follow an arbitrary destination.
"""
import json
import os
import urllib.request
from urllib.parse import urlsplit
from ...mcp import McpClient, CLIENT_INFO, _McpTransportError
from ...provider import _NoRedirect, _is_loopback_literal


class HttpMcpClient(McpClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.session_id = None

    @property
    def active(self):
        return self._started

    def _headers(self):
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        for key, envname in self.server.get('headersEnv', {}).items():
            if not isinstance(key, str) or key.lower() not in ('authorization', 'x-api-key') or not isinstance(envname, str):
                raise _McpTransportError('invalid authentication header configuration')
            value = os.environ.get(envname, '')
            if not value or '\r' in value or '\n' in value:
                raise _McpTransportError('authentication environment variable missing or invalid')
            headers[key] = value
        if self.server.get("oauth"):
            from .oauth import bearer
            headers["Authorization"] = "Bearer " + bearer(self.server["_state_dir"], self.server)
        if self.session_id:
            headers['Mcp-Session-Id'] = self.session_id
        if self.negotiated_protocol_version:
            headers['MCP-Protocol-Version'] = self.negotiated_protocol_version
        return headers

    def _checked_url(self):
        url = self.server.get('url', '')
        parts = urlsplit(url)
        if parts.username or parts.password or parts.query or parts.fragment or not parts.hostname:
            raise ValueError()
        if parts.scheme != 'https' and not (parts.scheme == 'http' and self.server.get('allowLoopbackHttp') is True and _is_loopback_literal(parts.hostname)):
            raise ValueError()
        return url

    def _transport_timeout(self):
        """Ordinary calls keep ``self.timeout``. An opted-in server may pause inside one read."""
        from .elicitation import USER_WAIT_SECONDS, elicitation_enabled
        if not elicitation_enabled(self.server):
            return self.timeout
        return max(float(self.timeout), float(USER_WAIT_SECONDS) + float(self.timeout))

    def _post_result(self, response):
        """POST a JSON-RPC response without taking ``_request``'s lock or reading a result.

        The body is drained and discarded. It is not logged: it can echo the answer.
        """
        request = urllib.request.Request(self._checked_url(), data=json.dumps(response).encode(), headers=self._headers())
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=self.timeout) as reply:
            status = getattr(reply, 'status', None)
            if status not in (None, 200, 202, 204):
                raise ValueError()
            reply.read(65536)

    def _read_sse(self, response, request_id):
        from .elicitation import is_server_request
        total, data = 0, []
        while True:
            line = response.readline(65537)
            total += len(line)
            if not line or total > 1_000_000 or len(line) > 65536:
                raise ValueError()
            text = line.decode('utf-8').rstrip('\r\n')
            if text.startswith('data:'):
                data.append(text[5:].lstrip())
            elif not text and data:
                message = json.loads('\n'.join(data))
                data = []
                if not isinstance(message, dict):
                    continue
                if is_server_request(message):
                    self._answer_server_request(message)
                    continue
                if message.get('id') == request_id:
                    return self._result(message, request_id)

    def _read_response(self, response, request_id):
        headers = getattr(response, 'headers', None)
        content_type = headers.get('Content-Type', '') if headers is not None and hasattr(headers, 'get') else ''
        if 'text/event-stream' in content_type:
            return self._read_sse(response, request_id)
        data = response.read(1_000_001)
        if len(data) > 1_000_000:
            raise ValueError()
        return self._result(json.loads(data), request_id)

    def _exchange(self, payload):
        try:
            request = urllib.request.Request(self._checked_url(), data=json.dumps(payload).encode(), headers=self._headers())
            with urllib.request.build_opener(_NoRedirect).open(request, timeout=self._transport_timeout()) as response:
                session_id = response.headers.get('Mcp-Session-Id')
                if session_id:
                    if len(session_id) > 256 or any(ord(c) < 33 or ord(c) > 126 for c in session_id):
                        raise ValueError()
                    self.session_id = session_id
                if 'id' not in payload:
                    return {}
                return self._read_response(response, payload['id'])
        except _McpTransportError:
            raise
        except Exception:
            raise _McpTransportError('HTTP MCP request failed (remote details suppressed)') from None

    @staticmethod
    def _result(result, rid):
        if not isinstance(result, dict) or result.get('jsonrpc') != '2.0' or result.get('id') != rid:
            raise _McpTransportError('invalid HTTP MCP response')
        if 'error' in result or not isinstance(result.get('result'), dict):
            raise _McpTransportError('HTTP MCP server rejected request')
        return result['result']

    def _request(self, method, params, request_id):
        with self._lock:
            return self._exchange({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params})

    def _notify(self, method):
        self._exchange({'jsonrpc': '2.0', 'method': method})

    def _initialize_version(self):
        from .elicitation import ELICITATION_PROTOCOL, elicitation_enabled
        from .mcp import SUPPORTED_PROTOCOL_VERSIONS
        pinned = self.server.get('protocolVersion')
        if isinstance(pinned, str) and pinned in SUPPORTED_PROTOCOL_VERSIONS:
            return pinned
        if elicitation_enabled(self.server):
            return ELICITATION_PROTOCOL
        return '2025-03-26'

    def start(self):
        try:
            from .elicitation import initialize_capabilities
            result = self._request('initialize', {
                'protocolVersion': self._initialize_version(),
                'capabilities': initialize_capabilities(self.server),
                'clientInfo': CLIENT_INFO,
            }, 1)
            error = self._record_handshake(result)
            if error:
                raise _McpTransportError(error)
            self._notify('notifications/initialized')
            self._started, self.error = True, None
        except Exception:
            self.error = 'HTTP MCP initialization failed (details suppressed)'
            self._started = False

    def list_tools(self):
        collected, cursor, seen = [], None, set()
        try:
            for page in range(50):
                result = self._request('tools/list', {'cursor': cursor} if cursor else {}, 2 + page)
                items = result.get('tools')
                if not isinstance(items, list) or any(not isinstance(t, dict) for t in items):
                    raise _McpTransportError('invalid tool list')
                collected.extend(items)
                if len(collected) > 1000:
                    raise _McpTransportError('tool catalog too large')
                cursor = result.get('nextCursor')
                if cursor is None:
                    self.tools = collected
                    return collected
                if not isinstance(cursor, str) or not cursor or cursor in seen:
                    raise _McpTransportError('invalid pagination cursor')
                seen.add(cursor)
            raise _McpTransportError('tool catalog page limit exceeded')
        except Exception:
            self.error = 'HTTP MCP tool discovery failed'
            self.close()
            return []

    def close(self):
        # Session deletion is optional in the protocol. Closing local state
        # never replays a tool call or follows a replacement session endpoint.
        self._started = False
        self.session_id = None

    def _kill_proc(self):
        self.close()
