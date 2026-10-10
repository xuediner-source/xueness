"""Kernel contract for tools contributed by trusted feature packages."""
from __future__ import annotations
import contextvars
from contextlib import contextmanager
from dataclasses import dataclass, fields
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
    subagent_coordinator: object = None


_EXECUTION = contextvars.ContextVar("xueness_tool_execution", default=None)


@contextmanager
def bind_context(context: ToolContext):
    """Compatibility adapter binding a :class:`ToolContext` for one dispatch."""
    values = {"store": context.store, "state_dir": context.state_dir,
              "registry": context.registry, "tool_catalog": context.tool_catalog,
              "subagent_coordinator": context.subagent_coordinator}
    parent = _EXECUTION.get()
    parent_scope = parent.get("execution_scope") if isinstance(parent, dict) else None
    values["execution_scope"] = parent_scope if isinstance(parent_scope, dict) else {}
    token = _EXECUTION.set(values)
    try:
        yield context
    finally:
        _EXECUTION.reset(token)


def get_context() -> ToolContext:
    """Return the active context as an object for older trusted handlers."""
    values = execution_context()
    # execution_scope and call identity are generic, ephemeral policy context;
    # they are deliberately not part of the compatibility ToolContext object.
    allowed = {item.name for item in fields(ToolContext)}
    return ToolContext(**{key: value for key, value in values.items()
                          if key in allowed})


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
    #: Declarative concurrency hint; pure data, default False. True asserts the
    #: handler is a pure read with no side effects and no shared mutable state,
    #: so one model turn's consecutive safe calls may run concurrently. The run
    #: loop independently re-checks the gate policy: only tools whose gate kind
    #: never needs interactive approval can actually join a batch, and write,
    #: edit, exec, terminal, network-write, subagent and MCP tools stay serial
    #: regardless of this flag.
    concurrency_safe: bool = False
    #: Optional pure schema transformer owned by the contributing plugin. It
    #: receives the bound state directory after effective plugin filtering.
    schema_for_state: Callable[[dict, Path], dict] | None = None

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


def notify_tool_authorized(kind: str, subject: str,
                          tool_call_id: str | None = None) -> None:
    """Reserve strict pre-effect policies and notify observers after Gate.

    The registry binds the current tool and policy state around the handler.
    Strict declared policies run after Gate succeeds and before the handler's
    effect. A refusal stops the handler; observational authorization callbacks
    remain best-effort and cannot change the Gate result.
    """
    try:
        context = execution_context()
    except ValueError:
        return  # Historical low-level Gate callers have no product event context.
    tool_name = context.get('tool_name')
    session = context.get('session')
    store = context.get('store')
    state_dir = context.get('state_dir')
    if state_dir is None and store is not None:
        state_dir = getattr(store, 'directory', None)
    if (not isinstance(tool_name, str) or not tool_name
            or state_dir is None
            or context.get('tool_gate_kind') != kind):
        return
    denial = authorize_tool_effect(state_dir, session, store, tool_name, kind,
                                   subject, tool_call_id)
    if denial is not None:
        raise ToolEffectDenied(denial)
    if not isinstance(session, dict) or store is None:
        return
    try:
        from .plugin_runtime import after_tool_authorization
        after_tool_authorization(state_dir, session, store, tool_name, kind,
                                 subject, tool_call_id)
    except Exception:  # noqa: BLE001 - observation cannot change authorization.
        return


class PlanModeDenied(PermissionError):
    """计划模式的政策性拒绝：原因要回传给模型，而不是只报 ``denied``。"""

    def __init__(self, message: str, plan_draft_path: str | None = None):
        super().__init__(message)
        self.plan_draft_path = plan_draft_path


class ToolEffectDenied(Exception):
    """A strict plugin policy refused an effect after Gate authorized it."""

    def __init__(self, result):
        super().__init__('tool effect denied by plugin policy')
        self.result = result if isinstance(result, dict) else {
            'ok': False, 'error': 'tool execution policy unavailable',
            'error_code': 'tool_policy_unavailable', 'retryable': False}


def permission_result(gate, exc):
    """Distinguish a host approval pause from a policy refusal, without echoing data."""
    if isinstance(exc, PlanModeDenied):
        return {'ok': False, 'error': 'denied',
                'error_code': 'plan_mode_denied', 'awaiting_approval': False,
                'retryable': False, 'user_reason': str(exc),
                **({'plan_draft_path': exc.plan_draft_path} if exc.plan_draft_path else {})}
    waiting = bool(getattr(gate, 'web_approval_gate', False)
                   and str(exc).endswith('requires explicit approval'))
    return {'ok': False, 'error': 'denied',
            'error_code': 'approval_required' if waiting else 'permission_denied',
            'awaiting_approval': waiting, 'retryable': False,
            'user_reason': '等待你批准工具调用；批准后继续。' if waiting else '当前权限策略禁止此工具；请调整权限或任务要求。'}

@contextmanager
def bind_execution(**values):
    """Bind invocation context with one shared, generic per-execution scope."""
    parent = _EXECUTION.get()
    parent_scope = parent.get("execution_scope") if isinstance(parent, dict) else None
    if not isinstance(values.get("execution_scope"), dict):
        values["execution_scope"] = (parent_scope if isinstance(parent_scope, dict)
                                     else {})
    token = _EXECUTION.set(values)
    try:
        yield values
    finally:
        _EXECUTION.reset(token)


@contextmanager
def bind_tool_call_context(*, store, state_dir, session, tool_name,
                           gate_kind, tool_call_id, **values):
    """Bind generic identity and policy fields for a model-visible tool call."""
    try:
        bound = dict(execution_context())
    except ValueError:
        bound = {}
    bound.update(values)
    bound.update(store=store, state_dir=state_dir, session=session,
                 tool_name=tool_name, tool_gate_kind=gate_kind,
                 tool_call_id=tool_call_id)
    with bind_execution(**bound):
        yield bound


def authorize_tool_effect(state_dir, session, store, tool_name, gate_kind,
                          subject, tool_call_id=None):
    """Ask declared strict plugin policies before an authorized effect."""
    if state_dir is None:
        return None
    from .plugin_runtime import before_tool_effect
    try:
        return before_tool_effect(state_dir, session, store, tool_name,
                                  gate_kind, subject, tool_call_id)
    except ToolEffectDenied as exc:
        return exc.result
