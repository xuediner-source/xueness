"""Bundled pi-lite provider worker used by :mod:`pi_sidecar`.

The worker is intentionally a transport adapter.  Durable sessions, tools and
approvals stay in the host process; this child only resolves the configured
local provider and forwards model stream deltas over the strict runtime JSONL
protocol.  It never accepts an executable path or provider credentials from a
request frame.
"""
from __future__ import annotations

import json
import ipaddress
import math
import os
from pathlib import Path
import sys
import threading
import time
from typing import Any
import urllib.parse

from .runtime import PROTOCOL_VERSION, decode_request, encode_response


MAX_FRAME_BYTES = 1_048_576
_STATE_ENV = "XUENESS_PI_LITE_STATE_DIR"
_WRITE_LOCK = threading.Lock()


def _error_frame(request, code: str, message: str) -> dict[str, Any]:
    return {
        "version": PROTOCOL_VERSION,
        "requestId": request["requestId"],
        "sessionId": request["sessionId"],
        "method": request["method"],
        "ok": False,
        "payload": {},
        "error": {"code": code[:128], "message": message.replace("\r", " ").replace("\n", " ")[:128]},
    }


def _write(frame: dict[str, Any]) -> None:
    raw = encode_response(frame).encode("utf-8")
    if len(raw) > MAX_FRAME_BYTES:
        raise ValueError("sidecar response exceeds size limit")
    with _WRITE_LOCK:
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()


def _state_dir() -> Path:
    value = os.environ.get(_STATE_ENV, "")
    if not value or "\x00" in value:
        raise ValueError("pi-lite state directory is unavailable")
    path = Path(value)
    if not path.is_absolute() or not path.is_dir():
        raise ValueError("pi-lite state directory is unavailable")
    return path


def _payload(request: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("request payload must be an object")
    allowed = {"providerId", "model", "reasoningEffort", "messages", "tools",
               "expectedBase", "runtimeOptions", "timeoutSeconds"}
    if set(payload) - allowed:
        raise ValueError("unknown pi-lite request fields")
    messages = payload.get("messages", [])
    tools = payload.get("tools", [])
    if not isinstance(messages, list) or len(messages) > 128 or any(not isinstance(m, dict) for m in messages):
        raise ValueError("messages must be a bounded array")
    if not isinstance(tools, list) or len(tools) > 64 or any(not isinstance(t, dict) for t in tools):
        raise ValueError("tools must be a bounded array")
    return _state_dir(), payload


def _local_provider(provider: Any) -> bool:
    """Only let the bundled worker call an explicitly loopback endpoint."""
    base = getattr(provider, "base", "")
    try:
        parsed = urllib.parse.urlparse(base)
        host = parsed.hostname or ""
        return parsed.scheme in ('http', 'https') and ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _run(request: dict[str, Any]) -> None:
    if request["method"] != "turn/start":
        _write(_error_frame(request, "runtime.unsupportedMethod", "unsupported pi-lite method"))
        return
    try:
        state_dir, payload = _payload(request)
        from ...plugin_runtime import require_enabled
        for pid in ('runtimes', 'sessions', 'providers'):
            require_enabled(state_dir, pid)
        from ..providers.provider_config import resolve
        provider = resolve(
            state_dir,
            provider_id=payload.get("providerId"),
            model=payload.get("model"),
            reasoning_effort=payload.get("reasoningEffort"),
            runtime_profile="lightweight",
            session_id=request["sessionId"],
        )
        if not _local_provider(provider):
            raise ValueError("pi-lite sidecar requires a loopback provider endpoint")
        if 'expectedBase' in payload and provider.base != payload['expectedBase']:
            raise ValueError('provider configuration changed before sidecar request')
        from ..providers.lightweight import prepare_provider
        provider = prepare_provider(provider)
        if 'runtimeOptions' in payload:
            record = payload['runtimeOptions']
            fields = {'runtimeProfile', 'contextWindow', 'maxOutputTokens', 'toolCalling',
                      'compatibility', 'lightweightOptions'}
            if not isinstance(record, dict) or set(record) - fields or record.get('runtimeProfile') != 'lightweight':
                raise ValueError('invalid pi-lite runtime options')
            from ..providers.runtime_options import resolve_runtime_options
            from ..providers.provider import AnthropicMessages
            protocol = getattr(provider, 'protocol', 'anthropic' if isinstance(provider, AnthropicMessages) else 'openai')
            options = resolve_runtime_options(record, protocol)
            for key, value in options.items():
                setattr(provider, key, value)
            if hasattr(provider, 'max_tokens'):
                provider.max_tokens = provider.max_output_tokens
        timeout = payload.get('timeoutSeconds', 120)
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 3600:
            raise ValueError('invalid pi-lite request timeout')
        provider.request_deadline = time.monotonic() + timeout
        messages = payload.get("messages", [])
        tools = payload.get("tools", [])

        def emit_text(kind: str, text: Any) -> None:
            if not isinstance(text, str):
                raise ValueError("provider returned a non-text delta")
            _write({
                "version": PROTOCOL_VERSION,
                "requestId": request["requestId"],
                "sessionId": request["sessionId"],
                "method": request["method"],
                "ok": True,
                "payload": {"type": kind, "text": text},
            })

        result = provider.stream(messages, tools,
                                 on_delta=lambda text: emit_text('text-delta', text),
                                 on_reasoning_delta=lambda text: emit_text('reasoning-delta', text))
        # Fail closed if a provider adapter returns a non-JSON-safe object.
        json.dumps(result, ensure_ascii=False, allow_nan=False)
        _write({
            "version": PROTOCOL_VERSION,
            "requestId": request["requestId"],
            "sessionId": request["sessionId"],
            "method": request["method"],
            "ok": True,
            "payload": {"type": "result", "result": result},
        })
    except Exception as exc:
        # Diagnostics must never echo provider keys, prompts, URLs or bodies.
        frame = _error_frame(request, 'runtime.providerFailure', 'local provider request failed')
        from ..providers.provider import ProviderRequestError
        if isinstance(exc, ProviderRequestError):
            frame['error']['details'] = {'status': exc.status, 'category': exc.category,
                                         'stage': exc.stage, 'contextOverflow': exc.context_overflow}
        _write(frame)


def main() -> int:
    while True:
        raw = sys.stdin.buffer.readline(MAX_FRAME_BYTES + 2)
        if not raw:
            break
        if len(raw) > MAX_FRAME_BYTES + 1 or not raw.endswith(b"\n"):
            return 2
        try:
            request = decode_request(raw)
            _run(request)
        except Exception:
            # Do not echo malformed input or provider diagnostics to stdout.
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
