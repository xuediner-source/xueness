"""Provider adapters for configured models plus an internal automatic-test fixture."""
import ipaddress
import base64
import email.utils
import errno
import http.client
import json
import math
import os
import select
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .runtime_options import build_openai_payload, resolve_runtime_options
from .lightweight_config import effective_options

#: Opt-in env flag unlocking plaintext HTTP **only** for loopback IP literals.
#: Kept off by default so existing HTTPS-only behaviour is unchanged.
LOOPBACK_HTTP_ENV = "XUENESS_ALLOW_LOOPBACK_HTTP"
MAX_PROVIDER_RESPONSE_BYTES = 2_000_000
MAX_MODEL_LIST_RESPONSE_BYTES = 512_000
MAX_DISCOVERED_MODELS = 500
MAX_DISCOVERED_MODEL_ID_CHARS = 256
MAX_MODEL_OWNER_CHARS = 128
MODEL_DISCOVERY_MAX_TIMEOUT_SECONDS = 8.0


def _with_reported_usage(message, payload):
    """Retain actual JSON-response usage just as the SSE adapter does."""
    if not isinstance(message, dict):
        raise ValueError("provider message must be an object")
    result = dict(message)
    usage = payload.get("usage")
    if isinstance(usage, dict) and usage:
        result["_usage"] = dict(usage)
    return result


class ProviderRequestError(RuntimeError):
    """Sanitized provider failure with safe scheduling hints for callers."""

    def __init__(self, status=None, retry_after=None, *, context_overflow=False):
        super().__init__("provider request failed (details suppressed)")
        self.status = status if isinstance(status, int) else None
        self.context_overflow = bool(context_overflow)
        retryable = self.status == 429 or (self.status is not None and 500 <= self.status <= 599)
        self.retry_after = (max(0.0, min(float(retry_after), 2.0))
                            if retryable and isinstance(retry_after, (int, float)) else None)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the provider bearer token to a redirect destination.

    Raising (instead of returning None) fails closed and avoids leaking the
    unclosed redirect response object (ResourceWarning) under stdlib semantics.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if fp is not None:
            fp.close()  # Do not drain an untrusted response body (it may be unbounded).
        raise urllib.error.URLError(f"provider redirect blocked ({code})")


def _interrupt_socket(sock):
    """Shut down a duplicated provider socket, suppressing cleanup errors."""
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
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
    returns, and it keeps duplicated descriptors so urllib may close its own
    socket reference without disabling the deadline.
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
                self._sockets.append(duplicate)
                close_now = False
        if close_now:
            _interrupt_socket(duplicate)

    def _expire(self):
        with self._lock:
            self._expired = True
            sockets = list(self._sockets)
        for sock in sockets:
            _interrupt_socket(sock)

    def close(self):
        self._timer.cancel()
        self._timer.join()
        with self._lock:
            sockets, self._sockets = self._sockets, []
        for sock in sockets:
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
        # every resolved address. Register before connect so expiry can also
        # interrupt a slow TCP handshake.
        errors = []
        # The stdlib's synchronous resolver cannot be interrupted by the
        # socket watchdog; DNS lookup keeps the operating system's resolver
        # timing. Once an address is available, connect/TLS/HTTP I/O are bounded.
        addresses = socket.getaddrinfo(self.host, self.port, 0, socket.SOCK_STREAM)
        for family, socktype, proto, _canonname, address in addresses:
            sock = socket.socket(family, socktype, proto)
            self._deadline_guard.register(sock)
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
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _lightweight_request_settings(provider):
    """Resolve one lightweight inference's total deadline and retry count."""
    options = effective_options(
        value=getattr(provider, "lightweight_options", {}),
        context=getattr(provider, "context_window", None),
        output=getattr(provider, "max_output_tokens", None),
    )
    now = time.monotonic()
    deadline = now + options["requestTimeoutSeconds"]
    run_deadline = getattr(provider, "request_deadline", None)
    if run_deadline is not None:
        if type(run_deadline) not in (int, float):
            raise ValueError("invalid provider request deadline")
        try:
            run_deadline = float(run_deadline)
        except (OverflowError, ValueError):
            raise ValueError("invalid provider request deadline") from None
        if not math.isfinite(run_deadline):
            raise ValueError("invalid provider request deadline")
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
                absolute_deadline=deadline, transport_only_retries=True,
            )
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
                        raw = response.read(2_000_001)
                        if len(raw) > 2_000_000:
                            raise ValueError("provider response too large")
                        payload = json.loads(raw)
                        return _with_reported_usage(payload["choices"][0]["message"], payload)
                    text, calls, usage = _read_openai_stream(
                        response, on_delta, mark_delivered, on_reasoning_delta)
                result = {"content": text, "tool_calls": calls}
                if usage:
                    result["_usage"] = usage
                return result
            except _RetryableProviderError as exc:
                delivered = delivered or exc.delivered
                if delivered or attempts >= 3 or not exc.retryable:
                    raise ProviderRequestError(
                        exc.status, exc.delay,
                        context_overflow=exc.context_overflow,
                    ) from None
                time.sleep(exc.delay)
            except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError, json.JSONDecodeError):
                if delivered or attempts >= 3:
                    raise ProviderRequestError() from None
                time.sleep(min(0.25 * (2 ** (attempts - 1)), 2.0))

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
                            return _with_reported_usage(
                                payload["choices"][0]["message"], payload)
                        text, calls, usage = _read_openai_stream(
                            response, on_delta, mark_delivered,
                            on_reasoning_delta)
                    result = {"content": text, "tool_calls": calls}
                    if usage:
                        result["_usage"] = usage
                    return result
                except _RetryableProviderError as exc:
                    delivered = delivered or exc.delivered
                    _raise_if_deadline_expired(deadline)
                    if delivered or attempt == attempts - 1 or not exc.retryable:
                        raise ProviderRequestError(
                            exc.status, exc.delay,
                            context_overflow=exc.context_overflow,
                        ) from None
                    _sleep_with_deadline(exc.delay, deadline)
                except (urllib.error.URLError, OSError):
                    _raise_if_deadline_expired(deadline)
                    if delivered or attempt == attempts - 1:
                        raise ProviderRequestError() from None
                    _sleep_with_deadline(min(0.25 * (2 ** attempt), 2.0), deadline)
                except (ValueError, KeyError, IndexError, json.JSONDecodeError):
                    # transportRetries cover network failures only. A malformed
                    # response has already reached the client and is not replayed.
                    raise ProviderRequestError() from None
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
                      transport_only_retries=False,
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
                            payload = response.read(max_response_bytes + 1)
                        else:
                            payload = _read_response_with_deadline(
                                response, deadline=deadline,
                                max_bytes=max_response_bytes,
                            )
                        if len(payload) > max_response_bytes:
                            raise ValueError("provider response too large")
                    parsed = json.loads(payload)
                    return _with_reported_usage(parsed["choices"][0]["message"], parsed)
                except _RetryableProviderError as exc:
                    last_http_error = exc
                    _raise_if_deadline_expired(deadline)
                    if attempt == attempts - 1 or not exc.retryable:
                        break
                    _sleep_with_deadline(exc.delay, deadline)
                except (urllib.error.URLError, OSError):
                    _raise_if_deadline_expired(deadline)
                    if attempt == attempts - 1:
                        break
                    _sleep_with_deadline(min(0.25 * (2 ** attempt), 2.0), deadline)
                except (ValueError, KeyError, IndexError):
                    if transport_only_retries:
                        break
                    _raise_if_deadline_expired(deadline)
                    if attempt == attempts - 1:
                        break
                    _sleep_with_deadline(min(0.25 * (2 ** attempt), 2.0), deadline)
        finally:
            if guard is not None:
                guard.close()
        # Never include remote bodies, URLs or exception strings; they may contain credentials.
        if last_http_error is not None:
            raise ProviderRequestError(
                last_http_error.status, last_http_error.delay,
                context_overflow=last_http_error.context_overflow,
            ) from None
        _raise_if_deadline_expired(deadline)
        raise RuntimeError("provider request failed (details suppressed)") from None


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
    except (OSError, ValueError, TypeError, AttributeError):
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
        chunk = reader(min(65_536, max_bytes + 1 - size))
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
        line = response.readline(262145)
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


def _read_openai_stream(response, on_delta, mark_delivered, on_reasoning_delta=None):
    text_parts = []
    calls = {}
    finished = False
    usage = None
    for payload in _read_sse(response):
        if payload == "[DONE]":
            finished = True
            break
        item = json.loads(payload)
        raw_usage = item.get("usage")
        if isinstance(raw_usage, dict):
            usage = {key: value for key, value in raw_usage.items()
                     if key in ("prompt_tokens", "completion_tokens", "total_tokens")
                     and isinstance(value, int) and value >= 0}
        choices = item.get("choices") or []
        if not choices:
            continue
        if choices[0].get("finish_reason") is not None:
            finished = True
        delta = choices[0].get("delta") or {}
        # Compatible APIs expose reasoning under different names. Keep it out
        # of assistant content and only forward it through the opt-in observer;
        # callers that do not request reasoning retain the previous behavior.
        for key in ("reasoning_content", "reasoning", "thinking"):
            reasoning = delta.get(key)
            if isinstance(reasoning, str) and reasoning and on_reasoning_delta:
                mark_delivered()
                on_reasoning_delta(reasoning)
        content = delta.get("content")
        if isinstance(content, str) and content:
            text_parts.append(content)
            mark_delivered()
            if on_delta:
                on_delta(content)
        for call in delta.get("tool_calls") or []:
            index = call.get("index", 0)
            target = calls.setdefault(index, {"id": "", "type": "function",
                                               "function": {"name": "", "arguments": ""}})
            if call.get("id"):
                target["id"] = call["id"]
            fn = call.get("function") or {}
            if fn.get("name"):
                target["function"]["name"] += fn["name"]
            if fn.get("arguments"):
                target["function"]["arguments"] += fn["arguments"]
    if not finished:
        raise ConnectionError("incomplete provider stream")
    return "".join(text_parts), [calls[index] for index in sorted(calls)], usage


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


def _read_anthropic_stream(response, on_delta, mark_delivered, on_reasoning_delta=None):
    text_parts = []
    blocks = {}
    stopped = False
    usage = {}
    for payload in _read_sse(response):
        event = json.loads(payload)
        kind = event.get("type")
        if kind == "message_start":
            raw_usage = ((event.get("message") or {}).get("usage") or {})
            value = raw_usage.get("input_tokens")
            if isinstance(value, int) and value >= 0:
                usage["prompt_tokens"] = value
        elif kind == "message_delta":
            raw_usage = event.get("usage") or {}
            value = raw_usage.get("output_tokens")
            if isinstance(value, int) and value >= 0:
                usage["completion_tokens"] = value
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
                    on_reasoning_delta(initial)
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
                        on_delta(value)
            elif delta.get("type") in ("thinking_delta", "reasoning_delta"):
                value = delta.get("thinking", delta.get("reasoning", delta.get("text", "")))
                if isinstance(value, str) and value and on_reasoning_delta:
                    mark_delivered()
                    on_reasoning_delta(value)
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
            except TimeoutError:
                raise
            except (urllib.error.HTTPError, urllib.error.URLError, ValueError,
                    KeyError, OSError, TypeError, AttributeError):
                raise RuntimeError("provider request failed (details suppressed)") from None
        try:
            with _provider_opener(self.base, _NoRedirect).open(self._request(messages, tools, False), timeout=40) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise ValueError("provider response too large")
            return _anthropic_message(json.loads(raw))
        except (urllib.error.HTTPError, urllib.error.URLError, ValueError, KeyError, OSError):
            raise RuntimeError("provider request failed (details suppressed)") from None

    def _complete_lightweight(self, request, deadline, attempts):
        guard = _SocketDeadlineGuard(deadline)
        opener = _deadline_opener(guard, self.base)
        last_http_error = None
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
                    return _anthropic_message(json.loads(raw))
                except _RetryableProviderError as exc:
                    last_http_error = exc
                    _raise_if_deadline_expired(deadline)
                    if attempt == attempts - 1 or not exc.retryable:
                        break
                    _sleep_with_deadline(exc.delay, deadline)
                except (urllib.error.URLError, OSError):
                    _raise_if_deadline_expired(deadline)
                    if attempt == attempts - 1:
                        break
                    _sleep_with_deadline(min(0.25 * (2 ** attempt), 2.0), deadline)
                except (ValueError, KeyError, IndexError, TypeError, AttributeError):
                    # Once response bytes arrive, a malformed response is not
                    # a transport failure and must not be replayed.
                    raise RuntimeError("provider request failed (details suppressed)") from None
        finally:
            guard.close()
        if last_http_error is not None:
            raise ProviderRequestError(
                last_http_error.status, last_http_error.delay,
                context_overflow=last_http_error.context_overflow,
            ) from None
        _raise_if_deadline_expired(deadline)
        raise RuntimeError("provider request failed (details suppressed)") from None

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
            return _anthropic_message(json.loads(raw))
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
        delivered = False
        def mark_delivered():
            nonlocal delivered
            delivered = True
        for attempt in range(3):
            try:
                request = self._request(messages, tools, True)
                opener = _provider_opener(self.base, _NoRedirect)
                with _open_with_retry(opener, request, 40, lambda: delivered) as response:
                    content, calls, usage = _read_anthropic_stream(
                        response, on_delta, mark_delivered, on_reasoning_delta)
                result = {"content": content, "tool_calls": calls}
                if usage:
                    result["_usage"] = usage
                return result
            except _RetryableProviderError as exc:
                delivered = delivered or exc.delivered
                if delivered or attempt == 2 or not exc.retryable:
                    raise ProviderRequestError(
                        exc.status, exc.delay,
                        context_overflow=exc.context_overflow,
                    ) from None
                time.sleep(exc.delay)
            except (urllib.error.URLError, OSError, ValueError, KeyError):
                if delivered or attempt == 2:
                    raise ProviderRequestError() from None
                time.sleep(min(0.25 * (2 ** attempt), 2.0))

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
                        content, calls, usage = _read_anthropic_stream(
                            response, on_delta, mark_delivered,
                            on_reasoning_delta)
                    result = {"content": content, "tool_calls": calls}
                    if usage:
                        result["_usage"] = usage
                    return result
                except _RetryableProviderError as exc:
                    delivered = delivered or exc.delivered
                    _raise_if_deadline_expired(deadline)
                    if delivered or attempt == attempts - 1 or not exc.retryable:
                        raise ProviderRequestError(
                            exc.status, exc.delay,
                            context_overflow=exc.context_overflow,
                        ) from None
                    _sleep_with_deadline(exc.delay, deadline)
                except (urllib.error.URLError, OSError):
                    _raise_if_deadline_expired(deadline)
                    if delivered or attempt == attempts - 1:
                        raise ProviderRequestError() from None
                    _sleep_with_deadline(min(0.25 * (2 ** attempt), 2.0), deadline)
                except (ValueError, KeyError, TypeError, AttributeError):
                    raise ProviderRequestError() from None
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
