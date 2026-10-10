"""Provider adapters for configured models plus an internal automatic-test fixture."""
import ipaddress
import base64
import email.utils
import errno
import http.client
import json
import math
import os
import re
import select
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from . import cancel_watch
from .runtime_options import build_openai_payload, resolve_runtime_options, validate_compatibility
from .lightweight_config import effective_options
from .tool_protocol import NativeCallAssembler

#: Opt-in env flag unlocking plaintext HTTP **only** for loopback IP literals.
#: Kept off by default so existing HTTPS-only behaviour is unchanged.
LOOPBACK_HTTP_ENV = "XUENESS_ALLOW_LOOPBACK_HTTP"
MAX_PROVIDER_RESPONSE_BYTES = 2_000_000
MAX_MODEL_LIST_RESPONSE_BYTES = 512_000
MAX_DISCOVERED_MODELS = 500
MAX_DISCOVERED_MODEL_ID_CHARS = 256
MAX_MODEL_OWNER_CHARS = 128
MODEL_DISCOVERY_MAX_TIMEOUT_SECONDS = 8.0
COMPATIBILITY_TEST_MAX_OUTPUT_TOKENS = 1024
COMPATIBILITY_TEST_MAX_TIMEOUT_SECONDS = 120.0
COMPATIBILITY_TEST_MODES = frozenset({
    "conversation", "native_tool_call", "json_tool_call", "stream", "tool_roundtrip", "json_tool_roundtrip",
})
COMPATIBILITY_FIXTURE_NAME = "xueness_fixture_add"
COMPATIBILITY_FIXTURE_RECEIPT = "xueness-local-fixture:3+4=7"


def _native_fixture_prompt():
    return [
        {"role": "system", "content": (
            "This is a provider compatibility diagnostic. Call the supplied test-only "
            "arithmetic function exactly once with a=3 and b=4. Do not answer in prose. "
            "The function is isolated and has no file or command effects.")},
        {"role": "user", "content": "Call the supplied arithmetic function with a=3 and b=4."},
    ]


def _json_fixture_prompt():
    return [
        {"role": "system", "content": (
            "This is a provider compatibility diagnostic. Return exactly one JSON object "
            "with keys tool and arguments, no markdown or extra keys. tool must be "
            "xueness_fixture_add and arguments must have integer values a=3 and b=4. "
            "Do not answer in prose.")},
        {"role": "user", "content": (
            'Return {"tool":"xueness_fixture_add",'
            '"arguments":{"a":3,"b":4}} exactly.')},
    ]


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _fixture_arguments_valid(value):
    return (type(value) is dict and set(value) == {"a", "b"}
            and type(value.get("a")) is int and value["a"] == 3
            and type(value.get("b")) is int and value["b"] == 4)


def _validated_fixture_tool_call(reply):
    calls = reply.get("tool_calls") if isinstance(reply, dict) else None
    if not isinstance(calls, list) or len(calls) != 1:
        return None, "The provider did not return exactly one function call."
    call = calls[0]
    if not isinstance(call, dict) or call.get("type") != "function":
        return None, "The provider returned an invalid function-call envelope."
    call_id = call.get("id")
    if (not isinstance(call_id, str) or not call_id or len(call_id) > 128
            or not call_id.isascii()
            or any(not (char.isalnum() or char in "._:-") for char in call_id)):
        return None, "The provider returned an invalid function-call ID."
    function = call.get("function")
    if (not isinstance(function, dict) or function.get("name") != COMPATIBILITY_FIXTURE_NAME
            or set(function) != {"name", "arguments"}):
        return None, "The provider returned an unexpected function name or shape."
    raw_arguments = function.get("arguments")
    if not isinstance(raw_arguments, str) or len(raw_arguments) > 1024:
        return None, "The provider returned invalid function arguments."
    try:
        arguments = json.loads(raw_arguments, object_pairs_hook=_unique_json_object)
    except (TypeError, ValueError):
        return None, "The provider returned invalid function arguments."
    if not _fixture_arguments_valid(arguments):
        return None, "The provider returned arguments outside the required {a: 3, b: 4} schema."
    return call, None


def _validated_fixture_json_call(reply):
    raw = reply.get("content") if isinstance(reply, dict) else None
    if not isinstance(raw, str) or len(raw) > 2048:
        return "The provider returned no bounded JSON tool-call response."
    from .lightweight import decode_text_response
    fixture = [{'type': 'function', 'function': {'name': COMPATIBILITY_FIXTURE_NAME}}]
    parsed = decode_text_response(reply, fixture)
    if parsed.get('_protocol_error'):
        return "The provider did not return strict JSON."
    call, error = _validated_fixture_tool_call(parsed)
    if error:
        return "The provider returned JSON outside the required function name and argument schema."
    return None


def _with_reported_usage(message, payload):
    """Retain actual JSON-response usage just as the SSE adapter does."""
    from .response_metadata import reported_usage, finish_reason
    if not isinstance(message, dict):
        raise ValueError("provider message must be an object")
    result = dict(message)
    result.pop('_usage', None)
    result.pop('_finish_reason', None)
    usage = reported_usage(payload.get('usage'))
    if usage:
        result['_usage'] = usage
    choices = payload.get('choices') or []
    raw_reason = (choices[0].get('finish_reason') if choices and isinstance(choices[0], dict)
                  else payload.get('stop_reason'))
    reason = finish_reason(raw_reason)
    if reason is not None:
        result['_finish_reason'] = reason
    return result


def _with_request_attempts(response, attempts):
    """Attach adapter-owned retry telemetry after discarding remote lookalikes."""
    if not isinstance(response, dict):
        raise ValueError("provider response must be an object")
    result = dict(response)
    result.pop("_request_attempts", None)
    result["_request_attempts"] = max(1, int(attempts))
    return result


def _http_error_category(status):
    if status in (400, 413, 422):
        return "request_rejected"
    if status in (401, 403):
        return "authentication_failed"
    if status == 404:
        return "endpoint_not_found"
    if status in (408, 504):
        return "timeout"
    if status == 429:
        return "rate_limited"
    if status in (502, 503):
        return "service_unready"
    if type(status) is int and 500 <= status <= 599:
        return "upstream_failure"
    return "http_error"


def _transport_error_category(error):
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, TimeoutError):
        return "timeout"
    if (isinstance(reason, ConnectionRefusedError)
            or getattr(reason, "errno", None) == errno.ECONNREFUSED
            or getattr(reason, "winerror", None) == 10061):
        return "service_unready"
    return "connection_failed"


class ProviderCallbackError(Exception):
    """A caller's stream callback failed; it is not a provider transport error."""

    def __init__(self, exception_type):
        super().__init__("provider stream callback failed")
        name = exception_type if isinstance(exception_type, str) else "Exception"
        self.exception_type = name[:80]
        self.trace_id = uuid.uuid4().hex[:16]
        self.stage = "stream_callback"


def _notify_stream_callback(callback, value):
    try:
        callback(value)
    except Exception as exc:
        # Cooperative cancellation is raised by core callbacks to unwind the
        # socket read. Preserve that control signal so it can settle as
        # "stopped" instead of becoming a callback or provider failure.
        if getattr(exc, "_xueness_stream_control", None) == "stop":
            raise
        # Do not retain or stringify the callback exception: it may contain a
        # workspace path, a prompt fragment, or other private application data.
        raise ProviderCallbackError(type(exc).__name__) from None


class ProviderRequestError(RuntimeError):
    """Sanitized provider failure with safe classification for callers."""

    def __init__(self, status=None, retry_after=None, *, context_overflow=False,
                 category=None, stage="response", trace_id=None,
                 exception_type=None):
        super().__init__("provider request failed (details suppressed)")
        self.status = status if type(status) is int and 100 <= status <= 599 else None
        self.category = category or (_http_error_category(self.status)
                                     if self.status is not None else "request_failed")
        self.stage = stage if stage in ("connect", "read", "parse", "deadline", "response") else "response"
        self.trace_id = trace_id if isinstance(trace_id, str) and re.fullmatch(r"[0-9a-f]{16}", trace_id) else uuid.uuid4().hex[:16]
        self.exception_type = (exception_type[:80] if isinstance(exception_type, str)
                               else None)
        self.context_overflow = bool(context_overflow)
        retryable = self.status == 429 or (self.status is not None and 500 <= self.status <= 599)
        self.retry_after = (max(0.0, min(float(retry_after), 2.0))
                            if retryable and isinstance(retry_after, (int, float)) else None)


def _provider_request_error(error, *, status=None, retry_after=None,
                            context_overflow=False, stage="response"):
    if status is not None:
        category = _http_error_category(status)
    elif isinstance(error, (urllib.error.URLError, OSError)):
        category = _transport_error_category(error)
    else:
        category = "invalid_response"
    return ProviderRequestError(
        status, retry_after, context_overflow=context_overflow,
        category=category, stage=stage, exception_type=type(error).__name__,
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the provider bearer token to a redirect destination.

    Raising (instead of returning None) fails closed and avoids leaking the
    unclosed redirect response object (ResourceWarning) under stdlib semantics.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if fp is not None:
            fp.close()  # Do not drain an untrusted response body (it may be unbounded).
        raise urllib.error.URLError(f"provider redirect blocked ({code})")


def _interrupt_socket(sock, *, blocked_socket=None):
    """Interrupt an owned request, suppressing cleanup errors.

    Winsock shutdown does not wake a select/recv already waiting on another
    handle. Close the request's original native socket on Windows as well;
    socket.close() alone can defer that close while HTTP's SocketIO owns it.
    """
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    if os.name == 'nt' and blocked_socket is not None:
        try:
            socket.SocketType.close(blocked_socket)
        except (OSError, TypeError):
            pass
    try:
        sock.close()
    except OSError:
        pass


class _SocketDeadlineGuard:
    """One joined watchdog that interrupts urllib while it reads headers.

    urllib delegates status/header parsing to http.client before returning a
    response object, so body-level deadline checks alone cannot bound a peer
    that trickles headers. The watchdog only shuts down registered sockets; it
    never reads provider data. It is cancelled and joined before the call
    returns. POSIX keeps duplicated descriptors; Windows keeps live socket
    objects and closes their original handles to wake outstanding reads.
    """

    def __init__(self, deadline):
        self.deadline = deadline
        self._lock = threading.Lock()
        self._sockets = []
        self._expired = False
        delay = max(0.0, deadline - time.monotonic())
        self._timer = threading.Timer(delay, self._expire)
        self._timer.daemon = True
        self._timer.start()

    def remaining(self):
        return max(0.0, self.deadline - time.monotonic())

    def register(self, sock):
        # An extra Winsock handle prevents closing the original from waking a
        # blocked read. Keep its object alive without making another handle.
        if os.name == 'nt':
            with self._lock:
                close_now = self._expired
                if not close_now:
                    self._sockets.append((None, sock))
            if close_now:
                _interrupt_socket(sock, blocked_socket=sock)
            return
        try:
            duplicate = sock.dup()
        except (OSError, NotImplementedError):
            duplicate = None
        if duplicate is None:
            return
        with self._lock:
            if self._expired:
                close_now = True
            else:
                self._sockets.append((duplicate, sock))
                close_now = False
        if close_now:
            _interrupt_socket(duplicate)

    def _expire(self):
        with self._lock:
            self._expired = True
            sockets = list(self._sockets)
        for duplicate, original in sockets:
            _interrupt_socket(duplicate or original, blocked_socket=original)

    def close(self):
        self._timer.cancel()
        self._timer.join()
        with self._lock:
            sockets, self._sockets = self._sockets, []
        for sock, _original in sockets:
            if sock is None:
                continue
            try:
                sock.close()
            except OSError:
                pass


class _DeadlineConnectionMixin:
    def _remaining(self):
        if self._deadline_guard is None:
            return self.timeout
        remaining = self._deadline_guard.remaining()
        if remaining <= 0:
            raise TimeoutError("provider request deadline exceeded")
        return remaining

    def _connect_tcp(self):
        # Nonblocking connect plus select uses the same absolute deadline for
        # every resolved address. Duplicate only after connect: on Windows a
        # duplicate made before connect remains unconnected, so shutting it
        # down cannot interrupt the original socket's header reads. The TCP
        # handshake itself is bounded by the nonblocking select below.
        errors = []
        # The stdlib's synchronous resolver cannot be interrupted by the
        # socket watchdog; DNS lookup keeps the operating system's resolver
        # timing. Once an address is available, connect/TLS/HTTP I/O are bounded.
        addresses = socket.getaddrinfo(self.host, self.port, 0, socket.SOCK_STREAM)
        for family, socktype, proto, _canonname, address in addresses:
            sock = socket.socket(family, socktype, proto)
            try:
                if self.source_address:
                    sock.bind(self.source_address)
                sock.setblocking(False)
                result = sock.connect_ex(address)
                pending = {
                    0,
                    errno.EISCONN,
                    errno.EINPROGRESS,
                    errno.EWOULDBLOCK,
                    errno.EALREADY,
                    getattr(errno, "WSAEWOULDBLOCK", errno.EWOULDBLOCK),
                }
                if result not in pending:
                    raise OSError(result, os.strerror(result))
                if result not in (0, errno.EISCONN):
                    remaining = self._remaining()
                    _readable, writable, exceptional = select.select([], [sock], [sock], remaining)
                    if not writable and not exceptional:
                        raise TimeoutError("provider request deadline exceeded")
                    error = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                    if error:
                        raise OSError(error, os.strerror(error))
                sock.setblocking(True)
                sock.settimeout(self._remaining())
                self._deadline_guard.register(sock)
                self.sock = sock
                try:
                    self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except OSError as exc:
                    if exc.errno != errno.ENOPROTOOPT:
                        raise
                return
            except OSError as exc:
                sock.close()
                errors.append(exc)
                if self._deadline_guard.remaining() <= 0:
                    raise TimeoutError("provider request deadline exceeded") from None
        if errors:
            raise errors[-1]
        raise OSError("provider connection failed")

    def send(self, data):
        if self._deadline_guard is not None and self.sock is not None:
            self.sock.settimeout(self._remaining())
        return super().send(data)


class _DeadlineHTTPConnection(_DeadlineConnectionMixin, http.client.HTTPConnection):
    """HTTPConnection that registers sockets and uses deadline-aware I/O."""

    def __init__(self, *args, deadline_guard=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._deadline_guard = deadline_guard

    def connect(self):
        if self._deadline_guard is None:
            return super().connect()
        self._connect_tcp()
        if self._tunnel_host:
            self._tunnel()


class _DeadlineHTTPSConnection(_DeadlineConnectionMixin, http.client.HTTPSConnection):
    """HTTPSConnection whose TLS handshake also has the absolute watchdog."""

    def __init__(self, *args, deadline_guard=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._deadline_guard = deadline_guard

    def connect(self):
        if self._deadline_guard is None:
            return super().connect()
        self._connect_tcp()
        if self._tunnel_host:
            self._tunnel()
        server_hostname = self._tunnel_host or self.host
        self.sock = self._context.wrap_socket(self.sock, server_hostname=server_hostname)
        if self._deadline_guard is not None:
            if os.name == 'nt':
                self._deadline_guard.register(self.sock)
            # The raw TCP descriptor was duplicated before wrapping; duplicating
            # an SSLSocket is unsupported and unnecessary for shutdown.
            self.sock.settimeout(self._remaining())


def _provider_opener(base, *handlers):
    """Keep literal loopback model calls off proxies; retain remote proxy behavior."""
    if _is_loopback_literal(urllib.parse.urlparse(base).hostname):
        handlers = (*handlers, urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


def _deadline_opener(deadline_guard, base=None):
    """Build urllib handlers that share a request's absolute deadline."""
    def connection_factory(connection_type):
        def make_connection(host, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, **kwargs):
            kwargs["deadline_guard"] = deadline_guard
            return connection_type(host, timeout=timeout, **kwargs)
        return make_connection

    class DeadlineHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(connection_factory(_DeadlineHTTPConnection), req)

    class DeadlineHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(connection_factory(_DeadlineHTTPSConnection), req,
                                context=self._context)

    handlers = (_NoRedirect, DeadlineHTTPHandler(), DeadlineHTTPSHandler())
    if base and _is_loopback_literal(urllib.parse.urlparse(base).hostname):
        handlers = (*handlers, urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


def _loopback_http_enabled(explicit=None):
    """Opt-in gate for plaintext HTTP. Explicit param wins; else env flag."""
    if explicit is not None:
        return bool(explicit)
    return os.environ.get(LOOPBACK_HTTP_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def _is_loopback_literal(hostname):
    """True only for IP literals with is_loopback (127/8, ::1, ::ffff:127/8).

    Hostnames such as ``localhost`` or ``127.0.0.1.evil.com`` are not IP
    literals and return False. Decimal/octal/hex tricks (``2130706433``,
    ``0x7f000001``, ``0177.0.0.1``) are rejected by ipaddress and return False.
    """
    if not hostname:
        return False
    try:
        address = ipaddress.ip_address(hostname)
        mapped = getattr(address, 'ipv4_mapped', None)
        return address.is_loopback or mapped is not None and mapped.is_loopback
    except ValueError:
        return False


def _explicit_request_deadline(provider):
    """Return a validated absolute monotonic deadline assigned by the run loop."""
    run_deadline = getattr(provider, "request_deadline", None)
    if run_deadline is None:
        return None
    if type(run_deadline) not in (int, float):
        raise ValueError("invalid provider request deadline")
    try:
        run_deadline = float(run_deadline)
    except (OverflowError, ValueError):
        raise ValueError("invalid provider request deadline") from None
    if not math.isfinite(run_deadline):
        raise ValueError("invalid provider request deadline")
    return run_deadline


def _lightweight_request_settings(provider):
    """Resolve one lightweight inference's total deadline and retry count."""
    options = effective_options(
        value=getattr(provider, "lightweight_options", {}),
        context=getattr(provider, "context_window", None),
        output=getattr(provider, "max_output_tokens", None),
    )
    now = time.monotonic()
    deadline = now + options["requestTimeoutSeconds"]
    run_deadline = _explicit_request_deadline(provider)
    if run_deadline is not None:
        deadline = min(deadline, run_deadline)
    if deadline <= now:
        raise TimeoutError("provider request deadline exceeded")
    return deadline, 1 + options["transportRetries"]


class OpenAICompatible:
    def __init__(self, base=None, model=None, key=None, allow_loopback_http=None,
                 capabilities=None, reasoning_effort=None, runtime_profile="standard",
                 context_window=None, max_output_tokens=None, tool_calling="native",
                 compatibility=None, allow_empty_key=None, lightweight_options=None):
        self.base = base or os.environ.get("XUENESS_API_BASE", "")
        self.model = model or os.environ.get("XUENESS_MODEL", "")
        self.key = key if key is not None else os.environ.get("XUENESS_API_KEY", "")
        options_record = {
            "runtimeProfile": runtime_profile,
            "toolCalling": tool_calling,
            "compatibility": compatibility if compatibility is not None else {},
            "lightweightOptions": lightweight_options if lightweight_options is not None else {},
        }
        if context_window is not None:
            options_record["contextWindow"] = context_window
        if max_output_tokens is not None:
            options_record["maxOutputTokens"] = max_output_tokens
        options = resolve_runtime_options(options_record)
        self.runtime_profile = options["runtime_profile"]
        self.context_window = options["context_window"]
        self.max_output_tokens = options["max_output_tokens"]
        self.tool_calling = options["tool_calling"]
        self.compatibility = options["compatibility"]
        self.lightweight_options = options["lightweight_options"]

        # Choosing the local runtime profile is an explicit opt-in for a
        # loopback endpoint. Literal-IP validation below still applies.
        if self.runtime_profile == "lightweight":
            if allow_loopback_http is None:
                allow_loopback_http = True
            if allow_empty_key is None:
                allow_empty_key = True
        url = urllib.parse.urlparse(self.base)
        if url.username or url.password or url.query or url.fragment or not url.hostname:
            raise ValueError("XUENESS_API_BASE must be an HTTPS origin/path without credentials or query")
        if url.scheme == "https":
            pass  # default secure path, unchanged
        elif url.scheme == "http":
            if not _loopback_http_enabled(allow_loopback_http):
                raise ValueError("XUENESS_API_BASE HTTP requires explicit loopback opt-in (see README)")
            if not _is_loopback_literal(url.hostname):
                raise ValueError("XUENESS_API_BASE HTTP allows only loopback IP literals (e.g. 127.0.0.1, ::1)")
        else:
            raise ValueError("XUENESS_API_BASE must be an HTTPS origin/path without credentials or query")
        if not self.model:
            raise ValueError("XUENESS_MODEL and XUENESS_API_KEY must be set")
        if not self.key:
            empty_key_opted_in = (allow_empty_key if allow_empty_key is not None
                                  else _loopback_http_enabled(allow_loopback_http))
            if (not empty_key_opted_in or url.scheme not in ("http", "https")
                    or not _is_loopback_literal(url.hostname)):
                raise ValueError("an empty API key is allowed only for an opted-in loopback IP endpoint")
        if reasoning_effort is not None and reasoning_effort not in (
                "none", "minimal", "low", "medium", "high", "xhigh", "max"):
            raise ValueError("unsupported reasoning effort")
        self.reasoning_effort = reasoning_effort
        self.capabilities = _provider_capabilities(self.model, capabilities)

    def complete(self, messages, tools):
        body = build_openai_payload(
            model=self.model, messages=_openai_messages(messages, self), tools=tools,
            runtime_profile=self.runtime_profile, context_window=self.context_window,
            max_output_tokens=self.max_output_tokens, tool_calling=self.tool_calling,
            compatibility=self.compatibility, reasoning_effort=self.reasoning_effort,
            default_max_tokens_field=self._default_max_tokens_field(),
            lightweight_options=self.lightweight_options,
        )
        if self.runtime_profile == "lightweight":
            deadline, attempts = self._lightweight_request_settings()
            return self._request_json(
                body, "/chat/completions", attempts=attempts,
                absolute_deadline=deadline,
            )
        deadline = _explicit_request_deadline(self)
        if deadline is not None:
            return self._request_json(body, "/chat/completions",
                                      absolute_deadline=deadline)
        return self._request_json(body, "/chat/completions")

    def _lightweight_request_settings(self):
        """Resolve the total inference budget and transport retry count.

        ``request_deadline`` is set by the run loop on a shallow provider copy
        and is an absolute monotonic deadline. The per-request setting remains
        useful for direct provider calls, while a shorter run budget always
        wins.
        """
        return _lightweight_request_settings(self)

    def _default_max_tokens_field(self):
        # Current OpenAI reasoning families use max_completion_tokens. Keep
        # that compatibility rule for standard profiles when no override was
        # saved; lightweight profiles default to max_tokens in the shared
        # payload builder.
        from . import providers_api
        return ("max_completion_tokens" if providers_api.known_reasoning_levels(self.model)
                else "max_tokens")

    def test_connection(self, timeout=8):
        """Make one small, bounded chat request for an explicit profile test."""
        from . import providers_api
        body = build_openai_payload(
            model=self.model,
            messages=[{"role": "user", "content": "Reply with exactly OK."}],
            tools=[], runtime_profile=self.runtime_profile,
            context_window=self.context_window, max_output_tokens=self.max_output_tokens,
            tool_calling=self.tool_calling, compatibility=self.compatibility,
            reasoning_effort=self.reasoning_effort, test_connection=True,
            default_max_tokens_field=self._default_max_tokens_field(),
            lightweight_options=self.lightweight_options,
        )
        return self._request_json(
            body, "/chat/completions", timeout=timeout, attempts=1,
            total_timeout=timeout, max_response_bytes=MAX_PROVIDER_RESPONSE_BYTES,
        )

    def compatibility_test(self, mode, compatibility=None, timeout=120):
        """Run one explicit, bounded wire-compatibility diagnostic.

        The fixture tool is an in-process arithmetic example. It never reaches
        the workspace, command runner, or Xueness tool dispatcher. Each mode
        sends at most one model request except the roundtrip modes, which send
        one tool-call request and one result-follow-up request.
        """
        if mode not in COMPATIBILITY_TEST_MODES:
            raise ValueError("unsupported provider compatibility test mode")
        options = validate_compatibility(
            self.compatibility if compatibility is None else compatibility)
        if self.runtime_profile != "lightweight" and mode in ("json_tool_call", "json_tool_roundtrip"):
            raise ValueError("JSON tool-call diagnostics require a lightweight profile")
        if not math.isfinite(float(timeout)) or float(timeout) <= 0:
            raise ValueError("invalid compatibility test timeout")

        deadline = time.monotonic() + min(float(timeout), COMPATIBILITY_TEST_MAX_TIMEOUT_SECONDS)
        request_count = 0
        request_fields = []

        fixture_tool = [{
            "type": "function",
            "function": {
                "name": COMPATIBILITY_FIXTURE_NAME,
                "description": "Test-only deterministic addition. Does not access files or commands.",
                "parameters": {
                    "type": "object",
                    "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                    "required": ["a", "b"],
                    "additionalProperties": False,
                },
            },
        }]

        def build(messages, tool_calling, tools, *, stream=False, test_options=None):
            return build_openai_payload(
                model=self.model, messages=messages, tools=tools,
                runtime_profile=self.runtime_profile, context_window=self.context_window,
                max_output_tokens=min(self.max_output_tokens or COMPATIBILITY_TEST_MAX_OUTPUT_TOKENS,
                                      COMPATIBILITY_TEST_MAX_OUTPUT_TOKENS,
                                      (self.context_window or 8192) // 2), tool_calling=tool_calling,
                compatibility=options if test_options is None else test_options,
                stream=stream, reasoning_effort=self.reasoning_effort,
                test_connection=False,
                default_max_tokens_field=self._default_max_tokens_field(),
                lightweight_options=self.lightweight_options,
            )

        def remaining():
            amount = deadline - time.monotonic()
            if amount <= 0:
                raise TimeoutError("provider compatibility test deadline exceeded")
            return amount

        def request_json(messages, tool_calling, tools, step, *, test_options=None):
            nonlocal request_count
            body = build(messages, tool_calling, tools, test_options=test_options)
            request_count += 1
            request_fields.append({"step": step, "fields": sorted(body)})
            return self._request_json(
                body, "/chat/completions", timeout=remaining(), attempts=1,
                total_timeout=remaining(), max_response_bytes=MAX_PROVIDER_RESPONSE_BYTES,
            )

        def request_stream(messages, tool_calling, tools, step, *, test_options=None):
            nonlocal request_count
            body = build(messages, tool_calling, tools, stream=True, test_options=test_options)
            request_count += 1
            request_fields.append({"step": step, "fields": sorted(body)})
            guard = _SocketDeadlineGuard(deadline)
            deltas = []
            try:
                opener = _deadline_opener(guard, self.base)
                with _open_with_retry(
                        opener, self._request(body, "/chat/completions"), remaining()) as response:
                    content_type = response.headers.get("Content-Type", "")
                    if "text/event-stream" not in content_type.casefold():
                        raise ValueError("The endpoint did not return an SSE event stream.")
                    text, calls, _usage = _read_openai_stream(
                        response, deltas.append, lambda: None, require_done=True)
            finally:
                guard.close()
            return {"content": text, "tool_calls": calls}, {
                "sseContentType": True, "doneReceived": True,
                "deltaCount": len(deltas), "deltaCharacters": len(text),
            }

        def fail(message, *, step=None, status=None):
            return {
                "ok": False,
                "error": message,
                "details": {
                    "mode": mode,
                    "requestCount": request_count,
                    "failedStep": step,
                    "httpStatus": status,
                    "requests": request_fields,
                    "fixture": "in-process arithmetic only; no file or command execution",
                },
            }

        try:
            if mode == "conversation":
                reply = request_json(
                    [{"role": "user", "content": "Reply with exactly COMPAT_OK."}],
                    "plain", [], "conversation")
                content = reply.get("content")
                if not isinstance(content, str) or not content.strip():
                    return fail("The provider returned no assistant text.", step="conversation")
                return {
                    "ok": True,
                    "details": {"mode": mode, "requestCount": request_count,
                                "assistantTextReceived": True, "requests": request_fields},
                }

            if mode == "native_tool_call":
                reply = request_json(_native_fixture_prompt(), "native", fixture_tool,
                                     "native_tool_call")
                call, error = _validated_fixture_tool_call(reply)
                if error:
                    return fail(error, step="native_tool_call")
                return {
                    "ok": True,
                    "details": {"mode": mode, "requestCount": request_count,
                                "toolCallValidated": True, "toolName": COMPATIBILITY_FIXTURE_NAME,
                                "arguments": {"a": 3, "b": 4}, "fixtureExecuted": False,
                                "requests": request_fields},
                }

            if mode == "json_tool_call":
                reply = request_json(_json_fixture_prompt(), "json", [], "json_tool_call")
                error = _validated_fixture_json_call(reply)
                if error:
                    return fail(error, step="json_tool_call")
                return {
                    "ok": True,
                    "details": {"mode": mode, "requestCount": request_count,
                                "jsonToolCallValidated": True,
                                "toolName": COMPATIBILITY_FIXTURE_NAME,
                                "arguments": {"a": 3, "b": 4}, "fixtureExecuted": False,
                                "requests": request_fields},
                }

            if mode == "stream":
                reply, stream_details = request_stream(
                    [{"role": "user", "content": "Reply with exactly STREAM_OK."}],
                    "plain", [], "stream")
                text = reply.get("content")
                deltas = stream_details["deltaCount"]
                if not text or not deltas:
                    return fail("The SSE stream contained no assistant text delta.", step="stream")
                return {
                    "ok": True,
                    "details": {"mode": mode, "requestCount": request_count,
                                **stream_details,
                                "requests": request_fields},
                }

            if mode in ("tool_roundtrip", "json_tool_roundtrip"):
                json_mode = mode == 'json_tool_roundtrip'
                first, first_stream = request_stream(
                    _json_fixture_prompt() if json_mode else _native_fixture_prompt(),
                    'json' if json_mode else 'native', [] if json_mode else fixture_tool,
                    'json_tool_call' if json_mode else 'native_tool_call')
                if json_mode:
                    error = _validated_fixture_json_call(first)
                    if error:
                        return fail(error, step='json_tool_call')
                    from .lightweight import decode_text_response
                    first = decode_text_response(first, fixture_tool)
                call, error = _validated_fixture_tool_call(first)
                if error:
                    return fail(error, step="native_tool_call")
                # This isolated fixture has one fixed input and no side effects.
                fixture_result = {"sum": 3 + 4, "receipt": COMPATIBILITY_FIXTURE_RECEIPT}
                followup_compatibility = {
                    key: value for key, value in options.items()
                    if key != "toolChoice"
                }
                followup_messages = [
                    {"role": "system", "content": (
                        "This is a local compatibility diagnostic. Read the prior tool result "
                        "and reply with exactly its receipt string, with no other text.")},
                    _native_fixture_prompt()[1],
                    {"role": "assistant", "content": None, "tool_calls": [call]},
                    {"role": "tool", "tool_call_id": call["id"],
                     "name": COMPATIBILITY_FIXTURE_NAME,
                     "content": json.dumps(fixture_result, separators=(",", ":"))},
                    {"role": "user", "content": (
                        "Reply with exactly the receipt from the tool result above.")},
                ]
                if json_mode:
                    followup_messages[0]['content'] += (' Reply with only {"answer":"the receipt string","evidence":[]}.')
                    from .lightweight import text_messages
                    followup_messages = text_messages(followup_messages)
                followup, followup_stream = request_stream(
                    followup_messages, 'json' if json_mode else 'native',
                    [] if json_mode else fixture_tool, "tool_result_followup",
                    test_options=followup_compatibility)
                content = followup.get("content")
                if json_mode:
                    decoded = decode_text_response(followup, fixture_tool)
                    if decoded.get('_protocol_error') or decoded.get('tool_calls'):
                        return fail('The provider did not echo the deterministic tool-result receipt.', step='tool_result_followup')
                    content = json.loads(decoded['content']).get('answer')
                followed = isinstance(content, str) and content.strip() == COMPATIBILITY_FIXTURE_RECEIPT
                if not followed:
                    return fail("The provider did not echo the deterministic tool-result receipt.",
                                step="tool_result_followup")
                return {
                    "ok": True,
                    "details": {"mode": mode, "requestCount": request_count,
                                "toolCallValidated": True, "toolResultFollowupValidated": True,
                                **({'jsonToolCallValidated': True} if json_mode else {}),
                                "toolName": COMPATIBILITY_FIXTURE_NAME,
                                "arguments": {"a": 3, "b": 4}, "fixtureExecuted": True,
                                "sseContentType": first_stream["sseContentType"] and followup_stream["sseContentType"],
                                "doneReceived": first_stream["doneReceived"] and followup_stream["doneReceived"],
                                "deltaCount": first_stream["deltaCount"] + followup_stream["deltaCount"],
                                "deltaCharacters": first_stream["deltaCharacters"] + followup_stream["deltaCharacters"],
                                "requests": request_fields},
                }
        except Exception as exc:
            status = getattr(exc, "status", None)
            if isinstance(exc, _RetryableProviderError):
                status = exc.status
            message = ("The endpoint rejected one or more request fields (HTTP 400). "
                       "Change compatibility options explicitly and rerun this check."
                       if status == 400 else
                       "The provider compatibility request failed (details suppressed).")
            return fail(message, step=(request_fields[-1]["step"] if request_fields else None),
                        status=status)

        return fail("Unsupported provider compatibility test mode.")

    def discover_models(self, timeout=MODEL_DISCOVERY_MAX_TIMEOUT_SECONDS):
        """List explicit model IDs from this OpenAI-compatible endpoint.

        This is a bounded, read-only GET. It reuses the inference transport's
        absolute deadline, redirect rejection, and loopback proxy bypass, but
        does not send a chat request or infer model capabilities.
        """
        if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                or not math.isfinite(float(timeout)) or float(timeout) <= 0):
            raise ValueError("invalid model discovery timeout")
        budget = min(float(timeout), MODEL_DISCOVERY_MAX_TIMEOUT_SECONDS)
        deadline = time.monotonic() + budget
        guard = _SocketDeadlineGuard(deadline)
        try:
            headers = {"Accept": "application/json"}
            if self.key:
                headers["Authorization"] = "Bearer " + self.key
            request = urllib.request.Request(
                self.base.rstrip("/") + "/models", headers=headers, method="GET")
            opener = _deadline_opener(guard, self.base)
            with opener.open(request, timeout=budget) as response:
                payload = _read_response_with_deadline(
                    response, deadline=deadline,
                    max_bytes=MAX_MODEL_LIST_RESPONSE_BYTES,
                )
            parsed = json.loads(payload)
            return _validated_model_list(parsed, self.key)
        except Exception:
            # Do not include provider bodies, URLs, or exception strings; any
            # of them may contain an echoed credential or other remote data.
            raise RuntimeError("provider model discovery failed (details suppressed)") from None
        finally:
            guard.close()

    def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
        """Stream assistant text and assemble calls into a complete() result.

        Retries are bounded and may happen only before public output. Once a
        text delta has been delivered, a broken stream fails closed so callers
        never see duplicated prefixes from a transparent replay.
        """
        body = build_openai_payload(
            model=self.model, messages=_openai_messages(messages, self), tools=tools,
            runtime_profile=self.runtime_profile, context_window=self.context_window,
            max_output_tokens=self.max_output_tokens, tool_calling=self.tool_calling,
            compatibility=self.compatibility, stream=True,
            reasoning_effort=self.reasoning_effort,
            default_max_tokens_field=self._default_max_tokens_field(),
            lightweight_options=self.lightweight_options,
        )
        if self.runtime_profile == "lightweight":
            deadline, attempts = self._lightweight_request_settings()
            return self._stream_lightweight(
                body, deadline=deadline, attempts=attempts,
                on_delta=on_delta, on_reasoning_delta=on_reasoning_delta,
            )
        deadline = _explicit_request_deadline(self)
        if deadline is not None:
            return self._stream_lightweight(
                body, deadline=deadline, attempts=3,
                on_delta=on_delta, on_reasoning_delta=on_reasoning_delta,
            )
        delivered = False
        attempts = 0
        def mark_delivered():
            nonlocal delivered
            delivered = True
        while True:
            attempts += 1
            try:
                request = self._request(body, "/chat/completions")
                opener = _provider_opener(self.base, _NoRedirect)
                with _open_with_retry(opener, request, 40, lambda: delivered) as response:
                    content_type = response.headers.get("Content-Type", "")
                    if "text/event-stream" not in content_type.casefold():
                        raw = cancel_watch.read(response, 2_000_001)
                        if len(raw) > 2_000_000:
                            raise ValueError("provider response too large")
                        payload = json.loads(raw)
                        return _with_request_attempts(
                            _with_reported_usage(payload["choices"][0]["message"], payload),
                            attempts,
                        )
                    metadata = {}
                    text, calls, usage = _read_openai_stream(
                        response, on_delta, mark_delivered, on_reasoning_delta,
                        finish_metadata=metadata)
                result = {"content": text, "tool_calls": calls, **metadata}
                if usage:
                    result["_usage"] = usage
                return _with_request_attempts(result, attempts)
            except ProviderCallbackError:
                raise
            except _RetryableProviderError as exc:
                cancel_watch.raise_if_active()
                delivered = delivered or exc.delivered
                if delivered or attempts >= 3 or not exc.retryable:
                    raise _provider_request_error(
                        exc, status=exc.status, retry_after=exc.delay,
                        context_overflow=exc.context_overflow, stage="response",
                    ) from None
                time.sleep(exc.delay)
            except (urllib.error.URLError, OSError) as exc:
                cancel_watch.raise_if_active()
                if delivered or attempts >= 3:
                    raise _provider_request_error(exc, stage="read") from None
                time.sleep(min(0.25 * (2 ** (attempts - 1)), 2.0))
            except (http.client.HTTPException, ValueError, KeyError, IndexError,
                    TypeError, AttributeError) as exc:
                cancel_watch.raise_if_active()
                # A malformed HTTP/SSE response is a protocol error, not a
                # transport failure. It must not be retried or reported as a
                # connection problem.
                raise _provider_request_error(exc, stage="parse") from None

    def _stream_lightweight(self, body, *, deadline, attempts, on_delta=None,
                            on_reasoning_delta=None):
        """Stream within one deadline shared by headers, body, and retries."""
        guard = _SocketDeadlineGuard(deadline)
        opener = _deadline_opener(guard, self.base)
        delivered = False

        def mark_delivered():
            nonlocal delivered
            delivered = True

        try:
            for attempt in range(attempts):
                try:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("provider request deadline exceeded")
                    request = self._request(body, "/chat/completions")
                    with _open_with_retry(
                            opener, request, remaining,
                            lambda: delivered) as response:
                        content_type = response.headers.get("Content-Type", "")
                        if "text/event-stream" not in content_type.casefold():
                            raw = _read_response_with_deadline(
                                response, deadline=deadline,
                                max_bytes=MAX_PROVIDER_RESPONSE_BYTES,
                            )
                            payload = json.loads(raw)
                            return _with_request_attempts(
                                _with_reported_usage(
                                    payload["choices"][0]["message"], payload),
                                attempt + 1,
                            )
                        metadata = {}
                        text, calls, usage = _read_openai_stream(
                            response, on_delta, mark_delivered,
                            on_reasoning_delta, finish_metadata=metadata)
                    result = {"content": text, "tool_calls": calls, **metadata}
                    if usage:
                        result["_usage"] = usage
                    return _with_request_attempts(result, attempt + 1)
                except ProviderCallbackError:
                    raise
                except _RetryableProviderError as exc:
                    cancel_watch.raise_if_active()
                    delivered = delivered or exc.delivered
                    if delivered or attempt == attempts - 1 or not exc.retryable:
                        raise _provider_request_error(
                            exc, status=exc.status, retry_after=exc.delay,
                            context_overflow=exc.context_overflow, stage="response",
                        ) from None
                    _sleep_with_deadline(exc.delay, deadline)
                except (urllib.error.URLError, OSError) as exc:
                    cancel_watch.raise_if_active()
                    if time.monotonic() >= deadline:
                        raise ProviderRequestError(
                            category="timeout", stage="deadline",
                            exception_type=type(exc).__name__,
                        ) from None
                    if delivered or attempt == attempts - 1:
                        raise _provider_request_error(exc, stage="read") from None
                    _sleep_with_deadline(min(0.25 * (2 ** attempt), 2.0), deadline)
                except (http.client.HTTPException, ValueError, KeyError, IndexError,
                        TypeError, AttributeError) as exc:
                    cancel_watch.raise_if_active()
                    _raise_if_deadline_expired(deadline)
                    # transportRetries cover network failures only. A malformed
                    # response has already reached the client and is not replayed.
                    raise _provider_request_error(exc, stage="parse") from None
        except TimeoutError as exc:
            raise ProviderRequestError(
                category="timeout", stage="deadline",
                exception_type=type(exc).__name__,
            ) from None
        finally:
            # The timer's callback may be shutting down a socket. Join it before
            # returning so the request cannot leave a watchdog thread behind.
            guard.close()
        raise RuntimeError("provider request failed (details suppressed)") from None

    def _request(self, body, endpoint):
        headers = {"Content-Type": "application/json"}
        if self.key:
            headers["Authorization"] = "Bearer " + self.key
        req = urllib.request.Request(self.base.rstrip("/") + endpoint,
                                     data=json.dumps(body).encode(), headers=headers)
        return req

    def _request_json(self, body, endpoint, *, timeout=40, attempts=3,
                      total_timeout=None, absolute_deadline=None,
                      max_response_bytes=MAX_PROVIDER_RESPONSE_BYTES):
        deadline = (time.monotonic() + total_timeout
                    if total_timeout is not None else absolute_deadline)
        if absolute_deadline is not None:
            deadline = (min(deadline, absolute_deadline)
                        if deadline is not None else absolute_deadline)
        guard = _SocketDeadlineGuard(deadline) if deadline is not None else None
        opener = (_deadline_opener(guard, self.base) if guard is not None
                  else _provider_opener(self.base, _NoRedirect))
        last_http_error = None
        last_transport_error = None
        try:
            for attempt in range(attempts):
                try:
                    open_timeout = timeout
                    if deadline is not None:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError("provider request deadline exceeded")
                        open_timeout = min(timeout, remaining)
                    with _open_with_retry(opener, self._request(body, endpoint), open_timeout) as response:
                        if deadline is None:
                            payload = cancel_watch.read(response, max_response_bytes + 1)
                        else:
                            payload = _read_response_with_deadline(
                                response, deadline=deadline,
                                max_bytes=max_response_bytes,
                            )
                        if len(payload) > max_response_bytes:
                            raise ValueError("provider response too large")
                    parsed = json.loads(payload)
                    return _with_request_attempts(
                        _with_reported_usage(parsed["choices"][0]["message"], parsed),
                        attempt + 1,
                    )
                except _RetryableProviderError as exc:
                    cancel_watch.raise_if_active()
                    last_http_error = exc
                    _raise_if_deadline_expired(deadline)
                    if attempt == attempts - 1 or not exc.retryable:
                        break
                    _sleep_with_deadline(exc.delay, deadline)
                except (urllib.error.URLError, OSError) as exc:
                    cancel_watch.raise_if_active()
                    last_transport_error = exc
                    _raise_if_deadline_expired(deadline)
                    if attempt == attempts - 1:
                        break
                    _sleep_with_deadline(min(0.25 * (2 ** attempt), 2.0), deadline)
                except (http.client.HTTPException, ValueError, KeyError, IndexError,
                        TypeError, AttributeError) as exc:
                    cancel_watch.raise_if_active()
                    _raise_if_deadline_expired(deadline)
                    # A complete response with invalid JSON/shape is not a
                    # transport interruption. Do not repeat a potentially
                    # billable request just to classify the same bad payload.
                    raise _provider_request_error(exc, stage="parse") from None
        except TimeoutError as exc:
            raise ProviderRequestError(
                category="timeout", stage="deadline",
                exception_type=type(exc).__name__,
            ) from None
        finally:
            if guard is not None:
                guard.close()
        # Never include remote bodies, URLs or exception strings; they may contain credentials.
        if last_http_error is not None:
            raise ProviderRequestError(
                last_http_error.status, last_http_error.delay,
                context_overflow=last_http_error.context_overflow,
                category=_http_error_category(last_http_error.status),
                stage="response", exception_type=type(last_http_error).__name__,
            ) from None
        if last_transport_error is not None:
            if deadline is not None and time.monotonic() >= deadline:
                raise ProviderRequestError(
                    category="timeout", stage="deadline",
                    exception_type=type(last_transport_error).__name__,
                ) from None
            raise _provider_request_error(last_transport_error, stage="read") from None
        raise ProviderRequestError(category="invalid_response", stage="parse") from None


def _validated_model_list(payload, api_key):
    """Return a small allowlist from a standard OpenAI-compatible model list."""
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("invalid model list response")
    entries = payload["data"]
    if len(entries) > MAX_DISCOVERED_MODELS:
        raise ValueError("model list exceeds item limit")
    seen = set()
    result = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("invalid model list entry")
        model_id = entry.get("id")
        if (not isinstance(model_id, str) or not model_id or model_id != model_id.strip()
                or len(model_id) > MAX_DISCOVERED_MODEL_ID_CHARS
                or any(ord(char) < 32 or ord(char) == 127 for char in model_id)):
            raise ValueError("invalid model identifier")
        if model_id in seen:
            raise ValueError("duplicate model identifier")
        if api_key and api_key in model_id:
            raise ValueError("model list contains a credential")
        seen.add(model_id)
        item = {"id": model_id}

        created = entry.get("created")
        if (isinstance(created, int) and not isinstance(created, bool)
                and 0 <= created <= 9_007_199_254_740_991):
            item["created"] = created
        owner = entry.get("owned_by")
        if (isinstance(owner, str) and owner and owner == owner.strip()
                and len(owner) <= MAX_MODEL_OWNER_CHARS
                and not any(ord(char) < 32 or ord(char) == 127 for char in owner)
                and not (api_key and api_key in owner)):
            item["ownedBy"] = owner
        result.append(item)
    return result


class _RetryableProviderError(Exception):
    def __init__(self, *, retryable, delay=0.25, delivered=False, status=None,
                 context_overflow=False):
        super().__init__("provider request failed")
        self.retryable = retryable
        self.delay = delay
        self.delivered = delivered
        self.status = status
        self.context_overflow = bool(context_overflow)


def _retry_after(headers):
    """Parse Retry-After safely and cap server-directed sleeps at two seconds."""
    raw = headers.get("Retry-After") if headers else None
    delay = None
    if raw:
        try:
            delay = float(raw)
        except (TypeError, ValueError):
            try:
                when = email.utils.parsedate_to_datetime(raw)
                delay = when.timestamp() - time.time()
            except (TypeError, ValueError, OverflowError):
                delay = None
    if delay is None:
        delay = 0.25
    return max(0.0, min(delay, 2.0))


def _raise_if_deadline_expired(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError("provider request deadline exceeded") from None


def _sleep_with_deadline(delay, deadline):
    """Keep retry backoff inside an optional absolute request deadline."""
    if deadline is None:
        time.sleep(delay)
        return
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("provider request deadline exceeded") from None
    time.sleep(min(max(0.0, delay), remaining))
    _raise_if_deadline_expired(deadline)


def _open_with_retry(opener, request, timeout, delivered=lambda: False):
    """Open one streaming attempt; classify only transient status codes."""
    try:
        return opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        context_overflow = _context_overflow_from_http_error(exc)
        try:
            retryable = exc.code == 429 or 500 <= exc.code <= 599
            delay = _retry_after(exc.headers)
        finally:
            exc.close()
        raise _RetryableProviderError(retryable=retryable, delay=delay,
                                      delivered=delivered(), status=exc.code,
                                      context_overflow=context_overflow) from None


_CONTEXT_OVERFLOW_CODES = frozenset({
    "context_length_exceeded", "context_window_exceeded", "prompt_too_long",
})


def _context_overflow_from_http_error(error):
    """Inspect only a small 400/413 JSON error body for known context codes."""
    if getattr(error, "code", None) not in (400, 413):
        return False
    raw = b""
    sock = _response_socket(error)
    try:
        if sock is not None:
            # Do not let diagnostic parsing delay a failed model call. The
            # response body is never returned or logged, and one short read is
            # enough for the small structured error envelope providers use.
            sock.settimeout(0.25)
        reader = getattr(error, "read1", None)
        if callable(reader):
            raw = reader(8193)
        else:
            raw = error.read(8193)
        if len(raw) > 8192:
            return False
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            return False
        details = payload.get("error")
        if not isinstance(details, dict):
            return False
        return any(details.get(key) in _CONTEXT_OVERFLOW_CODES for key in ("code", "type"))
    except (http.client.HTTPException, OSError, ValueError, TypeError, AttributeError):
        return False


def _response_socket(response):
    """Return urllib's underlying connected socket for deadline-aware reads."""
    current = response
    for _ in range(4):
        sock = getattr(current, "_sock", None)
        if sock is not None:
            return sock
        current = getattr(current, "fp", None) or getattr(current, "raw", None)
        if current is None:
            break
    return None


def _read_response_with_deadline(response, *, deadline, max_bytes):
    """Read incrementally, bounding total time and response bytes.

    ``socket.settimeout`` applies to each blocking socket operation. Replacing
    it with the remaining absolute deadline before every ``read1`` prevents a
    slow peer from extending an eight-second request indefinitely by trickling
    bytes. The read stays in this request thread; closing the response on any
    error closes the socket without leaving a worker behind.
    """
    sock = _response_socket(response)
    reader = getattr(response, "read1", None)
    if sock is None or not callable(reader):
        raise RuntimeError("provider response does not support bounded reads")
    chunks = []
    size = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("provider request deadline exceeded")
        # urllib/http.client may already have detached the socket after a
        # peer's Connection: close response. In that case any remaining bytes
        # are in BufferedReader and reads cannot wait on the network; let the
        # buffered reader drain them. A live socket still gets the strict
        # remaining-deadline timeout before every read.
        if not getattr(sock, "_closed", False):
            sock.settimeout(remaining)
        chunk = cancel_watch.read1(response, reader, min(65_536, max_bytes + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if size > max_bytes:
            raise ValueError("provider response too large")
        if time.monotonic() >= deadline:
            raise TimeoutError("provider request deadline exceeded")
    if time.monotonic() > deadline:
        raise TimeoutError("provider request deadline exceeded")
    return b"".join(chunks)


def _read_sse(response):
    """Yield each bounded SSE data payload, ignoring comments and other fields."""
    data = []
    total = 0
    while True:
        line = cancel_watch.readline(response, 262145)
        if len(line) > 262144:
            raise ValueError("provider stream line too large")
        if not line:
            if data:
                yield "\n".join(data)
            return
        total += len(line)
        if total > 8_000_000:
            raise ValueError("provider stream too large")
        line = line.decode("utf-8", "strict").rstrip("\r\n")
        if line == "":
            if data:
                yield "\n".join(data)
                data = []
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())


def _read_openai_stream(response, on_delta, mark_delivered, on_reasoning_delta=None,
                        require_done=False, finish_metadata=None):
    from .response_metadata import reported_usage, finish_reason
    text_parts = []
    calls = NativeCallAssembler()
    finished = False
    done_marker = False
    usage = None
    for payload in _read_sse(response):
        if payload == "[DONE]":
            finished = True
            done_marker = True
            break
        item = json.loads(payload)
        if not isinstance(item, dict):
            raise ValueError('provider SSE event must be an object')
        raw_usage = item.get("usage")
        if isinstance(raw_usage, dict):
            usage = {**(usage or {}), **reported_usage(raw_usage)}
        choices = item.get("choices") or []
        if not isinstance(choices, list):
            raise ValueError('provider SSE choices must be a list')
        if not choices:
            continue
        if not isinstance(choices[0], dict):
            raise ValueError('invalid provider SSE choice')
        delta = choices[0].get("delta") or {}
        if not isinstance(delta, dict):
            raise ValueError('provider SSE delta must be an object')
        if finished and any(delta.get(key) for key in ('content', 'tool_calls', 'reasoning_content', 'reasoning', 'thinking')):
            raise ValueError('provider SSE payload after completion')
        if choices[0].get("finish_reason") is not None:
            finished = True
            if finish_metadata is not None:
                finish_metadata['_finish_reason'] = finish_reason(choices[0]['finish_reason'])
        # Compatible APIs expose reasoning under different names. Keep it out
        # of assistant content and only forward it through the opt-in observer;
        # callers that do not request reasoning retain the previous behavior.
        for key in ("reasoning_content", "reasoning", "thinking"):
            reasoning = delta.get(key)
            if isinstance(reasoning, str) and reasoning and on_reasoning_delta:
                mark_delivered()
                _notify_stream_callback(on_reasoning_delta, reasoning)
        content = delta.get("content")
        if isinstance(content, str) and content:
            text_parts.append(content)
            mark_delivered()
            if on_delta:
                _notify_stream_callback(on_delta, content)
        if delta.get('tool_calls') is not None:
            calls.add(delta['tool_calls'])
    if not finished:
        raise ConnectionError("incomplete provider stream")
    if require_done and not done_marker:
        raise ConnectionError("provider stream ended without the required done marker")
    return "".join(text_parts), calls.finish(), usage


_MULTIMODAL_MARKER = "\n\nXUENESS_MULTIMODAL_V1:"
_SUPPORTED_IMAGES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})
_SUPPORTED_CAPABILITIES = frozenset({"image", "pdf", "video"})


def _provider_capabilities(model, configured):
    if configured is not None:
        return frozenset(configured)
    name = (model or "").casefold()
    if name.startswith(("gpt-4o", "gpt-4.1", "gpt-4.5", "gpt-5", "o1", "o3", "o4")):
        return frozenset({"image", "video"})
    return frozenset()


def _split_multimodal(content):
    if not isinstance(content, str) or _MULTIMODAL_MARKER not in content:
        return (content if isinstance(content, str) else ""), []
    text, _, raw = content.rpartition(_MULTIMODAL_MARKER)
    if len(raw) > 6_000_000:
        raise ValueError("multimodal attachment payload too large")
    try:
        items = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError("malformed multimodal attachment payload") from None
    if not isinstance(items, list) or len(items) > 4:
        raise ValueError("invalid multimodal attachment list")
    total_bytes = 0
    for item in items:
        if not isinstance(item, dict) or item.get("mimeType") not in _SUPPORTED_IMAGES | {"application/pdf", "video/mp4", "video/quicktime", "video/webm"}:
            raise ValueError("unsupported multimodal attachment")
        mime = item["mimeType"]
        value = item.get("data")
        raw_data = None
        if value is not None:
            try:
                raw_data = base64.b64decode(value, validate=True)
            except (ValueError, TypeError):
                raise ValueError("malformed multimodal attachment data") from None
            if len(raw_data) > 2 * 1024 * 1024:
                raise ValueError("multimodal attachment data exceeds per-file limit")
            total_bytes += len(raw_data)
        if mime.startswith("video/"):
            if raw_data is not None:
                raise ValueError("video attachment must contain extracted frames, not raw video")
        elif raw_data is None or not _valid_media_signature(raw_data, mime):
            raise ValueError("multimodal attachment data is missing or does not match its MIME type")
        frames = item.get("framesData", [])
        if not isinstance(frames, list) or len(frames) > 6 or (frames and not mime.startswith("video/")):
            raise ValueError("invalid video frame list")
        for frame in frames:
            try:
                raw_frame = base64.b64decode(frame, validate=True)
            except (ValueError, TypeError):
                raise ValueError("malformed video frame data") from None
            if not raw_frame.startswith(b"\xff\xd8\xff") or len(raw_frame) > 2 * 1024 * 1024:
                raise ValueError("invalid video frame data")
            total_bytes += len(raw_frame)
        if mime.startswith("video/") and not frames:
            raise ValueError("video attachment contains no extracted frames")
        if total_bytes > 16 * 1024 * 1024:
            raise ValueError("multimodal attachment set exceeds total size limit")
    return text, items


def _valid_media_signature(data, mime):
    if mime == "application/pdf":
        return data.startswith(b"%PDF-")
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime == "image/gif":
        return data.startswith((b"GIF87a", b"GIF89a"))
    if mime == "image/webp":
        return data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    return False


def _openai_messages(messages, provider):
    converted = []
    for message in messages:
        item = dict(message)
        if item.get("role") == "user":
            text, attachments = _split_multimodal(item.get("content") or "")
            if attachments:
                content = []
                if text:
                    content.append({"type": "text", "text": text})
                for attachment in attachments:
                    mime = attachment["mimeType"]
                    if mime == "application/pdf":
                        raise ValueError("OpenAI-compatible chat completions cannot accept PDF documents; select Anthropic or attach extracted text/images")
                    if mime.startswith("video/"):
                        if "video" not in provider.capabilities or not attachment.get("framesData"):
                            raise ValueError("selected model does not declare video-frame input support")
                        image_data = attachment["framesData"]
                    else:
                        if mime not in _SUPPORTED_IMAGES or "image" not in provider.capabilities:
                            raise ValueError("selected model does not declare image input support")
                        image_data = [attachment.get("data", "")]
                    for encoded in image_data:
                        content.append({"type": "image_url", "image_url": {
                            "url": f"data:image/jpeg;base64,{encoded}" if mime.startswith("video/")
                            else f"data:{mime};base64,{encoded}"}})
                item["content"] = content
        converted.append(item)
    return converted


def _to_anthropic_messages(messages, provider):
    """Translate the harness journal's OpenAI-style messages into Messages API."""
    system = []
    converted = []

    def append(role, content):
        if converted and converted[-1]["role"] == role:
            converted[-1]["content"].extend(content)
        else:
            converted.append({"role": role, "content": list(content)})

    for message in messages:
        role = message.get("role")
        content = message.get("content") or ""
        if role == "system":
            if content:
                system.append(str(content))
            continue
        if role == "assistant":
            blocks = []
            if content:
                blocks.append({"type": "text", "text": str(content)})
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                try:
                    arguments = json.loads(function.get("arguments") or "{}")
                except (TypeError, ValueError):
                    arguments = {}
                if not isinstance(arguments, dict):
                    arguments = {}
                blocks.append({"type": "tool_use", "id": call.get("id", ""),
                               "name": function.get("name", ""), "input": arguments})
            if blocks:
                append("assistant", blocks)
        elif role == "tool":
            append("user", [{"type": "tool_result",
                             "tool_use_id": message.get("tool_call_id", ""),
                             "content": str(content)}])
        elif role in ("user", "developer"):
            text, attachments = _split_multimodal(str(content))
            blocks = [{"type": "text", "text": text}] if text else []
            for attachment in attachments:
                mime = attachment["mimeType"]
                if mime.startswith("image/"):
                    if mime not in _SUPPORTED_IMAGES or "image" not in provider.capabilities:
                        raise ValueError("selected model does not declare image input support")
                    blocks.append({"type": "image", "source": {"type": "base64",
                                   "media_type": mime, "data": attachment.get("data", "")}})
                elif mime == "application/pdf":
                    if "pdf" not in provider.capabilities:
                        raise ValueError("selected model does not declare PDF input support")
                    blocks.append({"type": "document", "source": {"type": "base64",
                                   "media_type": mime, "data": attachment.get("data", "")}})
                elif mime.startswith("video/"):
                    if "video" not in provider.capabilities or not attachment.get("framesData"):
                        raise ValueError("selected model does not declare video-frame input support")
                    blocks.extend({"type": "image", "source": {"type": "base64",
                                   "media_type": "image/jpeg", "data": frame}}
                                  for frame in attachment["framesData"])
            if blocks:
                append("user", blocks)
    return "\n\n".join(system), converted


def _anthropic_message(payload):
    blocks = payload.get("content") or []
    text = []
    calls = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text.append(block.get("text") or "")
        elif block.get("type") == "tool_use":
            calls.append({"id": block.get("id", ""), "type": "function",
                          "function": {"name": block.get("name", ""),
                                       "arguments": json.dumps(block.get("input") or {}, ensure_ascii=False,
                                                              separators=(",", ":"))}})
    return _with_reported_usage({"content": "".join(text), "tool_calls": calls}, payload)


def _read_anthropic_stream(response, on_delta, mark_delivered, on_reasoning_delta=None,
                           finish_metadata=None):
    from .response_metadata import reported_usage, finish_reason
    text_parts = []
    blocks = {}
    stopped = False
    usage = {}
    for payload in _read_sse(response):
        event = json.loads(payload)
        kind = event.get("type")
        if kind == "message_start":
            raw_usage = ((event.get("message") or {}).get("usage") or {})
            usage.update(reported_usage(raw_usage))
        elif kind == "message_delta":
            raw_usage = event.get("usage") or {}
            usage.update(reported_usage(raw_usage))
            reason = finish_reason((event.get('delta') or {}).get('stop_reason'))
            if reason is not None and finish_metadata is not None:
                finish_metadata['_finish_reason'] = reason
        if kind == "content_block_start":
            index = event.get("index", 0)
            block = event.get("content_block") or {}
            if block.get("type") == "tool_use":
                blocks[index] = {"type": "tool_use", "id": block.get("id", ""),
                                 "name": block.get("name", ""),
                                 "input": block.get("input") or {}, "json": ""}
            elif block.get("type") in ("thinking", "reasoning"):
                blocks[index] = {"type": "reasoning"}
                initial = block.get("thinking", block.get("text", ""))
                if isinstance(initial, str) and initial and on_reasoning_delta:
                    mark_delivered()
                    _notify_stream_callback(on_reasoning_delta, initial)
            else:
                blocks[index] = {"type": "text", "text": block.get("text", "")}
        elif kind == "content_block_delta":
            index = event.get("index", 0)
            delta = event.get("delta") or {}
            block = blocks.setdefault(index, {"type": "text", "text": ""})
            if delta.get("type") == "text_delta":
                value = delta.get("text") or ""
                block["text"] = block.get("text", "") + value
                text_parts.append(value)
                if value:
                    mark_delivered()
                    if on_delta:
                        _notify_stream_callback(on_delta, value)
            elif delta.get("type") in ("thinking_delta", "reasoning_delta"):
                value = delta.get("thinking", delta.get("reasoning", delta.get("text", "")))
                if isinstance(value, str) and value and on_reasoning_delta:
                    mark_delivered()
                    _notify_stream_callback(on_reasoning_delta, value)
            elif delta.get("type") == "input_json_delta":
                block["json"] = block.get("json", "") + (delta.get("partial_json") or "")
        elif kind == "message_stop":
            stopped = True
            break
    if not stopped:
        raise ConnectionError("incomplete provider stream")
    calls = []
    for index in sorted(blocks):
        block = blocks[index]
        if block.get("type") != "tool_use":
            continue
        if block.get("json"):
            try:
                args = json.loads(block["json"])
            except ValueError:
                if (finish_metadata or {}).get('_finish_reason') not in (None, 'stop', 'tool_calls'):
                    # A cut-off argument is not a protocol repair opportunity.
                    # Retain the termination and text; the host pauses without
                    # persisting any executable intent from this response.
                    continue
                raise ValueError("malformed streamed tool input") from None
        else:
            args = block.get("input") or {}
        calls.append({"id": block.get("id", ""), "type": "function",
                      "function": {"name": block.get("name", ""),
                                   "arguments": json.dumps(args, ensure_ascii=False,
                                                            separators=(",", ":"))}})
    if "prompt_tokens" in usage and "completion_tokens" in usage:
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
    return "".join(text_parts), calls, usage


class AnthropicMessages:
    """Native Anthropic Messages API adapter with normalized tool-call output."""

    def __init__(self, base=None, model=None, key=None, allow_loopback_http=None,
                 max_tokens=4096, capabilities=None):
        self.base = base or os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1")
        self.model = model or os.environ.get("XUENESS_MODEL", "")
        self.key = key if key is not None else os.environ.get("ANTHROPIC_API_KEY", os.environ.get("XUENESS_API_KEY", ""))
        self.max_tokens = max_tokens
        url = urllib.parse.urlparse(self.base)
        if url.username or url.password or url.query or url.fragment or not url.hostname:
            raise ValueError("Anthropic base URL must be an HTTPS origin/path without credentials or query")
        if url.scheme == "http":
            if not _loopback_http_enabled(allow_loopback_http) or not _is_loopback_literal(url.hostname):
                raise ValueError("Anthropic HTTP requires explicit loopback IP opt-in")
        elif url.scheme != "https":
            raise ValueError("Anthropic base URL must use HTTPS")
        if not self.model or not self.key:
            raise ValueError("ANTHROPIC_API_KEY and XUENESS_MODEL must be set")
        allowed = {"image", "pdf", "video"}
        self.capabilities = allowed if capabilities is None else allowed.intersection(capabilities)

    def _request(self, messages, tools, stream, *, max_tokens=None):
        system, converted = _to_anthropic_messages(messages, self)
        body = {"model": self.model, "max_tokens": self.max_tokens if max_tokens is None else max_tokens,
                "messages": converted, "stream": stream}
        if system:
            body["system"] = system
        if tools:
            body["tools"] = [{"name": tool["function"]["name"],
                              "description": tool["function"].get("description", ""),
                              "input_schema": tool["function"].get("parameters", {"type": "object", "properties": {}})}
                             for tool in tools]
        request = urllib.request.Request(self.base.rstrip("/") + "/messages",
                                         data=json.dumps(body).encode(),
                                         headers={"x-api-key": self.key,
                                                  "anthropic-version": "2023-06-01",
                                                  "Content-Type": "application/json"})
        return request

    def complete(self, messages, tools):
        if getattr(self, "runtime_profile", "standard") == "lightweight":
            try:
                request = self._request(messages, tools, False)
                deadline, attempts = _lightweight_request_settings(self)
                return self._complete_lightweight(request, deadline, attempts)
            except ProviderRequestError:
                raise
            except TimeoutError as exc:
                raise ProviderRequestError(
                    category="timeout", stage="deadline",
                    exception_type=type(exc).__name__,
                ) from None
            except urllib.error.HTTPError as exc:
                context_overflow = _context_overflow_from_http_error(exc)
                status = exc.code
                delay = _retry_after(exc.headers)
                exc.close()
                raise _provider_request_error(
                    exc, status=status, retry_after=delay,
                    context_overflow=context_overflow, stage="response",
                ) from None
            except (urllib.error.URLError, OSError) as exc:
                cancel_watch.raise_if_active()
                raise _provider_request_error(exc, stage="read") from None
            except (http.client.HTTPException, ValueError, KeyError, IndexError,
                    TypeError, AttributeError) as exc:
                cancel_watch.raise_if_active()
                raise _provider_request_error(exc, stage="parse") from None
        deadline = _explicit_request_deadline(self)
        if deadline is not None:
            request = self._request(messages, tools, False)
            return self._complete_lightweight(request, deadline, attempts=1)
        try:
            with _provider_opener(self.base, _NoRedirect).open(self._request(messages, tools, False), timeout=40) as response:
                raw = cancel_watch.read(response, 2_000_001)
                if len(raw) > 2_000_000:
                    raise ValueError("provider response too large")
            return _with_request_attempts(_anthropic_message(json.loads(raw)), 1)
        except urllib.error.HTTPError as exc:
            context_overflow = _context_overflow_from_http_error(exc)
            status = exc.code
            delay = _retry_after(exc.headers)
            exc.close()
            raise _provider_request_error(
                exc, status=status, retry_after=delay,
                context_overflow=context_overflow, stage="response",
            ) from None
        except (urllib.error.URLError, OSError) as exc:
            cancel_watch.raise_if_active()
            raise _provider_request_error(exc, stage="read") from None
        except (http.client.HTTPException, ValueError, KeyError, IndexError,
                TypeError, AttributeError) as exc:
            cancel_watch.raise_if_active()
            raise _provider_request_error(exc, stage="parse") from None

    def _complete_lightweight(self, request, deadline, attempts):
        guard = _SocketDeadlineGuard(deadline)
        opener = _deadline_opener(guard, self.base)
        last_http_error = None
        last_transport_error = None
        try:
            for attempt in range(attempts):
                try:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("provider request deadline exceeded")
                    with _open_with_retry(opener, request, remaining) as response:
                        raw = _read_response_with_deadline(
                            response, deadline=deadline,
                            max_bytes=MAX_PROVIDER_RESPONSE_BYTES,
                        )
                    return _with_request_attempts(_anthropic_message(json.loads(raw)), attempt + 1)
                except _RetryableProviderError as exc:
                    cancel_watch.raise_if_active()
                    last_http_error = exc
                    _raise_if_deadline_expired(deadline)
                    if attempt == attempts - 1 or not exc.retryable:
                        break
                    _sleep_with_deadline(exc.delay, deadline)
                except (urllib.error.URLError, OSError) as exc:
                    cancel_watch.raise_if_active()
                    last_transport_error = exc
                    _raise_if_deadline_expired(deadline)
                    if attempt == attempts - 1:
                        break
                    _sleep_with_deadline(min(0.25 * (2 ** attempt), 2.0), deadline)
                except (http.client.HTTPException, ValueError, KeyError, IndexError,
                        TypeError, AttributeError) as exc:
                    cancel_watch.raise_if_active()
                    _raise_if_deadline_expired(deadline)
                    # Once response bytes arrive, a malformed response is not
                    # a transport failure and must not be replayed.
                    raise _provider_request_error(exc, stage="parse") from None
        except TimeoutError as exc:
            raise ProviderRequestError(
                category="timeout", stage="deadline",
                exception_type=type(exc).__name__,
            ) from None
        finally:
            guard.close()
        if last_http_error is not None:
            raise ProviderRequestError(
                last_http_error.status, last_http_error.delay,
                context_overflow=last_http_error.context_overflow,
                category=_http_error_category(last_http_error.status),
                stage="response", exception_type=type(last_http_error).__name__,
            ) from None
        if last_transport_error is not None:
            if time.monotonic() >= deadline:
                raise ProviderRequestError(
                    category="timeout", stage="deadline",
                    exception_type=type(last_transport_error).__name__,
                ) from None
            raise _provider_request_error(last_transport_error, stage="read") from None
        raise ProviderRequestError(category="invalid_response", stage="parse") from None

    def test_connection(self, timeout=8):
        """Make one small Messages request for an explicit profile test."""
        request = self._request(
            [{"role": "user", "content": "Reply with exactly OK."}],
            [], False, max_tokens=8,
        )
        deadline = time.monotonic() + timeout
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("provider request deadline exceeded")
            guard = _SocketDeadlineGuard(deadline)
            try:
                with _deadline_opener(guard, self.base).open(request, timeout=remaining) as response:
                    raw = _read_response_with_deadline(
                        response, deadline=deadline,
                        max_bytes=MAX_PROVIDER_RESPONSE_BYTES,
                    )
                    if len(raw) > MAX_PROVIDER_RESPONSE_BYTES:
                        raise ValueError("provider response too large")
            finally:
                guard.close()
            return _with_request_attempts(_anthropic_message(json.loads(raw)), 1)
        except (urllib.error.HTTPError, urllib.error.URLError, ValueError, KeyError, OSError):
            raise RuntimeError("provider request failed (details suppressed)") from None

    def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
        if getattr(self, "runtime_profile", "standard") == "lightweight":
            request = self._request(messages, tools, True)
            deadline, attempts = _lightweight_request_settings(self)
            return self._stream_lightweight(
                request, deadline=deadline, attempts=attempts,
                on_delta=on_delta, on_reasoning_delta=on_reasoning_delta,
            )
        deadline = _explicit_request_deadline(self)
        if deadline is not None:
            request = self._request(messages, tools, True)
            return self._stream_lightweight(
                request, deadline=deadline, attempts=3,
                on_delta=on_delta, on_reasoning_delta=on_reasoning_delta,
            )
        delivered = False
        def mark_delivered():
            nonlocal delivered
            delivered = True
        for attempt in range(3):
            try:
                request = self._request(messages, tools, True)
                opener = _provider_opener(self.base, _NoRedirect)
                with _open_with_retry(opener, request, 40, lambda: delivered) as response:
                    metadata = {}
                    content, calls, usage = _read_anthropic_stream(
                        response, on_delta, mark_delivered, on_reasoning_delta,
                        finish_metadata=metadata)
                result = {"content": content, "tool_calls": calls, **metadata}
                if usage:
                    result["_usage"] = usage
                return _with_request_attempts(result, attempt + 1)
            except ProviderCallbackError:
                raise
            except _RetryableProviderError as exc:
                cancel_watch.raise_if_active()
                delivered = delivered or exc.delivered
                if delivered or attempt == 2 or not exc.retryable:
                    raise _provider_request_error(
                        exc, status=exc.status, retry_after=exc.delay,
                        context_overflow=exc.context_overflow, stage="response",
                    ) from None
                time.sleep(exc.delay)
            except (urllib.error.URLError, OSError) as exc:
                cancel_watch.raise_if_active()
                if delivered or attempt == 2:
                    raise _provider_request_error(exc, stage="read") from None
                time.sleep(min(0.25 * (2 ** attempt), 2.0))
            except (http.client.HTTPException, ValueError, KeyError, IndexError,
                    TypeError, AttributeError) as exc:
                cancel_watch.raise_if_active()
                raise _provider_request_error(exc, stage="parse") from None

    def _stream_lightweight(self, request, *, deadline, attempts, on_delta=None,
                            on_reasoning_delta=None):
        guard = _SocketDeadlineGuard(deadline)
        opener = _deadline_opener(guard, self.base)
        delivered = False

        def mark_delivered():
            nonlocal delivered
            delivered = True

        try:
            for attempt in range(attempts):
                try:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("provider request deadline exceeded")
                    with _open_with_retry(
                            opener, request, remaining,
                            lambda: delivered) as response:
                        metadata = {}
                        content, calls, usage = _read_anthropic_stream(
                            response, on_delta, mark_delivered,
                            on_reasoning_delta, finish_metadata=metadata)
                    result = {"content": content, "tool_calls": calls, **metadata}
                    if usage:
                        result["_usage"] = usage
                    return _with_request_attempts(result, attempt + 1)
                except ProviderCallbackError:
                    raise
                except _RetryableProviderError as exc:
                    cancel_watch.raise_if_active()
                    delivered = delivered or exc.delivered
                    if delivered or attempt == attempts - 1 or not exc.retryable:
                        raise _provider_request_error(
                            exc, status=exc.status, retry_after=exc.delay,
                            context_overflow=exc.context_overflow, stage="response",
                        ) from None
                    _sleep_with_deadline(exc.delay, deadline)
                except (urllib.error.URLError, OSError) as exc:
                    cancel_watch.raise_if_active()
                    if time.monotonic() >= deadline:
                        raise ProviderRequestError(
                            category="timeout", stage="deadline",
                            exception_type=type(exc).__name__,
                        ) from None
                    if delivered or attempt == attempts - 1:
                        raise _provider_request_error(exc, stage="read") from None
                    _sleep_with_deadline(min(0.25 * (2 ** attempt), 2.0), deadline)
                except (http.client.HTTPException, ValueError, KeyError, IndexError,
                        TypeError, AttributeError) as exc:
                    cancel_watch.raise_if_active()
                    _raise_if_deadline_expired(deadline)
                    raise _provider_request_error(exc, stage="parse") from None
        except TimeoutError as exc:
            raise ProviderRequestError(
                category="timeout", stage="deadline",
                exception_type=type(exc).__name__,
            ) from None
        finally:
            guard.close()
        raise RuntimeError("provider request failed (details suppressed)") from None



class FakeProvider:
    """Repeatable fake provider fixture used only by automatic tests.

    Its fixture-prefixed call IDs are intentionally distinct from the retired
    public demo IDs so test sessions are never mistaken for historic demos.
    """
    def complete(self, messages, tools):
        results: dict = {}
        writes: list = []
        reads: list = []
        for message in messages:
            for call in message.get("tool_calls") or []:
                cid = call.get("id", "") or ""
                if cid == "fixture-write":
                    writes.append(cid)
                elif cid.startswith("fixture-read"):
                    reads.append(cid)
            cid = message.get("tool_call_id")
            if cid:
                try:
                    results[cid] = json.loads(message.get("content") or "{}")
                except ValueError:
                    results[cid] = {}
        if not writes:
            return {"content": "", "tool_calls": [
                {"id": "fixture-write", "type": "function", "function": {"name": "write", "arguments": json.dumps({"path": "hello.txt", "content": "Xueness demo\n"})}},
            ]}
        if not results.get("fixture-write", {}).get("ok"):
            # Denied/failed write: stop and let the operator approve this
            # exact tool_call_id; the harness re-executes it on next run.
            return {"content": json.dumps({"summary": "Fixture write needs explicit approval; see pending", "evidence": []})}
        if not reads:
            return {"content": "", "tool_calls": [
                {"id": "fixture-read", "type": "function", "function": {"name": "read", "arguments": json.dumps({"path": "hello.txt"})}},
            ]}
        last_read = reads[-1]
        if results.get(last_read, {}).get("ok"):
            return {"content": json.dumps({"summary": "Created and read hello.txt", "evidence": [{"tool_call_id": "fixture-write", "observation": "write acknowledged"}, {"tool_call_id": last_read, "observation": "file content read back"}]})}
        if len(reads) >= 3:
            return {"content": json.dumps({"summary": "Fixture could not read; workspace check required", "evidence": []})}
        read_id = "fixture-read" if len(reads) == 0 else f"fixture-read-{len(reads) + 1}"
        # Avoid reusing an existing ID.
        if read_id in reads:
            read_id = f"fixture-read-{len(reads) + 1}-b"
        return {"content": "", "tool_calls": [
            {"id": read_id, "type": "function", "function": {"name": "read", "arguments": json.dumps({"path": "hello.txt"})}},
        ]}
