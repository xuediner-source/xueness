"""运行中切换模型与推理档位 (feature ``sessions.runtime_model_switch``).

Three surfaces share this one implementation:

* the chat loop's ``/model`` and ``/effort`` commands;
* ``POST /api/sessions/<sid>/model`` — the web composer and the app-server's
  ``session/setModel`` / ``session/setEffort``;
* ``GET /api/sessions/<sid>/model``, which reports the selectable levels.

A switch never interrupts the request in flight: :class:`SwitchableProvider`
applies a pending choice when the run next asks the provider for a request
method, so it takes effect on the *next* model request. Every switch leaves a
``model_history`` trace, and the profile is validated through
``provider_config`` — the very rules a run uses — before anything is stored.
"""
from __future__ import annotations

import copy
import json
import threading
from datetime import datetime, timezone

from ... import plugin_runtime, provider_config, providers_api
from ... import web as host
from ..providers.lightweight import prepare_provider

HISTORY_MAX = 50
_REQUESTED_KEYS = ("provider_id", "model", "reasoning_effort", "selection",
                   "save_default", "source", "runtime_profile")
_FIELD_ALIASES = {"providerId": "provider_id", "reasoningEffort": "reasoning_effort",
                  "runtimeProfile": "runtime_profile", "saveDefault": "save_default"}
#: The one legacy alias that means "no saved profile, use the host environment".
ENV_TARGET = "env"


def current_selection(session) -> dict:
    raw = (session or {}).get("model_selection")
    if not isinstance(raw, dict):
        return {"provider_id": None, "model": None, "reasoning_effort": None}
    return {key: (raw.get(key) if isinstance(raw.get(key), str) else None)
            for key in ("provider_id", "model", "reasoning_effort")}


def selection_record(provider_id, model, reasoning_effort) -> dict:
    """Session-shaped record; an empty model means "the profile's own default"."""
    record = {"provider_id": provider_id or None, "model": model or None}
    if reasoning_effort:
        record["reasoning_effort"] = reasoning_effort
    return record


def parse_target(text) -> tuple:
    """``provider/model`` shorthand. Saved profile ids never contain a slash, so
    the first slash splits provider from model."""
    value = (text or "").strip()
    if not value:
        raise ValueError("用法: /model <provider/model>、/model <ID> [MODEL] 或 /model list")
    if value == ENV_TARGET:
        return None, None
    if "/" in value:
        provider_id, model = (part.strip() for part in value.split("/", 1))
        if provider_id == ENV_TARGET:
            provider_id = ""
        if not provider_id and not model:
            raise ValueError("模型选择不能为空")
        return provider_id or None, model or None
    return value, None


def levels_for(state_dir, provider_id=None, model=None) -> tuple:
    """Selectable reasoning levels: profile declaration, known family, full list."""
    return providers_api.declared_reasoning_levels(state_dir, provider_id, model)


def effort_hint(state_dir, provider_id=None, model=None, current=None) -> str:
    levels = levels_for(state_dir, provider_id, model)
    if not levels:
        return "该模型未声明推理档位"
    return "可选档位: " + ", ".join(
        ("[%s]" % level if level == current else level) for level in levels)


def normalize(requested) -> tuple:
    """(fields, error) for a partial selection request from any surface."""
    fields = {}
    for key, value in (requested or {}).items():
        target = _FIELD_ALIASES.get(key, key)
        if target not in _REQUESTED_KEYS:
            return {}, "unknown selection key: " + str(key)
        fields[target] = value
    for key in ("provider_id", "model", "reasoning_effort", "selection", "runtime_profile"):
        if fields.get(key) is None:
            continue
        if not isinstance(fields[key], str):
            return {}, "%s must be a string" % key
        fields[key] = fields[key].strip() or None
    if "save_default" in fields and fields["save_default"] not in (False, True, None):
        return {}, "save_default must be a boolean"
    if fields.get("selection") is not None and (fields.get("provider_id") is not None
                                                or fields.get("model") is not None):
        return {}, "selection cannot be combined with provider_id or model"
    return fields, ""


def record_switch(session, previous, selected, source="api", effect="immediate") -> list:
    """Append one ``model_history`` entry, capped like the permission history."""
    history = session.setdefault("model_history", [])
    if not isinstance(history, list):
        history = []
        session["model_history"] = history
    history.append({"from": dict(previous or {}), "to": dict(selected or {}),
                    "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "source": source, "effect": effect})
    if len(history) > HISTORY_MAX:
        del history[:-HISTORY_MAX]
    return history


def store_default(state_dir, selection) -> dict:
    """CLI path to the providers default store: same validation, no HTTP ctx."""
    if not plugin_runtime.is_enabled(state_dir, "providers"):
        raise ValueError("需要启用 providers 插件才能保存默认模型")
    from ..providers.default_selection import save
    return save(state_dir, selection)


def _levels_text(state_dir, provider_id, model, current) -> str:
    levels = levels_for(state_dir, provider_id, model)
    head = "当前: %s %s" % (provider_id or "env", model or "")
    if not levels:
        return head + "\n该模型未声明推理档位"
    return head + "\n可选档位: " + " ".join(
        ("[%s]" % level if level == current else level) for level in levels)


def chat_switch(state_dir, command, argument, store, session, args) -> tuple:
    """One chat-loop ``/model`` or ``/effort`` line. Returns (text, provider).

    ``provider`` is the resolved client for the next run, or ``None`` to keep the
    loop's lazy preparation. The choice only takes effect on the next request; a
    turn in progress is never interrupted.
    """
    import shlex

    tokens = shlex.split(argument) if argument else []
    provider_id, model, effort = args.provider_id, args.model, args.reasoning_effort
    usage = "/effort list|<level>|save-default" if command == "/effort" else \
        "/model list|<provider/model>|ID [MODEL]|save-default；env 使用环境配置"
    if tokens and tokens[0] == "save-default" and len(tokens) == 1:
        saved = store_default(state_dir, {"providerId": provider_id, "model": model,
                                          "reasoningEffort": effort})
        return "已设为默认: %s %s %s" % (saved.get("providerId") or "env",
                                        saved.get("model") or "",
                                        saved.get("reasoningEffort") or ""), None
    if command == "/effort":
        if not tokens or tokens[0] == "list":
            return _levels_text(state_dir, provider_id, model, effort), None
        if len(tokens) != 1:
            raise ValueError("用法: " + usage)
        effort = tokens[0]
    else:
        if not tokens or tokens[0] == "list":
            profiles = providers_api._list({"state_dir": state_dir})
            current = " ".join(str(part) for part in (provider_id, model, effort) if part)
            return json.dumps({"current": current or None, "profiles": profiles},
                              ensure_ascii=False), None
        if len(tokens) == 1:
            provider_id, model = parse_target(tokens[0])
        elif len(tokens) == 2:
            provider_id, _ = parse_target(tokens[0])
            model = tokens[1] or None
        else:
            raise ValueError("用法: " + usage)
        # A new model starts at its own default level.
        effort = None
    kwargs = ({"runtime_profile": args.runtime_profile}
              if getattr(args, "runtime_profile", None) is not None else {})
    provider = provider_config.resolve(state_dir, provider_id, model,
                                       reasoning_effort=effort, **kwargs)
    args.provider_id, args.model, args.reasoning_effort = provider_id, model, effort
    if session is not None:
        selected = selection_record(provider_id, model, effort)
        record_switch(session, current_selection(session), selected, "cli", "next_run")
        session["model_selection"] = selected
        session["runtime_profile"] = kwargs.get("runtime_profile") or \
            getattr(provider, "runtime_profile", "standard")
        store.save(session)
    label = "推理档位已切换" if command == "/effort" else "模型已切换"
    target = " ".join(str(part) for part in (provider_id or "env", model, effort) if part)
    return "%s: %s" % (label, target), provider


def saved_default(ctx):
    """The providers saved default, or ``None`` — via the API, so its gate applies."""
    result = plugin_runtime.dispatch_http("GET", ["api", "providers", "default"], {}, {}, ctx)
    if result is None:
        return None
    status, payload = result
    value = payload.get("default") if status == 200 and isinstance(payload, dict) else None
    return value if isinstance(value, dict) else None


def save_default(ctx, selection) -> tuple:
    """Write the default through the providers API rather than importing its store."""
    result = plugin_runtime.dispatch_http("POST", ["api", "providers", "default"], {},
                                          dict(selection), ctx)
    if result is None:
        return 501, {"error": "providers default selection is unavailable"}
    return result


def plan_selection(previous, fields) -> tuple:
    """(provider_id, model, reasoning_effort) for a partial change request."""
    provider_id = fields.get("provider_id")
    model = fields.get("model")
    effort = fields.get("reasoning_effort")
    if fields.get("selection") is not None:
        # The shorthand replaces both halves, so "env" can clear a saved profile.
        provider_id, model = parse_target(fields["selection"])
    else:
        provider_id = previous["provider_id"] if provider_id is None else provider_id
        model = previous["model"] if model is None else model
    # A new model starts at its own default level; an effort-only change keeps
    # the model and replaces only the level.
    if effort is None and provider_id == previous["provider_id"] and model == previous["model"]:
        effort = previous["reasoning_effort"]
    return provider_id, model, effort


def apply_http(ctx, sid, requested) -> tuple:
    """Validate and store a model/effort change for one session.

    While a run owns the session lease the change goes to that run's live
    session dict and its :class:`SwitchableProvider`; the run's own lease-held
    saves persist it, so this route never writes the journal behind the
    single-writer lock.
    """
    state_dir = ctx["state_dir"]
    fields, error = normalize(requested)
    if error:
        return 400, {"error": error}
    requested_keys = {key for key in ("provider_id", "model", "reasoning_effort", "selection")
                      if fields.get(key) is not None}
    if not requested_keys:
        return 400, {"error": "nothing to change: provider_id, model, selection or reasoning_effort"}
    try:
        session = ctx["store"].load(sid)
    except (OSError, ValueError):
        return 404, {"error": "session not found"}
    with ctx["lock"]:
        switcher = ctx.get("model_switch", {}).get(sid) if sid in ctx.get("running", set()) else None
    if switcher is not None:
        session = switcher.session or session
    else:
        with ctx["lock"]:
            if sid in ctx.get("running", set()):
                return 409, {"error": "a run is active for this session; stop it before switching models"}

    previous = current_selection(session)
    try:
        provider_id, model, reasoning_effort = plan_selection(previous, fields)
    except ValueError as exc:
        return 400, {"error": str(exc)}
    try:
        provider = provider_config.resolve(
            state_dir, provider_id, model, reasoning_effort=reasoning_effort,
            **({"runtime_profile": fields["runtime_profile"]} if fields.get("runtime_profile") else {}))
    except ValueError as exc:
        return 400, {"error": provider_config.configuration_error(exc)}
    selected = selection_record(provider_id, model, reasoning_effort)
    runtime_profile = getattr(provider, "runtime_profile", "standard")

    if fields.get("save_default"):
        status, payload = save_default(ctx, {"providerId": provider_id, "model": model,
                                             "reasoningEffort": reasoning_effort})
        if status >= 400:
            return status, payload

    if switcher is not None and runtime_profile != getattr(switcher, "runtime_profile", "standard"):
        # The runtime profile is decided once per run, so a model that needs a
        # different tool protocol cannot be swapped in mid-run without leaving
        # that run half configured. Refuse instead of pretending.
        return 409, {"error": "runtime profile differs from the active run; stop this turn first"}

    source = fields.get("source") if isinstance(fields.get("source"), str) else "api"
    if switcher is not None:
        record_switch(session, previous, selected, source, "next_request")
        session["model_selection"] = selected
        session["runtime_profile"] = runtime_profile
        switcher.switch_to(selected, provider)
        with ctx["lock"]:
            live = ctx.get("running_context", {}).get(sid)
            if isinstance(live, dict):
                # Queued turns prepared against the previous model must now pause.
                live["model_selection"] = dict(selected)
        return 200, {"id": sid, "model_selection": selected, "applied": "next_request",
                     "levels": list(levels_for(state_dir, provider_id, model)),
                     "model_history": session.get("model_history", [])[-HISTORY_MAX:],
                     "default_saved": bool(fields.get("save_default"))}

    try:
        with host.lease(ctx["store"], sid):
            stored = ctx["store"].load(sid)
            if current_selection(stored) != previous:
                return 409, {"error": "model selection changed while switching; try again"}
            record_switch(stored, previous, selected, source, "immediate")
            stored["model_selection"] = selected
            stored["runtime_profile"] = runtime_profile
            ctx["store"].save(stored)
            history = stored.get("model_history", [])[-HISTORY_MAX:]
    except BlockingIOError:
        return 409, {"error": "session is in use by another process"}
    except (OSError, ValueError):
        return 500, {"error": "cannot save model selection"}
    return 200, {"id": sid, "model_selection": selected, "applied": "immediate",
                 "levels": list(levels_for(state_dir, provider_id, model)),
                 "model_history": history,
                 "default_saved": bool(fields.get("save_default"))}


def describe_http(ctx, sid) -> tuple:
    """Current selection plus the levels a client may offer."""
    try:
        session = ctx["store"].load(sid)
    except (OSError, ValueError):
        return 404, {"error": "session not found"}
    selection = current_selection(session)
    state_dir = ctx["state_dir"]
    return 200, {"id": sid,
                 "model_selection": selection,
                 "levels": list(levels_for(state_dir, selection["provider_id"], selection["model"])),
                 "runtime_profile": session.get("runtime_profile"),
                 "model_history": (session.get("model_history") or [])[-HISTORY_MAX:],
                 "default": saved_default(ctx)}


def _live_session(holder):
    """The dict a run is writing now.

    A run keeps appending turns onto a session that the WebGate repoints, so the
    gate is the durable holder; a plain dict (CLI, tests) is used as-is.
    """
    if isinstance(holder, dict):
        return holder
    session = getattr(holder, "session", None)
    return session if isinstance(session, dict) else None


class _SwitchState:
    """Pending choice shared by a run's provider facade and its private copies."""

    def __init__(self):
        self.lock = threading.RLock()
        self.pending = None
        self.provider = None


class SwitchableProvider:
    """The run's provider, re-pointable between model requests.

    Reads and writes delegate to the current adapter, so the kernel sees exactly
    what it would see without this facade: ``provider.request_deadline`` set by a
    lightweight run lands on the real adapter, and ``stream``/``complete`` keep
    their own signatures because only the object behind them changes. A pending
    switch is applied when the run next asks for a request method — never during
    one. ``copy.copy`` (the lightweight runtime's private copy) keeps following
    the same pending switch and rebuilds its copy from whichever adapter is
    current at the swap.
    """

    _OWN = frozenset({"_current", "_state", "_holder", "_session_id",
                      "_state_dir", "_prepare"})
    _REQUEST_METHODS = frozenset({"complete", "stream"})

    def __init__(self, current, state_dir, holder, session_id, prepare=None):
        object.__setattr__(self, "_current", current)
        object.__setattr__(self, "_state", _SwitchState())
        object.__setattr__(self, "_holder", holder)
        object.__setattr__(self, "_session_id", session_id)
        object.__setattr__(self, "_state_dir", state_dir)
        object.__setattr__(self, "_prepare", prepare)

    # -- attribute delegation ------------------------------------------------
    def __getattr__(self, name):
        target = object.__getattribute__(self, "_current")
        if name in SwitchableProvider._REQUEST_METHODS:
            self._apply_pending()
            target = object.__getattribute__(self, "_current")
        return getattr(target, name)

    def __setattr__(self, name, value):
        if name in SwitchableProvider._OWN:
            object.__setattr__(self, name, value)
            return
        setattr(object.__getattribute__(self, "_current"), name, value)

    def __copy__(self):
        clone = SwitchableProvider(copy.copy(object.__getattribute__(self, "_current")),
                                  object.__getattribute__(self, "_state_dir"),
                                  object.__getattribute__(self, "_holder"),
                                  object.__getattribute__(self, "_session_id"),
                                  prepare=object.__getattribute__(self, "_prepare")
                                  or prepare_provider)
        object.__setattr__(clone, "_state", object.__getattribute__(self, "_state"))
        return clone

    def __repr__(self):
        return "<SwitchableProvider %s->%r>" % (
            str(object.__getattribute__(self, "_session_id"))[:8],
            object.__getattribute__(self, "_current"))

    # -- switching -----------------------------------------------------------
    def switch_to(self, selection, provider) -> None:
        """Queue a choice for this run's next model request."""
        state = object.__getattribute__(self, "_state")
        with state.lock:
            state.pending = dict(selection or {})
            state.provider = provider

    def pending_selection(self):
        state = object.__getattribute__(self, "_state")
        with state.lock:
            return dict(state.pending) if state.pending else None

    @property
    def session(self):
        return _live_session(object.__getattribute__(self, "_holder"))

    def _apply_pending(self):
        state = object.__getattribute__(self, "_state")
        with state.lock:
            pending, raw = state.pending, state.provider
            if pending is None or raw is None:
                return
            state.pending = None
            state.provider = None
            current = object.__getattribute__(self, "_current")
            if current is raw:
                return
            # A deadline belongs to the run, not to one model.
            deadline = getattr(current, "request_deadline", None)
            prepare = object.__getattribute__(self, "_prepare")
            target = prepare(raw) if prepare is not None else raw
            if deadline is not None:
                try:
                    target.request_deadline = deadline
                except (AttributeError, TypeError):
                    pass
            object.__setattr__(self, "_current", target)
        session = self.session
        if isinstance(session, dict):
            # Provider-derived facts the run captured at its start, refreshed so
            # the rest of the run describes the model that is answering now. The
            # run's step and wall-clock limits intentionally stay as decided.
            session["model_selection"] = dict(pending)
            session["runtime_profile"] = getattr(target, "runtime_profile", "standard")
            session["tool_calling"] = getattr(target, "tool_calling", "native")


def register(ctx, sid, provider, holder) -> SwitchableProvider:
    """Expose a live run's provider so ``/api/sessions/<sid>/model`` can reach it.

    ``holder`` is the run's gate (or a session dict): it keeps pointing at the
    session the run is currently writing.
    """
    switcher = SwitchableProvider(provider, ctx["state_dir"], holder, sid)
    with ctx["lock"]:
        ctx.setdefault("model_switch", {})[sid] = switcher
    return switcher


def unregister(ctx, sid) -> None:
    with ctx["lock"]:
        ctx.get("model_switch", {}).pop(sid, None)
