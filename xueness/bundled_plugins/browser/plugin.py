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
    return {key: value for key, value in os.environ.items()
            if not re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", key, re.I)}


class _BrowserBroker:
    def __init__(self, state, root):
        self.state = Path(state).resolve()
        self.root = Path(root).resolve()
        self.profile = self.state / f"browser-profile-{os.getpid()}"
        if self.profile.is_symlink():
            raise ValueError("browser profile cannot be a symlink")
        self.profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.profile.is_symlink() or not self.profile.is_dir():
            raise ValueError("browser profile path is unsafe")
        os.chmod(self.profile, 0o700)
        self.lock = threading.RLock()
        self.responses = queue.Queue()
        script = Path(__file__).with_name("bridge.mjs")
        env = _worker_environment()
        executable = os.environ.get('XUENESS_DESKTOP_NODE') or 'node'
        if os.environ.get('XUENESS_DESKTOP_NODE'):
            env['ELECTRON_RUN_AS_NODE'] = '1'
        from ...process_runtime import spawn_external
        self.process = spawn_external(subprocess.Popen,
            [executable, str(script), str(self.profile)], cwd=self.root,
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
            raise RuntimeError("browser worker returned an invalid startup response")

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
    return result


def tools():
    return REGISTRY


def dispatch(method, parts, query, data, ctx):
    from .settings_api import dispatch as settings_dispatch
    return settings_dispatch(method, parts, query, data, ctx)


REGISTRY = tuple(
    BuiltinTool("browser_" + action, "Browser " + action + "; exact action approval required",
                parameters, required, "exec", action in ("click", "fill"),
                lambda root, gate, args, session, cid, action=action:
                    _call(action, root, gate, args, session, cid),
                lambda args, action=action: _subject({"action": action, **args}))
    for action, parameters, required in (
        ("navigate", {"url": {"type": "string"}}, ("url",)),
        ("inspect", {}, ()),
        ("click", {"selector": {"type": "string"}}, ("selector",)),
        ("fill", {"selector": {"type": "string"}, "text": {"type": "string"}},
         ("selector", "text")),
        ("screenshot", {}, ()),
    )
)

atexit.register(shutdown)
