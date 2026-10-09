"""Interrupt a blocked provider read when a stop probe asks for it.

The product switch is ``sessions.cancel_propagate`` (default off). Nothing
here starts unless ``bind_provider_cancel`` installed a callback in this
context. With no callback, ``read`` / ``readline`` / ``read1`` call the
response object directly and do not start a thread.

The probe runs on one joined daemon thread and only shuts down a duplicate
of a socket this request already holds, through the same ``_interrupt_socket``
helper the deadline guard uses. Header waits stay on the existing open
timeout: the response object, and therefore its socket, does not exist until
the status line arrives. A body that then stalls is what this closes.

If the probe itself raises, that exception is stored, the socket is shut
down, and the reader thread re-raises it. It is not turned into a provider
error and it is not retried.

Reference (idea, not copied code): ZCode v3.14.3
``packages/rpc/src/channelServer.ts`` (a cancellation token disposed on
PromiseCancel). Socket shutdown follows this tree's existing provider
transport helper, not a second process terminator.
"""
from __future__ import annotations

import contextvars
import threading

_CURRENT = contextvars.ContextVar('xueness_provider_cancel', default=None)

#: How often the probe runs while a read is blocked. Short enough that a
#: stop is visible inside a one-second test budget, long enough to stay idle.
POLL_SECONDS = 0.2
_THREAD_NAME = 'xueness-provider-cancel'


class ProviderCancelled(Exception):
    """The stop probe fired while a provider socket was blocked.

    ``_xueness_stream_control`` matches the signal core already settles as a
    user stop. This is not an ``OSError``, so the provider retry handlers do
    not treat it as a transport failure.
    """

    _xueness_stream_control = 'stop'

    def __init__(self, message='provider read cancelled'):
        super().__init__(message)


class _Binding:
    __slots__ = ('token', 'watch')

    def __init__(self, token, watch):
        self.token = token
        self.watch = watch


class _Watch:
    def __init__(self, callback):
        self._callback = callback
        self._lock = threading.Lock()
        self._sockets = []
        self._seen = set()
        self._error = None
        self._cancelled = False
        self._closed = False
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run, name=_THREAD_NAME, daemon=True)
        self._thread.start()

    def attach(self, response):
        """Dup the response socket once so a later stop can shut it down."""
        from .provider import _interrupt_socket, _response_socket
        sock = _response_socket(response)
        if sock is None:
            return
        key = id(sock)
        with self._lock:
            if self._closed or key in self._seen:
                return
        try:
            duplicate = sock.dup()
        except (AttributeError, OSError, NotImplementedError):
            return
        with self._lock:
            if self._closed or key in self._seen:
                discard = True
                interrupt = self._cancelled or self._error is not None
            else:
                self._seen.add(key)
                self._sockets.append(duplicate)
                discard = False
                interrupt = self._cancelled or self._error is not None
        if discard or interrupt:
            if interrupt:
                _interrupt_socket(duplicate)
            else:
                try:
                    duplicate.close()
                except OSError:
                    pass

    def raise_pending(self):
        with self._lock:
            error = self._error
            cancelled = self._cancelled
        if error is not None:
            raise error
        if cancelled:
            raise ProviderCancelled()

    def close(self):
        with self._lock:
            self._closed = True
            sockets = self._sockets
            self._sockets = []
        self._stop.set()
        if self._thread is not threading.current_thread():
            self._thread.join(timeout=2.0)
        for sock in sockets:
            try:
                sock.close()
            except OSError:
                pass

    def _run(self):
        while not self._stop.wait(POLL_SECONDS):
            try:
                requested = bool(self._callback())
            except Exception as exc:
                self._trip(exc)
                return
            if requested:
                self._trip(None)
                return

    def _trip(self, error):
        from .provider import _interrupt_socket
        with self._lock:
            if self._closed:
                return
            if error is not None:
                if self._error is None:
                    self._error = error
            else:
                self._cancelled = True
            sockets = list(self._sockets)
        for sock in sockets:
            _interrupt_socket(sock)


def bind_provider_cancel(callback):
    """Install ``callback`` for the current context. Returns an unbind token."""
    if not callable(callback):
        return None
    watch = _Watch(callback)
    return _Binding(_CURRENT.set(watch), watch)


def unbind_provider_cancel(binding):
    """Restore the previous callback and join the probe thread."""
    if binding is None:
        return
    try:
        _CURRENT.reset(binding.token)
    finally:
        binding.watch.close()


def raise_if_active():
    """Raise a stored probe failure or :class:`ProviderCancelled` if stopping.

    Retry and parse handlers call this before they replay a request or wrap
    the socket error as a provider failure. No callback means no change.
    """
    watch = _CURRENT.get()
    if watch is not None:
        watch.raise_pending()


def _guarded(response, call):
    watch = _CURRENT.get()
    if watch is None:
        return call()
    watch.attach(response)
    try:
        watch.raise_pending()
        data = call()
    except Exception:
        watch.raise_pending()
        raise
    watch.raise_pending()
    return data


def read(response, size):
    watch = _CURRENT.get()
    if watch is None:
        return response.read(size)
    return _guarded(response, lambda: response.read(size))


def readline(response, size):
    watch = _CURRENT.get()
    if watch is None:
        return response.readline(size)
    return _guarded(response, lambda: response.readline(size))


def read1(response, reader, size):
    watch = _CURRENT.get()
    if watch is None:
        return reader(size)
    return _guarded(response, lambda: reader(size))
