"""Drive the Python provider adapters through scripted HTTP cases.

Input (stdin JSON): {"port": int, "cases": [case, ...]} where each case uses the
shape of ``ProviderCase`` in ``packages/providers/test/support/http-fixtures.ts``.
Output (stdout JSON): one outcome per case with the result or the sanitized
error, the observed callback values and the recorded retry sleeps.
"""
import json
import os
import sys
import time

for _name in list(os.environ):
    if _name.startswith(("XUENESS_", "ANTHROPIC_")) or _name.lower().endswith("_proxy"):
        del os.environ[_name]

from xueness.bundled_plugins.providers import provider as P  # noqa: E402

SLEEPS = []
time.sleep = SLEEPS.append  # retry backoff is recorded, never waited for


class StreamStopped(Exception):
    _xueness_stream_control = "stop"


def describe(exc):
    out = {"type": type(exc).__name__}
    if isinstance(exc, P.ProviderRequestError):
        for name in ("status", "category", "stage", "exception_type", "context_overflow",
                     "quota_reset_at", "retry_after"):
            out[name] = getattr(exc, name)
    elif isinstance(exc, P.ProviderCallbackError):
        out["exception_type"] = exc.exception_type
        out["stage"] = exc.stage
    elif not isinstance(exc, StreamStopped):
        out["message"] = str(exc)
    return out


def callback(kind, mode, calls):
    if mode == "none":
        return None

    def observe(value):
        calls.append([kind, value])
        if mode == "raise":
            raise ValueError("private callback detail")
        if mode == "stop":
            raise StreamStopped()
    return observe


def build(case, port):
    init = dict(case.get("init") or {})
    if case["method"] != "construct":
        init.setdefault("base", "http://127.0.0.1:%d/py/%s" % (port, case["id"]))
        init.setdefault("allow_loopback_http", True)
    init.setdefault("model", "test-model")
    init.setdefault("key", "test-key")
    cls = P.OpenAICompatible if case["provider"] == "openai" else P.AnthropicMessages
    provider = cls(**init)
    for name, value in (case.get("attrs") or {}).items():
        setattr(provider, name, value)
    if case.get("deadline") is not None:
        provider.request_deadline = time.monotonic() + case["deadline"]
    return provider


def summary(provider):
    out = {"model": provider.model, "capabilities": sorted(provider.capabilities)}
    for name in ("runtime_profile", "context_window", "max_output_tokens", "tool_calling", "compatibility",
                 "lightweight_options", "reasoning_effort", "max_tokens"):
        if hasattr(provider, name):
            out[name] = getattr(provider, name)
    return out


def run(case, port):
    calls = []
    del SLEEPS[:]
    outcome = {"id": case["id"], "result": None, "error": None, "calls": calls}
    try:
        provider = build(case, port)
        messages = case.get("messages") or []
        tools = case.get("tools") or []
        if case["method"] == "construct":
            outcome["result"] = summary(provider)
        elif case["method"] == "complete":
            outcome["result"] = provider.complete(messages, tools)
        else:
            modes = case.get("callbacks") or {}
            outcome["result"] = provider.stream(
                messages, tools,
                on_delta=callback("delta", modes.get("delta", "record"), calls),
                on_reasoning_delta=callback("reasoning", modes.get("reasoning", "record"), calls),
                on_tool_delta=callback("tool", modes.get("tool", "record"), calls))
    except Exception as exc:  # the oracle reports every failure shape
        outcome["error"] = describe(exc)
    outcome["sleeps"] = list(SLEEPS)
    return outcome


def main():
    spec = json.loads(sys.stdin.read())
    results = [run(case, spec["port"]) for case in spec["cases"]]
    sys.stdout.write(json.dumps(results, ensure_ascii=True, default=repr))


main()
