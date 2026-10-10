"""sessions.cancel_propagate: a stop can unblock a stalled provider read.

The flag is off unless general.sessionsCancelPropagateEnabled is boolean
true and the sessions plugin is enabled. Off means no probe thread and the
existing stream/complete signatures. On, a blocked body read is shut down
with the provider transport helper and is not retried.
"""
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from xueness.core import Gate, Store, run
from xueness.provider import AnthropicMessages, OpenAICompatible
from xueness.bundled_plugins.providers.cancel_watch import (
    ProviderCancelled, bind_provider_cancel, read as watch_read, unbind_provider_cancel,
)
from xueness.bundled_plugins.providers.provider import ProviderRequestError
from xueness.bundled_plugins.sessions.cancel_propagate import callback_for
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.plugin_runtime import set_enabled


_THREAD = 'xueness-provider-cancel'
_SSE = (
    b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
    b'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
    b'data: [DONE]\n\n'
)
_JSON = b'{"choices":[{"message":{"role":"assistant","content":"ok"}}]}'


def _probe_alive():
    return any(thread.name == _THREAD for thread in threading.enumerate())


def _pair():
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    client = socket.socket()
    client.connect(listener.getsockname())
    peer, _ = listener.accept()
    listener.close()
    return client, peer


class _SocketResponse:
    def __init__(self, sock):
        self._sock = sock

    def read(self, size):
        return self._sock.recv(size)


class CallbackTests(unittest.TestCase):
    def test_only_a_real_true_with_sessions_enabled_binds(self):
        self.assertIsNone(callback_for(None, lambda: True))
        self.assertIsNone(callback_for(Path('/tmp'), None))
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            save_settings(state, {'general': {'sessionsCancelPropagateEnabled': True}})
            self.assertTrue(callable(callback_for(state, lambda: True)))
            set_enabled(state, 'sessions', False)
            self.assertIsNone(callback_for(state, lambda: True))
            set_enabled(state, 'sessions', True)
            save_settings(state, {'general': {'sessionsCancelPropagateEnabled': 'true'}})
            self.assertIsNone(callback_for(state, lambda: True))
            save_settings(state, {'general': {}})
            self.assertIsNone(callback_for(state, lambda: False))


class WatchTests(unittest.TestCase):
    def test_deadline_interrupts_the_owned_socket_handle(self):
        from xueness.bundled_plugins.providers.provider import _SocketDeadlineGuard
        client, peer = _pair()
        client.settimeout(3)
        guard = _SocketDeadlineGuard(time.monotonic() + 0.2)
        guard.register(client)
        started = time.monotonic()
        try:
            try:
                data = client.recv(16)
                self.assertEqual(data, b'')
            except OSError:
                pass
            self.assertLess(time.monotonic() - started, 1.0)
        finally:
            guard.close()
            client.close()
            peer.close()

    def test_posix_ssl_socket_uses_an_owned_raw_duplicate(self):
        from xueness.bundled_plugins.providers import cancel_watch
        ssl_socket = mock.Mock(family=socket.AF_INET, type=socket.SOCK_STREAM, proto=0)
        ssl_socket.dup.side_effect = NotImplementedError
        ssl_socket.fileno.return_value = 321
        duplicate = mock.Mock()
        binding = bind_provider_cancel(lambda: False)
        try:
            with mock.patch.object(cancel_watch.os, 'name', 'posix'), \
                    mock.patch.object(cancel_watch.socket, 'fromfd', return_value=duplicate) as fromfd:
                binding.watch.attach(_SocketResponse(ssl_socket))
            fromfd.assert_called_once_with(321, socket.AF_INET, socket.SOCK_STREAM, 0)
        finally:
            unbind_provider_cancel(binding)
        duplicate.close.assert_called_once()

    def _read(self, client, callback):
        """Bind on the reading thread. A new thread does not inherit the probe."""
        client.settimeout(3)
        holder = {}

        def work():
            binding = bind_provider_cancel(callback)
            try:
                watch_read(_SocketResponse(client), 16)
            except Exception as exc:
                holder['error'] = exc
            finally:
                unbind_provider_cancel(binding)

        thread = threading.Thread(target=work, daemon=True)
        thread.start()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        return holder.get('error')

    def test_probe_unblocks_a_read_and_joins(self):
        client, peer = _pair()
        try:
            started = time.monotonic()
            error = self._read(client, lambda: True)
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertIsInstance(error, ProviderCancelled)
            self.assertEqual(error._xueness_stream_control, 'stop')
        finally:
            client.close()
            peer.close()
        self.assertFalse(_probe_alive())

    def test_probe_exception_is_the_original_error(self):
        client, peer = _pair()

        def boom():
            raise RuntimeError('probe failed')

        try:
            error = self._read(client, boom)
            self.assertIsInstance(error, RuntimeError)
            self.assertEqual(str(error), 'probe failed')
        finally:
            client.close()
            peer.close()
        self.assertFalse(_probe_alive())

    def test_no_probe_reads_the_socket_directly(self):
        client, peer = _pair()
        try:
            def send():
                time.sleep(0.05)
                peer.sendall(b'ok')
            threading.Thread(target=send, daemon=True).start()
            self.assertFalse(_probe_alive())
            self.assertEqual(watch_read(_SocketResponse(client), 16), b'ok')
            self.assertFalse(_probe_alive())
        finally:
            client.close()
            peer.close()


def _hang(started, release, *, body, content_type, hold):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.0'

        def do_POST(self):
            calls.append(self.path)
            length = int(self.headers.get('Content-Length', 0) or 0)
            if length:
                self.rfile.read(length)
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.end_headers()
            try:
                self.wfile.flush()
            except OSError:
                return
            started.set()
            release.wait(hold)
            try:
                self.wfile.write(body)
                self.wfile.flush()
            except OSError:
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, calls


def _finish(server, release):
    release.set()
    server.shutdown()
    server.server_close()


class ProviderReadTests(unittest.TestCase):
    def _provider(self, server, **kwargs):
        return OpenAICompatible(
            base=f'http://127.0.0.1:{server.server_port}/v1',
            model='gpt-4o-mini', key='test-key', allow_loopback_http=True, **kwargs)

    def test_flag_off_waits_out_a_stalled_sse_body(self):
        started, release = threading.Event(), threading.Event()
        server, calls = _hang(started, release, body=_SSE,
                              content_type='text/event-stream', hold=2.0)
        provider = self._provider(server)
        holder = {}

        def work():
            try:
                holder['result'] = provider.stream(
                    [{'role': 'user', 'content': 'hi'}], [])
            except Exception as exc:
                holder['error'] = exc

        thread = threading.Thread(target=work)
        thread.start()
        try:
            self.assertTrue(started.wait(10))
            self.assertFalse(_probe_alive())
            mark = time.monotonic()
            thread.join(8)
            self.assertFalse(thread.is_alive())
            self.assertGreaterEqual(time.monotonic() - mark, 1.5)
            self.assertNotIn('error', holder)
            self.assertEqual(holder['result']['content'], 'hi')
            self.assertEqual(calls, ['/v1/chat/completions'])
        finally:
            _finish(server, release)
            thread.join(2)

    def test_bound_probe_cancels_sse_without_retry(self):
        self._assert_cancelled(kind='sse')

    def test_bound_probe_cancels_json_complete_without_retry(self):
        self._assert_cancelled(kind='json')

    def test_bound_probe_cancels_lightweight_deadline_read(self):
        self._assert_cancelled(kind='light')

    def test_bound_probe_cancels_anthropic_complete(self):
        self._assert_cancelled(kind='anthropic')

    def test_probe_exception_is_not_a_provider_error(self):
        started, release = threading.Event(), threading.Event()
        server, calls = _hang(started, release, body=_SSE,
                              content_type='text/event-stream', hold=5.0)
        provider = self._provider(server)

        def boom():
            raise RuntimeError('probe failed')

        holder = {}

        def work():
            binding = bind_provider_cancel(boom)
            try:
                holder['result'] = provider.stream(
                    [{'role': 'user', 'content': 'hi'}], [])
            except Exception as exc:
                holder['error'] = exc
            finally:
                unbind_provider_cancel(binding)

        thread = threading.Thread(target=work)
        thread.start()
        try:
            self.assertTrue(started.wait(10))
            mark = time.monotonic()
            thread.join(8)
            self.assertFalse(thread.is_alive())
            self.assertLess(time.monotonic() - mark, 1.0)
            self.assertIsInstance(holder.get('error'), RuntimeError)
            self.assertNotIsInstance(holder['error'], ProviderRequestError)
            self.assertEqual(str(holder['error']), 'probe failed')
            self.assertEqual(len(calls), 1)
        finally:
            _finish(server, release)
            thread.join(2)
        self.assertFalse(_probe_alive())

    def test_armed_probe_still_reads_a_completed_stream(self):
        payload = _SSE

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get('Content-Length', 0) or 0)
                if length:
                    self.rfile.read(length)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        binding = bind_provider_cancel(lambda: False)
        try:
            result = self._provider(server).stream(
                [{'role': 'user', 'content': 'hi'}], [])
            self.assertEqual(result['content'], 'hi')
        finally:
            unbind_provider_cancel(binding)
            server.shutdown()
            server.server_close()
        self.assertFalse(_probe_alive())

    def _assert_cancelled(self, kind):
        started, release = threading.Event(), threading.Event()
        if kind == 'sse':
            body, content_type = _SSE, 'text/event-stream'
        else:
            body, content_type = _JSON, 'application/json'
        server, calls = _hang(started, release, body=body,
                              content_type=content_type, hold=5.0)
        if kind == 'anthropic':
            provider = AnthropicMessages(
                base=f'http://127.0.0.1:{server.server_port}/v1',
                model='claude-test', key='test-key', allow_loopback_http=True)
        elif kind == 'light':
            provider = self._provider(
                server, runtime_profile='lightweight',
                lightweight_options={'requestTimeoutSeconds': 30, 'transportRetries': 1})
        else:
            provider = self._provider(server)
        holder = {}
        # Become true only after the response headers are out, so the read is
        # already blocked and the probe has to shut the socket down.
        stop = threading.Event()

        def work():
            binding = bind_provider_cancel(stop.is_set)
            try:
                if kind == 'sse':
                    holder['result'] = provider.stream(
                        [{'role': 'user', 'content': 'hi'}], [])
                else:
                    holder['result'] = provider.complete(
                        [{'role': 'user', 'content': 'hi'}], [])
            except Exception as exc:
                holder['error'] = exc
            finally:
                unbind_provider_cancel(binding)

        thread = threading.Thread(target=work)
        thread.start()
        try:
            self.assertTrue(started.wait(10), kind)
            stop.set()
            mark = time.monotonic()
            thread.join(8)
            self.assertFalse(thread.is_alive(), kind)
            self.assertLess(time.monotonic() - mark, 1.0, kind)
            error = holder.get('error')
            self.assertIsInstance(error, ProviderCancelled, f'{kind}: {error!r}')
            self.assertEqual(len(calls), 1, calls)
        finally:
            _finish(server, release)
            thread.join(2)
        self.assertFalse(_probe_alive())


class CorePropagateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.root = base / 'workspace'
        self.root.mkdir()
        self.store = Store(base / 'state')

    def tearDown(self):
        self.temp.cleanup()

    def test_flag_on_keeps_a_fake_provider_signature(self):
        save_settings(self.store.directory,
                      {'general': {'sessionsCancelPropagateEnabled': True}})

        class Provider:
            def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
                if on_delta:
                    on_delta('ok')
                return {'content': 'ok', 'tool_calls': []}

        result = run(self.store.new('answer', self.root), self.store, Provider(),
                     Gate(self.root), max_steps=1, should_stop=lambda: False,
                     policy_state_dir=self.store.directory)
        self.assertEqual(result['messages'][-1]['content'], 'ok')
        self.assertNotEqual(result['status'], 'stopped')
        self.assertFalse(_probe_alive())

    def _run_until_stop(self, *, enabled, sessions_enabled=True):
        if enabled:
            save_settings(self.store.directory,
                          {'general': {'sessionsCancelPropagateEnabled': True}})
        if not sessions_enabled:
            set_enabled(self.store.directory, 'sessions', False)
        stopping = threading.Event()
        started, release = threading.Event(), threading.Event()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'

            def do_POST(self):
                length = int(self.headers.get('Content-Length', 0) or 0)
                if length:
                    self.rfile.read(length)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                try:
                    self.wfile.flush()
                except OSError:
                    return
                stopping.set()
                started.set()
                release.wait(2.0 if not enabled or not sessions_enabled else 5.0)
                try:
                    self.wfile.write(_SSE)
                    self.wfile.flush()
                except OSError:
                    pass

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        provider = OpenAICompatible(
            base=f'http://127.0.0.1:{server.server_port}/v1',
            model='gpt-4o-mini', key='test-key', allow_loopback_http=True)
        holder = {}

        def work():
            try:
                holder['result'] = run(
                    self.store.new('answer', self.root), self.store, provider,
                    Gate(self.root), max_steps=1, should_stop=stopping.is_set,
                    policy_state_dir=self.store.directory)
            except Exception as exc:
                holder['error'] = exc

        thread = threading.Thread(target=work)
        thread.start()
        try:
            self.assertTrue(started.wait(15))
            mark = time.monotonic()
            thread.join(8)
            elapsed = time.monotonic() - mark
            self.assertFalse(thread.is_alive())
            self.assertNotIn('error', holder, holder.get('error'))
            return elapsed, holder['result']
        finally:
            _finish(server, release)
            thread.join(2)

    def test_flag_off_stops_on_the_first_delta(self):
        elapsed, result = self._run_until_stop(enabled=False)
        self.assertGreaterEqual(elapsed, 1.5)
        self.assertEqual(result['status'], 'stopped')
        self.assertFalse(_probe_alive())

    def test_flag_on_stops_during_the_stalled_read(self):
        elapsed, result = self._run_until_stop(enabled=True)
        self.assertLess(elapsed, 1.0)
        self.assertEqual(result['status'], 'stopped')
        self.assertTrue(result.get('streaming', {}).get('interrupted'))
        self.assertFalse(_probe_alive())

    def test_sessions_disabled_does_not_interrupt(self):
        elapsed, result = self._run_until_stop(enabled=True, sessions_enabled=False)
        self.assertGreaterEqual(elapsed, 1.5)
        self.assertEqual(result['status'], 'stopped')
        self.assertFalse(_probe_alive())
