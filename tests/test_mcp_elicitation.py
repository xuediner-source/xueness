"""MCP elicitation: fail-closed capability, flat schema, and operator replies.

The accept path speaks to a local fake server started as ``sys.executable``
plus a script in a temporary directory. No test opens a socket to an MCP
server, calls a model, or reads a credential file.
"""
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from xueness.bundled_plugins.mcp import elicitation
from xueness.bundled_plugins.mcp.mcp import McpClient
from xueness.bundled_plugins.mcp.plugin import McpPlugin, dispatch as plugin_dispatch
from xueness.mcp_http import HttpMcpClient
from xueness.plugin_runtime import route_owner

SID = "0123456789abcdef0123456789abcdef"
ANSWER = "only-on-the-mcp-server"

FAKE_SERVER = r'''
import json
import sys

RESULT = sys.argv[1]
MODE = sys.argv[2] if len(sys.argv) > 2 else "ask"
KNOWN = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def record(entry):
    with open(RESULT, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry, ensure_ascii=False) + "\n")


def schema_for(mode):
    if mode == "nested":
        return {"type": "object", "properties": {"child": {"type": "object", "properties": {}}}, "required": ["child"]}
    if mode == "password":
        return {"type": "object", "properties": {"secret": {"type": "string", "format": "password"}}, "required": ["secret"]}
    if mode == "limit":
        return {"type": "object", "properties": {("f%d" % index): {"type": "string"} for index in range(40)}}
    return {
        "type": "object",
        "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 80}},
        "required": ["name"],
    }


for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        message = json.loads(raw)
    except ValueError:
        continue
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    if method == "initialize":
        version = params.get("protocolVersion")
        if version not in KNOWN:
            version = "2024-11-05"
        record({"kind": "initialize", "protocolVersion": params.get("protocolVersion"), "capabilities": params.get("capabilities")})
        send({"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake", "version": "1"},
        }})
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": [{
            "name": "ask",
            "description": "Ask",
            "inputSchema": {"type": "object", "properties": {}},
        }]}})
    elif method == "tools/call":
        send({"jsonrpc": "2.0", "id": 41, "method": "elicitation/create", "params": {
            "message": "What should this be called?",
            "requestedSchema": schema_for(MODE),
        }})
        reply_line = sys.stdin.readline()
        try:
            reply = json.loads(reply_line) if reply_line else None
        except ValueError:
            reply = None
        record({"kind": "elicitation", "reply": reply})
        send({"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": "done"}]}})
    elif method:
        send({"jsonrpc": "2.0", "id": request_id, "result": {}})
'''


def flat_schema(**properties):
    required = [name for name in properties if name != "optional"]
    return {"message": "Need a few details", "requestedSchema": {
        "type": "object", "properties": properties, "required": required,
    }}


class ElicitationTests(unittest.TestCase):
    def setUp(self):
        elicitation.reset_state()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.addCleanup(elicitation.reset_state)
        patched = patch("xueness.bundled_plugins.mcp.elicitation.USER_WAIT_SECONDS", 8.0)
        patched.start()
        self.addCleanup(patched.stop)

    def session(self, **extra):
        item = {"id": SID, "permission_mode": "build"}
        item.update(extra)
        return item

    def client(self, *, enabled=True, mode="ask", timeout=8, **extra):
        script = self.root / ("fake-%s.py" % mode)
        script.write_text(FAKE_SERVER, encoding="utf-8")
        result = self.root / ("result-%s.jsonl" % mode)
        server = {
            "id": "docs",
            "name": "Docs",
            "command": sys.executable,
            "args": [str(script), str(result), mode],
            "timeout": timeout,
        }
        if enabled:
            server["elicitation"] = True
        server.update(extra)
        client = McpClient(server, cwd=self.root)
        self.addCleanup(client.close)
        return client, result

    def bind(self, client, session=None):
        elicitation.bind_client(client, self.session() if session is None else session, self.root)

    def records(self, path):
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def start_call(self, client):
        box = {}

        def run():
            box["result"] = client.call_tool("ask", {})

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, box

    def wait_pending(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            public = elicitation.pending_public(SID)
            if public:
                return public
            time.sleep(0.02)
        self.fail("elicitation was not published")

    def assert_answer_hidden(self, *blobs):
        for blob in blobs:
            self.assertNotIn(ANSWER, blob)

    def test_capability_and_protocol_follow_the_switch(self):
        self.assertEqual(elicitation.initialize_capabilities({}), {})
        self.assertEqual(elicitation.initialize_capabilities({"elicitation": "true"}), {})
        self.assertEqual(elicitation.initialize_capabilities({"elicitation": True}), {"elicitation": {}})
        off, off_log = self.client(enabled=False)
        off.start()
        self.assertIsNone(off.error, off.error)
        self.assertEqual(self.records(off_log)[0]["protocolVersion"], "2024-11-05")
        self.assertEqual(self.records(off_log)[0]["capabilities"], {})
        pinned = McpClient({"id": "docs", "command": sys.executable, "elicitation": True, "protocolVersion": "2025-03-26"}, cwd=self.root)
        self.assertEqual(pinned._preferred_version(), "2025-03-26")
        pinned.server.pop("protocolVersion")
        self.assertEqual(pinned._preferred_version(), "2025-06-18")

    def test_schema_rejects_nested_illegal_and_oversized_shapes(self):
        nested = {"message": "x", "requestedSchema": {"type": "object", "properties": {"child": {"type": "object"}}, "required": ["child"]}}
        array = {"message": "x", "requestedSchema": {"type": "object", "properties": {"child": {"type": "array"}}, "required": ["child"]}}
        illegal = {"message": "x", "requestedSchema": {"type": "object", "properties": {"child": {"type": "enum", "enum": ["a"]}}, "required": ["child"]}}
        composed = {"message": "x", "requestedSchema": {"type": "object", "properties": {"child": {"type": "string", "oneOf": []}}, "required": ["child"]}}
        limited = {"message": "x", "requestedSchema": {"type": "object", "properties": {("f%d" % i): {"type": "string"} for i in range(17)}}}
        password = {"message": "x", "requestedSchema": {"type": "object", "properties": {"secret": {"type": "string", "format": "password"}}, "required": ["secret"]}}
        named = {"message": "x", "requestedSchema": {"type": "object", "properties": {"api_key": {"type": "string"}}, "required": ["api_key"]}}
        long_message = {"message": "x" * 2001, "requestedSchema": {"type": "object", "properties": {}}}
        self.assertEqual(elicitation.validate_requested(nested)[2], "invalid_schema")
        self.assertEqual(elicitation.validate_requested(array)[2], "invalid_schema")
        self.assertEqual(elicitation.validate_requested(illegal)[2], "invalid_schema")
        self.assertEqual(elicitation.validate_requested(composed)[2], "invalid_schema")
        self.assertEqual(elicitation.validate_requested(limited)[2], "over_limit")
        self.assertEqual(elicitation.validate_requested(password)[2], "password_format")
        self.assertEqual(elicitation.validate_requested(named)[2], "password_format")
        self.assertEqual(elicitation.validate_requested(long_message)[2], "over_limit")
        clean, _message, code = elicitation.validate_requested(flat_schema(name={"type": "string", "minLength": 1}))
        self.assertIsNone(code)
        content, code, field = elicitation.validate_content(clean, {"name": ANSWER, "extra": 1})
        self.assertEqual((content, code, field), (None, "unexpected", "extra"))

    def test_bad_schema_declines_on_the_stdio_wire_without_suspending(self):
        for mode, code in (("nested", "invalid_schema"), ("password", "password_format"), ("limit", "over_limit")):
            with self.subTest(mode=mode):
                elicitation.reset_state()
                client, log = self.client(mode=mode)
                self.bind(client)
                client.start()
                self.assertIsNone(client.error, client.error)
                result = client.call_tool("ask", {})
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["content"], "done")
                reply = self.records(log)[-1]["reply"]
                self.assertEqual(reply["result"]["action"], "decline")
                self.assertNotIn("content", reply["result"])
                self.assertEqual(elicitation.diagnostics()[-1]["code"], code)
                self.assertIsNone(elicitation.pending_public(SID))
                self.assertFalse((self.root / "mcp-elicitations" / (SID + ".json")).exists())

    def test_accept_round_trip_keeps_the_answer_on_the_server_reply_only(self):
        client, log = self.client()
        self.bind(client)
        client.start()
        self.assertEqual(client.negotiated_protocol_version, "2025-06-18")
        self.assertEqual(self.records(log)[0]["capabilities"], {"elicitation": {}})
        thread, box = self.start_call(client)
        public = self.wait_pending()
        self.assertEqual(public["serverName"], "Docs")
        self.assertNotIn("content", public)
        pending_file = self.root / "mcp-elicitations" / (SID + ".json")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not pending_file.exists():
            time.sleep(0.02)
        self.assertTrue(pending_file.exists())
        self.assert_answer_hidden(pending_file.read_text(encoding="utf-8"), json.dumps(elicitation.diagnostics()))
        self.assertEqual(elicitation.resolve(SID, public["id"], "accept", {"name": ANSWER}), "ok")
        thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(box["result"]["content"], "done")
        self.assertNotIn(ANSWER, box["result"]["content"])
        reply = self.records(log)[-1]["reply"]["result"]
        self.assertEqual(reply["action"], "accept")
        self.assertEqual(reply["content"], {"name": ANSWER})
        self.assertFalse(pending_file.exists())
        self.assert_answer_hidden(json.dumps(elicitation.diagnostics()), json.dumps(public))
        self.assertNotIn(ANSWER, json.dumps([row for row in self.records(log) if row.get("kind") != "elicitation"]))

    def test_user_wait_extends_the_stdio_deadline(self):
        client, log = self.client(timeout=1)
        self.bind(client)
        client.start()
        self.assertIsNone(client.error, client.error)
        with patch("xueness.bundled_plugins.mcp.elicitation.USER_WAIT_SECONDS", 5):
            thread, box = self.start_call(client)
            public = self.wait_pending()
            time.sleep(1.25)
            self.assertEqual(elicitation.resolve(SID, public["id"], "accept", {"name": ANSWER}), "ok")
            thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertTrue(box["result"]["ok"], box["result"])
        self.assertEqual(box["result"]["content"], "done")
        self.assertEqual(self.records(log)[-1]["reply"]["result"]["content"]["name"], ANSWER)

    def test_decline_cancel_and_timeout(self):
        client, log = self.client()
        self.bind(client)
        client.start()
        thread, box = self.start_call(client)
        public = self.wait_pending()
        self.assertEqual(elicitation.resolve(SID, public["id"], "decline"), "ok")
        thread.join(4)
        self.assertEqual(self.records(log)[-1]["reply"]["result"], {"action": "decline"})
        self.assertEqual(elicitation.diagnostics()[-1]["code"], "declined")
        self.assertEqual(box["result"]["content"], "done")

        elicitation.reset_state()
        client, log = self.client(mode="cancel")
        self.bind(client)
        client.start()
        thread, box = self.start_call(client)
        public = self.wait_pending()
        self.assertEqual(elicitation.resolve(SID, public["id"], "cancel"), "ok")
        thread.join(4)
        self.assertEqual(self.records(log)[-1]["reply"]["result"], {"action": "cancel"})
        self.assertEqual(elicitation.diagnostics()[-1]["code"], "cancelled")

        elicitation.reset_state()
        client, log = self.client(mode="timeout")
        self.bind(client)
        client.start()
        with patch("xueness.bundled_plugins.mcp.elicitation.USER_WAIT_SECONDS", 0.25):
            result = client.call_tool("ask", {})
        self.assertEqual(result["content"], "done")
        self.assertEqual(self.records(log)[-1]["reply"]["result"], {"action": "cancel"})
        self.assertEqual(elicitation.diagnostics()[-1]["code"], "timeout")
        self.assertFalse((self.root / "mcp-elicitations" / (SID + ".json")).exists())

    def test_unattended_contexts_decline_without_a_pending_file(self):
        cases = [
            ({"permission_mode": "plan"}, [], "MainThread", True, self.root, "unattended"),
            ({"mode": "plan"}, [], "MainThread", True, self.root, "unattended"),
            ({"read_only": True}, [], "MainThread", True, self.root, "unattended"),
            ({"parent": "root"}, [], "MainThread", True, self.root, "unattended"),
            ({"id": "sub-" + SID}, [], "MainThread", True, self.root, "unattended"),
            (self.session(), [], "xueness-turn-run-1", True, self.root, "unattended"),
            (self.session(), [], "xueness-cron", True, self.root, "unattended"),
            (self.session(), ["xueness.bundled_plugins.workflows.runner"], "MainThread", True, self.root, "unattended"),
            (self.session(), ["xueness.bundled_plugins.automation.off_peak"], "MainThread", True, self.root, "unattended"),
            (self.session(), ["xueness.bundled_plugins.remote.app_server"], "MainThread", True, self.root, "unattended"),
            (self.session(), ["xueness.bundled_plugins.subagents.runner"], "MainThread", True, self.root, "unattended"),
            (self.session(), ["xueness.bundled_plugins.sessions.cli_tui"], "MainThread", True, self.root, "unattended"),
            (self.session(), ["xueness.bundled_plugins.sessions.cli"], "MainThread", False, self.root, "unattended"),
            (self.session(), ["xueness.bundled_plugins.sessions.cli"], "MainThread", True, self.root, "cli"),
            (self.session(), [], "xueness-browser-output", True, self.root, "web"),
            (None, [], "MainThread", True, self.root, "unattended"),
        ]
        for session, modules, thread_name, tty, state_dir, expected in cases:
            with self.subTest(expected=expected, thread_name=thread_name, modules=modules):
                self.assertEqual(elicitation.classify_audience(
                    session, modules=modules, thread_name=thread_name, stdin_is_tty=tty, state_dir=state_dir,
                ), expected)
        client, log = self.client(mode="plan")
        self.bind(client, self.session(permission_mode="plan"))
        client.start()
        result = client.call_tool("ask", {})
        self.assertEqual(result["content"], "done")
        self.assertEqual(self.records(log)[-1]["reply"]["result"], {"action": "decline"})
        self.assertEqual(elicitation.diagnostics()[-1]["code"], "unattended")
        self.assertFalse((self.root / "mcp-elicitations" / (SID + ".json")).exists())

    def test_disabled_request_is_an_error_and_does_not_suspend(self):
        client, log = self.client(enabled=False, mode="off")
        self.bind(client)
        client.start()
        result = client.call_tool("ask", {})
        self.assertEqual(result["content"], "done")
        reply = self.records(log)[-1]["reply"]
        self.assertEqual(reply["error"]["code"], -32601)
        self.assertNotIn("result", reply)
        self.assertEqual(elicitation.diagnostics()[-1]["code"], "disabled")
        self.assertIsNone(elicitation.pending_public(SID))
        bare = type("Client", (), {"server": {"id": "docs", "elicitation": False}})()
        error = elicitation.response_for(bare, {"jsonrpc": "2.0", "id": 3, "method": "roots/list"})
        self.assertEqual(error["error"]["code"], -32601)
        self.assertIsNone(elicitation.response_for(bare, {"jsonrpc": "2.0", "method": "notifications/progress"}))

    def test_cli_prompts_do_not_echo_the_answer(self):
        schema, message, code = elicitation.validate_requested(flat_schema(
            name={"type": "string", "title": "Name"},
            agree={"type": "boolean", "title": "Agree"},
        ))
        self.assertIsNone(code)
        written = []
        answers = iter(["secret-value", "/decline"])

        def read_line(prompt):
            written.append(prompt)
            return next(answers)

        action, content = elicitation.prompt_cli(schema, message, "Docs", read_line, written.append)
        self.assertEqual((action, content), ("decline", None))
        self.assert_answer_hidden(*written)
        answers = iter(["Ada", "n"])
        action, content = elicitation.prompt_cli(schema, message, "Docs", lambda _prompt: next(answers), written.append)
        self.assertEqual(action, "accept")
        self.assertEqual(content["name"], "Ada")
        self.assertIs(content["agree"], False)
        client = type("Client", (), {"server": {"id": "docs", "name": "Docs", "elicitation": True}, "_elicitation_session": self.session(), "_elicitation_state_dir": self.root})()
        with patch("xueness.bundled_plugins.mcp.elicitation._stack_modules", return_value=["xueness.bundled_plugins.sessions.cli"]), \
                patch("xueness.bundled_plugins.mcp.elicitation._stdin_is_tty", return_value=True), \
                patch("xueness.bundled_plugins.mcp.elicitation.prompt_cli", return_value=("cancel", None)) as prompt:
            reply = elicitation.response_for(client, {"jsonrpc": "2.0", "id": 9, "method": "elicitation/create", "params": flat_schema(name={"type": "string"})})
        self.assertTrue(prompt.called)
        self.assertEqual(reply["result"]["action"], "cancel")
        with patch("xueness.bundled_plugins.mcp.elicitation._stack_modules", return_value=["xueness.bundled_plugins.sessions.cli_tui"]), \
                patch("xueness.bundled_plugins.mcp.elicitation.prompt_cli") as prompt:
            reply = elicitation.response_for(client, {"jsonrpc": "2.0", "id": 9, "method": "elicitation/create", "params": flat_schema(name={"type": "string"})})
        self.assertFalse(prompt.called)
        self.assertEqual(reply["result"]["action"], "decline")

    def test_http_routes_require_csrf_and_hide_the_answer(self):
        from xueness import web
        ctx = web.build_context(self.root / "state", self.root / "work", self.root / "project", csrf="test")
        server = web.create_server(0, ctx)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop_server():
            server.shutdown()
            server.server_close()

        self.addCleanup(stop_server)
        base = "http://127.0.0.1:%d" % server.server_address[1]
        session = ctx["store"].new("elicitation", ctx["web_runs"])
        holder = type("Client", (), {
            "server": {"id": "docs", "name": "Docs", "elicitation": True},
            "_elicitation_session": session,
            "_elicitation_state_dir": ctx["state_dir"],
        })()
        box = {}

        def wait():
            box["reply"] = elicitation.response_for(holder, {
                "jsonrpc": "2.0", "id": 9, "method": "elicitation/create",
                "params": flat_schema(name={"type": "string", "minLength": 1}),
            })

        waiter = threading.Thread(target=wait, daemon=True)
        waiter.start()
        deadline = time.monotonic() + 3
        pending = None
        while time.monotonic() < deadline:
            status, body = self.request(base, "/api/sessions/%s/elicitation" % session["id"])
            if status == 200 and body.get("pending"):
                pending = body["pending"]
                break
            time.sleep(0.02)
        self.assertIsNotNone(pending)
        self.assertNotIn(ANSWER, json.dumps(pending))
        refused, refused_body = self.request(base, "/api/sessions/%s/elicitation" % session["id"], {"id": 9, "action": "accept", "content": {"name": ANSWER}}, csrf=False)
        self.assertEqual(refused, 403)
        self.assertNotIn(ANSWER, json.dumps(refused_body))
        foreign, foreign_body = self.request(
            base, "/api/sessions/%s/elicitation" % session["id"],
            {"id": 9, "action": "accept", "content": {"name": ANSWER}},
            origin="http://evil.example",
        )
        self.assertEqual(foreign, 403)
        self.assertNotIn(ANSWER, json.dumps(foreign_body))
        invalid, invalid_body = self.request(base, "/api/sessions/%s/elicitation" % session["id"], {"id": 9, "action": "accept", "content": {"name": ""}})
        self.assertEqual(invalid, 400)
        self.assertNotIn(ANSWER, json.dumps(invalid_body))
        self.assertEqual(elicitation.pending_public(session["id"])["id"], 9)
        status, body = self.request(base, "/api/sessions/%s/elicitation" % session["id"], {"id": 9, "action": "accept", "content": {"name": ANSWER}})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True, "action": "accept"})
        self.assertNotIn(ANSWER, json.dumps(body))
        waiter.join(3)
        self.assertEqual(box["reply"]["result"]["content"], {"name": ANSWER})
        self.assert_answer_hidden(json.dumps(elicitation.diagnostics()))
        self.assertEqual(route_owner(["api", "sessions", session["id"], "elicitation"]), "mcp")

    def request(self, base, path, data=None, csrf=True, origin=None):
        headers = {"Content-Type": "application/json"}
        if csrf:
            headers["X-CSRF-Token"] = "test"
        if origin:
            headers["Origin"] = origin
        body = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(base + path, data=body, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode())

    def test_streamable_http_and_sse_answer_without_a_listening_socket(self):
        client = HttpMcpClient({"id": "docs", "name": "Docs", "elicitation": True, "url": "https://mcp.example/mcp"}, cwd=self.root)
        self.bind(client)
        posted = []
        client._post_result = posted.append
        tool_id = 4
        frames = [
            b'data: ' + json.dumps({"jsonrpc": "2.0", "id": 41, "method": "elicitation/create", "params": flat_schema(name={"type": "string", "minLength": 1})}).encode() + b"\n",
            b"\n",
            b'data: ' + json.dumps({"jsonrpc": "2.0", "id": tool_id, "result": {"content": [{"type": "text", "text": "done"}]}}).encode() + b"\n",
            b"\n",
        ]
        response = _FakeResponse(frames)
        box = {}
        thread = threading.Thread(target=lambda: box.update(result=client._read_response(response, tool_id)), daemon=True)
        thread.start()
        public = self.wait_pending()
        self.assertEqual(elicitation.resolve(SID, public["id"], "accept", {"name": ANSWER}), "ok")
        thread.join(3)
        self.assertEqual(box["result"]["content"][0]["text"], "done")
        self.assertEqual(posted[0]["result"], {"action": "accept", "content": {"name": ANSWER}})

        client.server["permission_mode"] = "ignored"
        self.bind(client, self.session(permission_mode="plan"))
        posted.clear()
        declined = client._read_response(_FakeResponse(frames), tool_id)
        self.assertEqual(posted[0]["result"]["action"], "decline")
        self.assertEqual(declined["content"][0]["text"], "done")
        self.assertIsNone(elicitation.pending_public(SID))

        from xueness.bundled_plugins.mcp.sse import SseMcpClient
        sse = SseMcpClient({"id": "docs", "name": "Docs", "elicitation": True, "transport": "sse", "url": "https://mcp.example/sse"}, cwd=self.root)
        sse.endpoint = "https://mcp.example/message"
        self.bind(sse)
        sse_posted = []
        sse._post_result = sse_posted.append
        sse.responses.put({"jsonrpc": "2.0", "id": 41, "method": "elicitation/create", "params": flat_schema(name={"type": "string", "minLength": 1})})
        sse.responses.put({"jsonrpc": "2.0", "id": tool_id, "result": {"content": [{"type": "text", "text": "done"}]}})
        box.clear()
        thread = threading.Thread(target=lambda: box.update(result=sse._wait_sse_result(tool_id)), daemon=True)
        thread.start()
        public = self.wait_pending()
        self.assertEqual(elicitation.resolve(SID, public["id"], "cancel"), "ok")
        thread.join(3)
        self.assertEqual(sse_posted[0]["result"]["action"], "cancel")
        self.assertEqual(box["result"]["content"][0]["text"], "done")
        urls = []

        class Ack:
            status = 202
            def read(self, _n=0):
                return b""
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False

        class Opener:
            def open(self, request, timeout=None):
                urls.append(request.full_url)
                return Ack()

        with patch("xueness.bundled_plugins.mcp.sse.urllib.request.build_opener", return_value=Opener()):
            sse._post_result = SseMcpClient._post_result.__get__(sse, SseMcpClient)
            sse._post_result({"jsonrpc": "2.0", "id": 41, "result": {"action": "decline"}})
        self.assertEqual(urls, ["https://mcp.example/message"])

    def test_http_initialize_stays_on_the_old_version_until_the_switch_is_on(self):
        captured = {}
        client = HttpMcpClient({"id": "docs", "url": "https://mcp.example/mcp"}, cwd=self.root)

        def fake_request(_method, params, _request_id):
            captured["params"] = params
            return {"protocolVersion": params["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "h", "version": "1"}}

        client._request = fake_request
        client._notify = lambda *_args, **_kwargs: None
        client.start()
        self.assertEqual(captured["params"]["protocolVersion"], "2025-03-26")
        self.assertEqual(captured["params"]["capabilities"], {})
        client.server["elicitation"] = True
        client.start()
        self.assertEqual(captured["params"]["protocolVersion"], "2025-06-18")
        self.assertEqual(captured["params"]["capabilities"], {"elicitation": {}})

    def test_plugin_binds_clients_and_routes_before_other_families(self):
        plugin = McpPlugin()
        plugin._session = self.session()
        plugin._state_dir = self.root
        client = type("Client", (), {})()
        plugin._bind(client)
        self.assertIs(client._elicitation_session, plugin._session)
        self.assertEqual(plugin_dispatch("GET", ["api", "sessions", SID, "elicitation"], {}, None, {"state_dir": self.root}), (200, {"pending": None}))
        self.assertIsNone(plugin_dispatch("GET", ["api", "elsewhere"], {}, None, {"state_dir": self.root}))


class _FakeResponse:
    def __init__(self, lines):
        self.headers = {"Content-Type": "text/event-stream"}
        self._lines = list(lines)

    def readline(self, _limit=65537):
        if not self._lines:
            return b""
        return self._lines.pop(0)


if __name__ == "__main__":
    unittest.main()
