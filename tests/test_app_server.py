"""``xueness app-server``：stdio JSON-RPC 2.0 入口（remote.app_server）。

用真实管道在进程内驱动协议环，provider 一律使用内部 fixture：不访问网络、
不调用真实模型，也绝不监听端口。
"""
import io
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from xueness.bundled_plugins.providers import providers_api
from xueness.bundled_plugins.remote import app_server
from xueness.provider import FakeProvider
from xueness.plugin_runtime import set_enabled

METHODS = {"initialize", "session/list", "session/get", "session/create", "turn/start",
           "turn/cancel", "session/setModel", "session/setEffort", "shutdown", "exit"}


class AppServerHarness:
    """Runs ``app_server.run`` over real pipes and reads its stdout frames."""

    def __init__(self, state_dir, **options):
        self._options = options
        self.buffer = b""
        self.raw_lines = []
        self.pending = []
        self.eof = False
        self.error = None
        self.exit_code = None
        self.stderr = io.BytesIO()
        stdin_read, stdin_write = os.pipe()
        self.out_fd, stdout_write = os.pipe()
        self._server_in = os.fdopen(stdin_read, "rb", closefd=True)
        self._server_out = os.fdopen(stdout_write, "wb", closefd=True)
        self.peer_in = os.fdopen(stdin_write, "wb", closefd=True)
        os.set_blocking(self.out_fd, False)
        self._thread = threading.Thread(target=self._serve, args=(state_dir,),
                                        name="app-server-under-test", daemon=True)
        self._thread.start()

    def _serve(self, state_dir):
        options = self._options
        try:
            self.exit_code = app_server.run(
                state_dir, stdin=self._server_in, stdout=self._server_out, stderr=self.stderr,
                web_runs=options.get("web_runs"), project_dir=options.get("project_dir"),
                workspace_roots=options.get("workspace_roots", ()),
                allow_real=options.get("allow_real"))
        except BaseException as exc:  # a harness crash must surface as a test failure
            self.error = exc
            self.exit_code = 99

    # -- parent side ---------------------------------------------------------
    def send(self, payload):
        if isinstance(payload, bytes):
            data = payload.decode()
        elif isinstance(payload, str):
            data = payload
        else:
            data = json.dumps(payload)
        self.peer_in.write((data if data.endswith("\n") else data + "\n").encode())
        self.peer_in.flush()

    def request(self, method, params=None, request_id=None):
        message = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if request_id is not None:
            message["id"] = request_id
        self.send(message)
        return request_id

    def recv(self, timeout=15):
        """Next frame, newest first from anything a previous read buffered."""
        if self.pending:
            return self.pending.pop(0)
        frame = self._read_frame(time.monotonic() + timeout)
        keys = {"jsonrpc", "id", "result", "error", "method", "params"}
        if not set(frame) <= keys or frame.get("jsonrpc") != "2.0":
            raise AssertionError(f"not a JSON-RPC 2.0 frame: {frame}")
        if sum(key in frame for key in ("result", "error", "method")) != 1:
            raise AssertionError(f"frame is neither response nor notification: {frame}")
        return frame

    def response(self, request_id, timeout=15):
        """The reply to ``request_id``, holding any notifications in the queue.

        ``turn/started`` can overtake the ``turn/start`` reply, so a test must
        never assume the frame right after a request is its own response.
        Non-matching frames go to ``skipped`` rather than back into ``pending``:
        re-queueing them would let the same frame rotate forever and the pipe
        would never be read again.
        """
        skipped = []
        try:
            while True:
                frame = self.recv(timeout=timeout)
                if frame.get("id") == request_id and ("result" in frame or "error" in frame):
                    return frame
                skipped.append(frame)
        finally:
            self.pending[0:0] = skipped

    def _read_frame(self, deadline):
        """Decode the next stdout line, failing on anything that is not a frame."""
        while True:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                self.raw_lines.append(line + b"\n")
                text = line.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    return json.loads(text)
                except ValueError:
                    raise AssertionError("stdout carried a non-protocol line: " + text) from None
            if self.eof:
                raise AssertionError(f"the server closed stdout; error={self.error!r}")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"no frame within the timeout; error={self.error!r}")
            ready, _, _ = select.select([self.out_fd], [], [], min(remaining, 0.2))
            if not ready:
                continue
            try:
                chunk = os.read(self.out_fd, 65536)
            except BlockingIOError:
                continue
            except OSError:
                self.eof = True
                continue
            if not chunk:
                self.eof = True
            else:
                self.buffer += chunk

    def collect(self, methods, timeout=15):
        """Read until every notification in ``methods`` has arrived."""
        pending, collected, first = list(methods), [], None
        while pending:
            frame = self.recv(timeout=timeout)
            collected.append(frame)
            if frame.get("method") in pending:
                if first is None:
                    first = frame
                pending.remove(frame["method"])
        return first, collected

    def close(self, join=True):
        try:
            self.peer_in.close()  # the server reads EOF and returns
        except OSError:
            pass
        if join:
            self._thread.join(20)
        for stream in (self._server_in, self._server_out):
            try:
                stream.close()
            except OSError:
                pass
        try:
            os.close(self.out_fd)
        except OSError:
            pass

    def wait_until_stopped(self):
        self._thread.join(15)
        return self._thread.is_alive()


class ChattyProvider:
    """Prints to stdout to prove the frame writer owns that stream alone."""

    runtime_profile = "standard"
    tool_calling = "native"
    model = "chatty"

    def __init__(self, stream=None):
        self._answered = False

    def complete(self, messages, tools):
        print("noise from a provider")
        if self._answered:
            return {"role": "assistant", "content": json.dumps(
                {"summary": "done", "evidence": []})}
        self._answered = True
        return {"role": "assistant", "content": json.dumps(
            {"summary": "先看看情况", "evidence": []})}


class StallingProvider:
    """Reads a file, then blocks, so a turn can be cancelled while in flight."""

    runtime_profile = "standard"
    tool_calling = "native"
    model = "stalling"

    def __init__(self):
        self.calls = 0

    def complete(self, messages, tools):
        self.calls += 1
        if self.calls == 1:
            return {"role": "assistant", "content": "", "tool_calls": [
                {"id": "stall-read", "type": "function", "function": {
                    "name": "read", "arguments": json.dumps({"path": "hello.txt"})}}]}
        threading.Event().wait(2)
        return {"role": "assistant", "content": json.dumps(
            {"summary": "still here", "evidence": []})}


class AppServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state = base / "state"
        self.root = base / "work"
        self.root.mkdir()
        (self.root / "hello.txt").write_text("xueness\n", encoding="utf-8")
        set_enabled(self.state, "remote", True)
        self.ctx = app_server.build_app_context(
            self.state, web_runs=base / "runs", project_dir=base / "proj",
            workspace_roots=[self.root], allow_real=True)
        self.options = {"web_runs": base / "runs", "project_dir": base / "proj",
                        "workspace_roots": [self.root], "allow_real": True}
        self.peer = None

    def tearDown(self):
        if self.peer is not None:
            self.peer.close()

    def start(self):
        self.peer = AppServerHarness(self.state, **self.options)
        return self.peer

    def create(self, peer, task, request_id):
        peer.request("session/create", {"task": task, "root": str(self.root)},
                     request_id=request_id)
        return peer.response(request_id)["result"]["id"]

    # -- framing and errors -------------------------------------------------
    def test_initialize_describes_protocol_and_trust_model(self):
        peer = self.start()
        peer.request("initialize", request_id=1)
        result = peer.recv()["result"]
        self.assertEqual(result["protocolName"], "xueness.app-server.v1")
        self.assertEqual(result["protocolVersion"], 1)
        self.assertFalse(result["capabilities"]["networkListener"])
        self.assertFalse(result["capabilities"]["hostOriginCsrf"])
        self.assertIn("parent process", result["capabilities"]["trustModel"])
        self.assertEqual(result["limits"]["maxFrameBytes"], app_server.MAX_FRAME_BYTES)
        self.assertEqual(set(result["methods"]), METHODS)
        self.assertIn("sessions", [item["id"] for item in result["plugins"]])

    def test_unknown_method_returns_method_not_found(self):
        peer = self.start()
        peer.request("does/not/exist", request_id="x1")
        frame = peer.recv()
        self.assertEqual(frame["id"], "x1")
        self.assertEqual(frame["error"]["code"], -32601)
        self.assertIn("initialize", frame["error"]["data"]["known"])

    def test_malformed_json_returns_parse_error_and_the_loop_survives(self):
        peer = self.start()
        peer.send("{not json}")
        frame = peer.recv()
        self.assertIsNone(frame["id"])
        self.assertEqual(frame["error"]["code"], -32700)
        peer.request("initialize", request_id=2)
        self.assertEqual(peer.recv()["id"], 2)

    def test_oversized_frame_is_refused_not_buffered(self):
        peer = self.start()
        peer.send('{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"pad":"'
                  + "x" * (app_server.MAX_FRAME_BYTES + 4096) + '"}}')
        frame = peer.recv()
        self.assertEqual(frame["error"]["code"], -32700)
        self.assertIn(str(app_server.MAX_FRAME_BYTES), frame["error"]["data"]["reason"])
        peer.request("initialize", request_id=4)
        self.assertEqual(peer.recv()["id"], 4)

    def test_request_envelope_is_validated(self):
        peer = self.start()
        peer.send({"jsonrpc": "2.0", "id": 5, "method": "initialize"})
        peer.send({"jsonrpc": "1.0", "id": 6, "method": "initialize"})
        peer.send({"jsonrpc": "2.0", "id": 7, "method": "session/create", "params": [1]})
        peer.send({"jsonrpc": "2.0", "id": 8, "method": "session/create", "params": {"nope": 1}})
        peer.send({"jsonrpc": "2.0", "id": 9})
        self.assertEqual(peer.response(5)["result"]["protocolName"], "xueness.app-server.v1")
        self.assertEqual(peer.response(6)["error"]["code"], -32600)
        self.assertEqual(peer.response(7)["error"]["code"], -32602)
        refused = peer.response(8)["error"]
        self.assertEqual(refused["code"], -32602)
        self.assertEqual(refused["data"]["keys"], ["nope"])
        self.assertEqual(peer.response(9)["error"]["code"], -32600)
        # A notification is answered by its effects only: no id, no reply frame.
        peer.send({"jsonrpc": "2.0", "method": "initialize", "params": {}})
        peer.request("initialize", request_id=10)
        self.assertEqual(peer.recv()["id"], 10)

    # -- session methods ----------------------------------------------------
    def test_session_create_list_get_round_trip(self):
        peer = self.start()
        sid = self.create(peer, "读一下文件", 10)
        peer.request("session/list", request_id=11)
        listed = peer.recv()["result"]
        self.assertEqual([item["id"] for item in listed["sessions"]], [sid])
        peer.request("session/get", {"sessionId": sid}, request_id=12)
        detail = peer.recv()["result"]
        self.assertEqual(detail["id"], sid)
        self.assertEqual(detail["task"], "读一下文件")

    def test_session_methods_validate_the_session_id(self):
        peer = self.start()
        for method in ("session/get", "session/setModel", "session/setEffort",
                       "turn/start", "turn/cancel"):
            peer.request(method, {"sessionId": "nope"}, request_id=method)
            self.assertEqual(peer.recv()["error"]["code"], -32602, method)

    def test_unknown_session_is_refused_with_the_http_status(self):
        peer = self.start()
        peer.request("session/get", {"sessionId": "0" * 32}, request_id=30)
        frame = peer.recv()
        self.assertEqual(frame["error"]["code"], -32000)
        self.assertEqual(frame["error"]["data"]["status"], 404)

    def test_set_model_and_effort_use_the_sessions_route(self):
        record = {"id": "local", "name": "Local", "baseUrl": "https://models.example.test/v1",
                  "model": "small", "apiKey": "test-only-key",
                  "reasoningLevels": ["low", "high"]}
        status, _ = providers_api.dispatch("POST", ["api", "providers"], {}, record, self.ctx)
        self.assertEqual(status, 200)
        peer = self.start()
        sid = self.create(peer, "切换模型", 20)

        peer.request("session/setModel",
                     {"sessionId": sid, "providerId": "local", "model": "small"}, request_id=21)
        applied = peer.recv()["result"]
        self.assertEqual(applied["applied"], "immediate")
        self.assertEqual(applied["model_selection"], {"provider_id": "local", "model": "small"})

        peer.request("session/setEffort", {"sessionId": sid, "reasoningEffort": "high"},
                     request_id=22)
        self.assertEqual(peer.recv()["result"]["model_selection"]["reasoning_effort"], "high")

        peer.request("session/setEffort", {"sessionId": sid, "reasoningEffort": "ultra"},
                     request_id=23)
        self.assertEqual(peer.recv()["error"]["code"], -32602)

        peer.request("session/setEffort", {"sessionId": sid}, request_id=24)
        self.assertEqual(peer.recv()["error"]["code"], -32602)

        peer.request("session/get", {"sessionId": sid}, request_id=25)
        detail = peer.recv()["result"]
        self.assertEqual(detail["model_selection"],
                         {"provider_id": "local", "model": "small", "reasoning_effort": "high"})
        self.assertEqual([entry["effect"] for entry in detail["model_history"]],
                         ["immediate", "immediate"])

    # -- turns --------------------------------------------------------------
    def test_turn_start_streams_notifications_then_finishes(self):
        peer = self.start()
        sid = self.create(peer, "创建 hello.txt 并验证内容", 40)
        with patch("xueness.provider_config.resolve", return_value=FakeProvider()):
            peer.request("turn/start", {"sessionId": sid, "text": "创建 hello.txt",
                                        "permissionMode": "yolo"}, request_id=41)
            accepted = peer.response(41)["result"]
            self.assertEqual(accepted["sessionId"], sid)
            self.assertTrue(accepted["accepted"])
            started, frames = peer.collect(["turn/started", "turn/finished"])
        self.assertEqual(started["method"], "turn/started")
        self.assertEqual(started["params"]["sessionId"], sid)
        finished = frames[-1]
        self.assertEqual(finished["method"], "turn/finished")
        self.assertEqual(finished["params"]["sessionId"], sid)
        self.assertTrue(finished["params"]["ok"], finished["params"])
        self.assertEqual(finished["params"]["result"]["status"], "completed")
        events = [frame["params"]["event"] for frame in frames
                  if frame.get("method") == "session/event"]
        self.assertTrue(events)
        self.assertTrue(any(event.get("type") in ("tool.call", "tool.result", "assistant.message")
                            for event in events), [event.get("type") for event in events])
        self.assertTrue(all(frame["params"]["sessionId"] == sid for frame in frames
                            if frame.get("method")))

    def test_turn_cancel_stops_the_run(self):
        peer = self.start()
        sid = self.create(peer, "反复读取", 45)
        provider = StallingProvider()
        with patch("xueness.provider_config.resolve", return_value=provider):
            peer.request("turn/start", {"sessionId": sid, "text": "慢慢想"}, request_id=46)
            self.assertTrue(peer.response(46)["result"]["accepted"])
            peer.collect(["turn/started"])
            peer.request("turn/cancel", {"sessionId": sid}, request_id=47)
            self.assertEqual(peer.response(47)["id"], 47)
            finished, _ = peer.collect(["turn/finished"])
        self.assertEqual(finished["params"]["sessionId"], sid)

    def test_a_second_turn_on_the_same_session_is_refused(self):
        peer = self.start()
        sid = self.create(peer, "两次运行", 48)
        provider = StallingProvider()
        with patch("xueness.provider_config.resolve", return_value=provider):
            peer.request("turn/start", {"sessionId": sid, "text": "第一次"}, request_id=49)
            self.assertTrue(peer.response(49)["result"]["accepted"])
            peer.collect(["turn/started"])
            peer.request("turn/start", {"sessionId": sid, "text": "第二次"}, request_id=50)
            refused = peer.response(50)["error"]
            self.assertEqual(refused["code"], -32000)
            self.assertEqual(refused["data"]["status"], 409)
            peer.request("turn/cancel", {"sessionId": sid}, request_id=51)
            self.assertEqual(peer.response(51)["id"], 51)
            peer.collect(["turn/finished"])

    def test_stdout_carries_protocol_frames_only(self):
        peer = self.start()
        sid = self.create(peer, "打印噪声", 52)
        with patch("xueness.provider_config.resolve", return_value=ChattyProvider()):
            peer.request("turn/start", {"sessionId": sid, "text": "随便说点什么"},
                         request_id=53)
            self.assertTrue(peer.response(53)["result"]["accepted"])
            peer.collect(["turn/finished"])
        self.assertIn(b"noise from a provider", peer.stderr.getvalue())
        self.assertFalse([line for line in peer.raw_lines if b"noise" in line])

    # -- lifecycle ----------------------------------------------------------
    def test_shutdown_stops_serving_and_returns_zero(self):
        peer = self.start()
        peer.request("shutdown", request_id=60)
        self.assertEqual(peer.recv()["result"]["ok"], True)
        self.assertFalse(peer.wait_until_stopped(), "the serve loop kept running")
        self.assertEqual(peer.exit_code, 0)
        self.assertIsNone(peer.error)
        peer.close(join=False)

    def test_run_refuses_to_start_when_remote_is_disabled(self):
        set_enabled(self.state, "remote", False)
        self.addCleanup(set_enabled, self.state, "remote", True)
        err = io.BytesIO()
        code = app_server.run(self.state, stdin=io.BytesIO(b""), stdout=io.BytesIO(), stderr=err)
        self.assertEqual(code, 2)
        text = err.getvalue().decode("utf-8")
        self.assertIn("refused to start", text)
        self.assertIn("remote", text)
        self.assertEqual(err.getvalue().count(b"{"), 0)

    def test_existing_server_refuses_requests_after_remote_is_disabled(self):
        output = io.BytesIO()
        server = app_server.AppServer(self.ctx, app_server._Frames(output))
        set_enabled(self.state, "remote", False)
        with patch.object(app_server.plugin_runtime, 'dispatch_http') as dispatch:
            server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 601,
                "method": "session/create", "params": {"task": "must not start", "root": str(self.root)}}).encode())
            dispatch.assert_not_called()
        frame = json.loads(output.getvalue())
        self.assertEqual(frame['error']['data'], {'status': 403, 'plugin': 'remote'})
        self.assertTrue(server._stopping.is_set())
        self.assertEqual(server._call('POST', '/api/sessions', {'task': 'must not start'})[0], 403)

    def test_disabling_remote_stops_an_idle_stdio_server(self):
        peer = self.start()
        peer.request('initialize', request_id=602)
        peer.response(602)
        set_enabled(self.state, 'remote', False)
        self.assertFalse(peer.wait_until_stopped(), 'idle stdin prevented plugin shutdown')
        self.assertEqual(peer.exit_code, 0)
        self.assertIsNone(peer.error)

    def test_disabling_remote_requests_stop_for_an_active_turn(self):
        peer = self.start()
        sid = self.create(peer, 'cancel when remote stops', 603)
        with patch('xueness.provider_config.resolve', return_value=StallingProvider()):
            peer.request('turn/start', {'sessionId': sid, 'text': 'read file'}, request_id=604)
            self.assertTrue(peer.response(604)['result']['accepted'])
            peer.collect(['turn/started'])
            set_enabled(self.state, 'remote', False)
            self.assertFalse(peer.wait_until_stopped(), 'active turn kept disabled server alive')
        self.assertIsNone(peer.error)
        session = self.ctx['store'].load(sid)
        self.assertNotEqual(session['status'], 'running')

    def test_cli_exits_nonzero_when_the_plugin_is_disabled(self):
        set_enabled(self.state, "remote", False)
        env = dict(os.environ)
        env.pop("XUENESS_STATE", None)
        result = subprocess.run(
            [sys.executable, "-m", "xueness", "--state", str(self.state), "app-server"],
            input="", capture_output=True, text=True, timeout=180, env=env,
            cwd=str(Path(__file__).resolve().parents[1]))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("remote", result.stderr)
        self.assertEqual(result.stdout.strip(), "")

    def test_serving_never_creates_a_socket(self):
        peer = self.start()
        created = []
        real = socket.socket

        class Watched(real):
            def __init__(self, *args, **kwargs):
                created.append((args, kwargs))
                super().__init__(*args, **kwargs)

        patcher = patch.object(socket, "socket", Watched)
        patcher.start()
        self.addCleanup(patcher.stop)
        try:
            peer.request("initialize", request_id=70)
            peer.response(70)
            sid = self.create(peer, "不要监听", 71)
            with patch("xueness.provider_config.resolve", return_value=FakeProvider()):
                peer.request("turn/start", {"sessionId": sid, "text": "创建 hello.txt",
                                            "permissionMode": "yolo"}, request_id=72)
                peer.response(72)
                peer.collect(["turn/finished"])
        finally:
            patcher.stop()
        self.assertEqual(created, [])

    def test_workspace_boundary_still_applies_over_stdio(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        peer = self.start()
        peer.request("session/create", {"task": "越界工作区", "root": str(outside)},
                     request_id=80)
        error = peer.response(80)["error"]
        self.assertEqual(error["code"], -32602)
        self.assertEqual(error["data"]["status"], 400)
        self.assertIn("workspace root", error["message"])

    def test_a_turn_waits_for_permission_instead_of_auto_approving(self):
        peer = self.start()
        sid = self.create(peer, "写入需要逐次确认", 88)
        with patch("xueness.provider_config.resolve", return_value=FakeProvider()):
            peer.request("turn/start", {"sessionId": sid, "text": "创建 notes.txt"},
                         request_id=89)
            self.assertTrue(peer.response(89)["result"]["accepted"])
            _, frames = peer.collect(["turn/started", "turn/finished"])
        finished = frames[-1]
        self.assertTrue(finished["params"]["ok"], finished["params"])
        result = finished["params"]["result"]
        self.assertEqual(result["status"], "paused")
        self.assertTrue(result["pending"], result)
        self.assertEqual(result["pending"][0]["name"], "write")
        self.assertFalse((self.root / "notes.txt").exists())

    def test_an_unknown_permission_mode_is_refused(self):
        peer = self.start()
        sid = self.create(peer, "非法模式", 94)
        peer.request("turn/start", {"sessionId": sid, "text": "hi",
                                    "permissionMode": "yolo-forever"}, request_id=95)
        error = peer.response(95)["error"]
        self.assertEqual(error["code"], -32602)
        self.assertEqual(error["data"]["permissionMode"], "yolo-forever")
        # Rejected at the protocol boundary: no turn opened, so no notifications.
        peer.request("session/get", {"sessionId": sid}, request_id=96)
        self.assertNotEqual(peer.response(96)["result"]["status"], "running")

    def test_turn_stops_a_run_when_the_plugin_is_disabled_midflight(self):
        peer = self.start()
        sid = self.create(peer, "禁用后不再运行", 96)
        with patch("xueness.provider_config.resolve", return_value=FakeProvider()):
            peer.request("turn/start", {"sessionId": sid, "text": "创建 hello.txt",
                                        "permissionMode": "yolo"}, request_id=97)
            self.assertTrue(peer.response(97)["result"]["accepted"])
            peer.collect(["turn/finished"])
        set_enabled(self.state, "sessions", False)
        self.addCleanup(set_enabled, self.state, "sessions", True)
        peer.request("turn/start", {"sessionId": sid, "text": "再来一次"}, request_id=98)
        error = peer.response(98)["error"]
        self.assertEqual(error["code"], -32000)
        self.assertEqual(error["data"]["status"], 403)
        self.assertEqual(error["data"]["plugin"], "sessions")


if __name__ == "__main__":
    unittest.main()
