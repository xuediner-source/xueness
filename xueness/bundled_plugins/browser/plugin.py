"""Approval-gated persistent Playwright browser worker."""
from __future__ import annotations

import atexit
import base64
import binascii
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading

from ...tool_contract import BuiltinTool, execution_context
from ...resources import _protect_private_directory
from .snapshot import format_snapshot

MAX_REQUEST = 100_000
MAX_RESPONSE = 1_000_000
MAX_SCREENSHOT_PNG = 450 * 1024
_BROKERS = {}
_BROKERS_LOCK = threading.RLock()


def _subject(args):
    return json.dumps(args, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _worker_environment():
    # The browser renderer receives no common API credentials. The explicit
    # executable override is retained so operators can choose installed Chrome.
    from .runtime import worker_environment
    return worker_environment()


class _BrowserBroker:
    def __init__(self, state, root):
        self.root = Path(root).resolve()
        from .profiles import managed_profile, _link
        self.profile = managed_profile(state)
        self.state = self.profile.parent
        self.profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        if _link(self.profile) or not self.profile.is_dir() or self.profile.resolve().parent != self.state:
            raise ValueError("browser profile path is unsafe")
        _protect_private_directory(self.profile)
        self.lock = threading.RLock()
        self.responses = queue.Queue()
        env = _worker_environment()
        from .runtime import worker_command
        from ...process_runtime import spawn_external
        self.process = spawn_external(subprocess.Popen,
            worker_command(self.profile), cwd=self.root,
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0,
        )
        self.reader = threading.Thread(target=self._read_output, daemon=True,
                                       name="xueness-browser-output")
        self.reader.start()
        try:
            ready = self.responses.get(timeout=25)
        except queue.Empty:
            self.close()
            raise RuntimeError("browser worker did not start; Node, Playwright and Chromium are required") from None
        if isinstance(ready, str):
            try:
                ready = json.loads(ready)
            except ValueError:
                ready = None
        if not isinstance(ready, dict) or not ready.get("ready"):
            self.close()
            reason = ready.get('reason') if isinstance(ready, dict) else None
            raise RuntimeError('browser worker could not start: ' + (reason if reason in ('driver_missing', 'browser_missing', 'launch_failed') else 'invalid_response'))

    def _read_output(self):
        try:
            while True:
                line = self.process.stdout.readline(MAX_RESPONSE + 2)
                if not line:
                    self.responses.put(None)
                    return
                if (len(line) > MAX_RESPONSE + 1 or not line.endswith("\n")
                        or len(line.encode("utf-8")) > MAX_RESPONSE):
                    self.responses.put(OverflowError("browser response exceeded the size limit"))
                    return
                self.responses.put(line)
        except (OSError, ValueError) as exc:
            self.responses.put(exc)

    def call(self, command):
        encoded = json.dumps(command, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_REQUEST:
            raise ValueError("browser request exceeds the size limit")
        with self.lock:
            if self.process.poll() is not None:
                raise RuntimeError("browser worker stopped")
            try:
                self.process.stdin.write(encoded + "\n")
                self.process.stdin.flush()
                raw = self.responses.get(timeout=45)
            except (OSError, queue.Empty):
                self.close()
                raise RuntimeError("browser worker timed out or stopped") from None
            if raw is None or isinstance(raw, BaseException):
                self.close()
                raise RuntimeError("browser worker returned invalid output") from None
            try:
                result = json.loads(raw)
            except (TypeError, ValueError):
                self.close()
                raise RuntimeError("browser worker returned invalid JSON") from None
            if not isinstance(result, dict) or type(result.get("ok")) is not bool:
                self.close()
                raise RuntimeError("browser worker returned an invalid response")
            return result

    def close(self):
        with self.lock:
            process = getattr(self, "process", None)
            if process is None or process.poll() is not None:
                return
            try:
                if process.stdin:
                    process.stdin.close()
                process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                process.terminate()
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=1)


def shutdown(state_dir=None):
    """Stop this process's browser child, optionally for one state directory."""
    target = Path(state_dir).resolve() if state_dir is not None else None
    with _BROKERS_LOCK:
        selected = [(key, broker) for key, broker in _BROKERS.items()
                    if target is None or key == str(target)]
        for key, broker in selected:
            _BROKERS.pop(key, None)
            broker.close()


def on_disabled(state_dir):
    shutdown(state_dir)


class _WorkerHandle:
    """The lifecycle handle a plugin scope holds on this state directory's worker."""

    def __init__(self, state_dir):
        self.state_dir = Path(state_dir).resolve()

    def shutdown(self):
        shutdown(self.state_dir)


def activate(scope, ctx):
    """Own the persistent worker so disabling the feature stops its child process."""
    scope.ensure('browser.worker', lambda: _WorkerHandle(ctx['state_dir']),
                 lambda worker: worker.shutdown())


def _broker(state, root):
    state = Path(state).resolve()
    key = str(state)
    with _BROKERS_LOCK:
        current = _BROKERS.get(key)
        if current is not None and current.process.poll() is None:
            return current
        if current is not None:
            _BROKERS.pop(key, None)
            current.close()
        current = _BrowserBroker(state, root)
        _BROKERS[key] = current
        return current


def _call(action, root, gate, args, session, call_id):
    context = execution_context()
    state = Path(context["state_dir"]).resolve()
    from ... import plugin_runtime
    plugin_runtime.require_enabled(state, "browser")
    value = {"action": action, **args}
    gate.check("exec", _subject(value), call_id)
    if action == "navigate":
        from urllib.parse import urlsplit
        url = urlsplit(args.get("url", ""))
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or len(args.get("url", "")) > 4096):
            raise ValueError("public HTTPS URL required")
    if action in ("click", "fill"):
        if not isinstance(args.get("selector"), str) or not 1 <= len(args["selector"]) <= 1000:
            raise ValueError("bounded selector required")
    if action == "fill" and (not isinstance(args.get("text"), str) or len(args["text"]) > 5000):
        raise ValueError("bounded text required")
    if action == "screenshot":
        value["maxPngBytes"] = MAX_SCREENSHOT_PNG
    result = _broker(state, root).call(value)
    if action == "screenshot" and result.get("ok"):
        data_url = result.get("imageDataUrl")
        prefix = "data:image/png;base64,"
        if not isinstance(data_url, str) or not data_url.startswith(prefix):
            raise RuntimeError("browser worker returned an invalid screenshot")
        try:
            image = base64.b64decode(data_url[len(prefix):], validate=True)
        except (binascii.Error, ValueError):
            raise RuntimeError("browser worker returned an invalid screenshot") from None
        if len(image) > MAX_SCREENSHOT_PNG or not image.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("browser worker returned an invalid screenshot")
        result["imageDataUrl"] = prefix + base64.b64encode(image).decode("ascii")
    if action == "snapshot" and result.get("ok"):
        try:
            formatted = format_snapshot(
                result.get("nodes"),
                reported_total=result.get("totalNodes"),
                reported_truncated=result.get("truncated") is True,
            )
        except ValueError:
            raise RuntimeError("browser worker returned an invalid snapshot") from None
        url = result.get("url")
        title = result.get("title")
        return {
            "ok": True,
            "url": url[:4096] if isinstance(url, str) else "",
            "title": title[:500] if isinstance(title, str) else "",
            "tree": formatted["tree"],
            "nodeCount": formatted["nodeCount"],
            "totalNodes": formatted["totalNodes"],
            "truncated": formatted["truncated"],
            "charTruncated": formatted["charTruncated"],
            "untrusted": True,
        }
    return result


def tools():
    return REGISTRY


def dispatch(method, parts, query, data, ctx):
    from .profiles import dispatch as profile_dispatch
    result = profile_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .settings_api import dispatch as settings_dispatch
    return settings_dispatch(method, parts, query, data, ctx)


def _tool_description(action):
    if action == "snapshot":
        return (
            "Read-only accessibility tree of the current public HTTPS page: role, "
            "accessible name, indentation, and stable refs on interactable elements. "
            "browser_click and browser_fill accept selector aria-ref=<ref> from this "
            "snapshot until the next snapshot or navigation. Does not change the page. "
            "Node and character limits are marked when truncated. Exact action approval required."
        )
    if action in ("click", "fill"):
        return (
            "Browser " + action + "; selector is a Playwright locator and may be "
            "aria-ref=<ref> from the latest browser_snapshot; exact action approval required"
        )
    return "Browser " + action + "; exact action approval required"


REGISTRY = tuple(
    BuiltinTool("browser_" + action, _tool_description(action),
                parameters, required, "exec", action in ("click", "fill"),
                lambda root, gate, args, session, cid, action=action:
                    _call(action, root, gate, args, session, cid),
                lambda args, action=action: _subject({"action": action, **args}))
    for action, parameters, required in (
        ("navigate", {"url": {"type": "string"}}, ("url",)),
        ("inspect", {}, ()),
        ("snapshot", {}, ()),
        ("click", {"selector": {"type": "string"}}, ("selector",)),
        ("fill", {"selector": {"type": "string"}, "text": {"type": "string"}},
         ("selector", "text")),
        ("screenshot", {}, ()),
    )
)

atexit.register(shutdown)


def composer_capabilities():
    from .composer_capabilities import CAPABILITIES
    return CAPABILITIES
