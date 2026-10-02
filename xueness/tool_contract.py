"""Kernel contract for tools contributed by trusted feature packages."""
from __future__ import annotations
import contextvars
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

#: Handler signature. ``call_id`` is the provider tool-call id when known; the
#: web gate binds one-shot approvals to it.
Handler = Callable[[Path, "object", dict, "dict | None", "str | None"], dict]


@dataclass(frozen=True)
class ToolContext:
    """Ephemeral runner resources made available to contributed tool handlers."""

    store: object
    state_dir: Path
    registry: object = None
    tool_catalog: object = None


_EXECUTION = contextvars.ContextVar("xueness_tool_execution", default=None)


@contextmanager
def bind_context(context: ToolContext):
    """Compatibility adapter binding a :class:`ToolContext` for one dispatch."""
    token = _EXECUTION.set({"store": context.store, "state_dir": context.state_dir,
                            "registry": context.registry, "tool_catalog": context.tool_catalog})
    try:
        yield context
    finally:
        _EXECUTION.reset(token)


def get_context() -> ToolContext:
    """Return the active context as an object for older trusted handlers."""
    return ToolContext(**execution_context())


@dataclass
class BuiltinTool:
    """One base tool: schema, Gate kind, and handler in a single value.

    ``parameters`` is the JSON-schema property map and ``required`` the required
    key tuple, exactly as the provider schema needs them. ``gate_kind`` is the
    string handed to ``Gate.check`` so the permission boundary and the schema
    cannot disagree about which capability a tool is.

    Not frozen: tests that prove ``run`` routes through this registry replace
    ``handler`` with a spy via ``unittest.mock.patch.object``.
    """

    name: str
    description: str
    parameters: dict
    required: tuple
    gate_kind: str
    mutating: bool
    handler: Handler
    approval_subject: Callable[[dict], str] | None = None

    def schema(self) -> dict:
        return {"type": "function", "function": {
            "name": self.name,
            "description": self.description,
            "parameters": {"type": "object", "properties": self.parameters,
                           "required": list(self.required),
                           "additionalProperties": False},
        }}


def execution_context():
    value = _EXECUTION.get()
    if value is None:
        raise ValueError('tool requires an active harness context')
    return value


def permission_result(gate, exc):
    """Distinguish a host approval pause from a policy refusal, without echoing data."""
    waiting = bool(getattr(gate, 'web_approval_gate', False)
                   and str(exc).endswith('requires explicit approval'))
    return {'ok': False, 'error': 'denied',
            'error_code': 'approval_required' if waiting else 'permission_denied',
            'awaiting_approval': waiting, 'retryable': False,
            'user_reason': '等待你批准工具调用；批准后继续。' if waiting else '当前权限策略禁止此工具；请调整权限或任务要求。'}

@contextmanager
def bind_execution(**values):
    token = _EXECUTION.set(values)
    try:
        yield values
    finally:
        _EXECUTION.reset(token)
