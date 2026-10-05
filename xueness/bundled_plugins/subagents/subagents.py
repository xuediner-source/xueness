"""Read-only loader + prompt helpers for stored sub-agents (Stage 5 contract).

Loads the sub-agent definitions the user created in the settings page so the
main loop can (a) pick one by id/name and (b) splice its instructions into a
bounded system prompt, plus the OpenAI-style ``task`` tool schema that exposes
delegation to the model.

Like ``memory.py`` and ``skills.py`` the integration is strictly read-only:
nothing is ever written here, every file is opened with ``O_NOFOLLOW`` so a
symlink can never pull in an unrelated file, and everything loaded is
untrusted data that must never override system, task, or safety instructions.

Storage layout (Stage 2 ``resources.py`` product)::

    <state_dir>/resources/subagents/<id>.json

Each file is a JSON object with ``id``, ``name``, an optional ``enabled`` flag
(absent means enabled) and the instructions in ``systemPrompt`` (preferred),
``prompt`` or ``description``.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from ...resources import _is_link, _kind_dir

#: Hard cap (characters) on a composed system prompt.
PROMPT_MAX_CHARS = 4000
#: Name of the delegation tool exposed to the model.
TASK_TOOL_NAME = "task"
#: Marker appended when text is clipped.
TRUNCATION_SUFFIX = "\n…(truncated)"
#: Divider between the base system prompt and the sub-agent instructions.
PROMPT_SEPARATOR = "\n\n---\n\n# Sub-agent\n\n"
#: Instruction keys, most specific first.
PROMPT_KEYS = ("systemPrompt", "prompt", "description")

# These planning tools mutate durable WorkflowStore state, while Gate's
# ``planning`` kind intentionally remains readable in a parent plan session.
# Keep the exception at the child tool-name boundary so it cannot weaken or
# otherwise change the policy for normal sessions.
SUBAGENT_DENIED_TOOL_NAMES = frozenset({"workflow_create", "workflow_amend"})

TASK_DESCRIPTION = (
    "Start a focused read-only subagent in the background (up to 4 concurrent, 8 per turn). "
    "Returns a task_id, not findings. Continue independent work yourself; collect all "
    "results using task_collect and integrate them before finalizing."
)

# Persisted tool names are the same names used by the runtime tool registry.
# Resolve lazily to avoid making the read-only resource loader depend on the
# tool registry during module import.
def available_tool_names() -> frozenset[str]:
    from ...tool_registry import BUILTIN_TOOL_NAMES
    return frozenset(BUILTIN_TOOL_NAMES)


def agent_tool_allowlist(agent):
    """Return the configured tool allowlist, or ``None`` for inherited tools.

    An absent/``None`` value keeps the historical behavior. An explicitly
    stored empty list disables every built-in tool. ``["*"]`` is the explicit
    all-tools value used by the settings form when switching back to inherit.
    Unknown or malformed entries are ignored, so they can never grant tools.
    """
    if not isinstance(agent, dict) or "tools" not in agent or agent.get("tools") is None:
        return None
    values = agent.get("tools")
    if not isinstance(values, list):
        return frozenset()
    if any(isinstance(value, str) and value.strip() == "*" for value in values):
        return None
    known = available_tool_names()
    known_lower = {k.lower(): k for k in known}
    result = set()
    for value in values:
        if not isinstance(value, str):
            continue
        v = value.strip()
        if v in known:
            result.add(v)
        elif v.lower() in known_lower:
            result.add(known_lower[v.lower()])
        elif v.lower() == "websearch" and "web_search" in known:
            result.add("web_search")
    return frozenset(result)


class _ToolFilteredProvider:
    """Provider proxy that advertises only the child's permitted tools.

    Explicit profile allowlists and the sub-agent read-only exclusions are
    applied here, then every call is checked against the same exact-name
    boundary in the dispatcher.
    """

    def __init__(self, provider, allowed: frozenset[str] | None,
                 denied: frozenset[str] = SUBAGENT_DENIED_TOOL_NAMES):
        object.__setattr__(self, "_provider", provider)
        object.__setattr__(self, "_allowed", allowed)
        object.__setattr__(self, "_denied", denied)
        object.__setattr__(self, "model", getattr(provider, "model", None))
        protocol = getattr(provider, "protocol", None)
        if protocol not in ("openai", "anthropic"):
            name = type(provider).__name__
            protocol = ("anthropic" if name == "AnthropicMessages" else
                        "openai" if name == "OpenAICompatible" else None)
        object.__setattr__(self, "protocol", protocol)

    def __setattr__(self, name, value):
        # The core attaches request-local runtime settings to the provider it
        # receives. Keep the proxy transparent for those writes as well as
        # reads, so lightweight request deadlines reach the real adapter.
        if name not in {"_provider", "_allowed", "_denied", "model", "protocol"}:
            provider = self.__dict__.get("_provider")
            if provider is not None:
                setattr(provider, name, value)
        object.__setattr__(self, name, value)

    def __getattr__(self, name):
        return getattr(self._provider, name)

    def _filter(self, tools):
        return [tool for tool in tools
                if isinstance(tool, dict)
                and isinstance(tool.get("function"), dict)
                and tool["function"].get("name") not in self._denied
                and (self._allowed is None or
                     tool["function"].get("name") in self._allowed)]

    def complete(self, messages, tools):
        return self._provider.complete(messages, self._filter(tools))

    def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
        stream = getattr(self._provider, "stream", None)
        if not callable(stream):
            return self._provider.complete(messages, self._filter(tools))
        kwargs = {"on_delta": on_delta}
        try:
            import inspect
            if any(parameter.name == "on_reasoning_delta"
                   for parameter in inspect.signature(stream).parameters.values()):
                kwargs["on_reasoning_delta"] = on_reasoning_delta
        except (TypeError, ValueError):
            pass
        return stream(messages, self._filter(tools), **kwargs)


def provider_for_agent(agent, parent_provider, state_dir, parent_selection=None):
    """Resolve an optional profile/model/reasoning override for one sub-agent.

    Missing overrides preserve the already-resolved parent provider. If an
    override is present, the parent's saved selection supplies its base profile
    unless the sub-agent names a different ``providerId``.
    """
    def isolated_parent_provider():
        """Give an overlapping child its own real adapter instance.

        Configured adapters keep request settings on the instance. Lightweight
        runs, in particular, assign a per-run deadline there. Sharing one with
        a parent that is still making progress would let the child overwrite
        request state. Test doubles and third-party providers keep the historic
        identity behavior unless they opt into one of our adapter classes.
        """
        from copy import copy
        from ..providers.provider import AnthropicMessages, OpenAICompatible
        if not isinstance(parent_provider, (AnthropicMessages, OpenAICompatible)):
            return parent_provider
        clone = copy(parent_provider)
        for name in ("capabilities", "compatibility", "lightweight_options"):
            value = getattr(parent_provider, name, None)
            if isinstance(value, (dict, list, set)):
                setattr(clone, name, copy(value))
        return clone

    if not isinstance(agent, dict):
        return isolated_parent_provider()
    provider_id = agent.get("providerId")
    model = agent.get("model")
    effort = agent.get("reasoningEffort")
    for name, value in (("providerId", provider_id), ("model", model),
                        ("reasoningEffort", effort)):
        if value is not None and not isinstance(value, str):
            raise ValueError("invalid sub-agent " + name)
    if (isinstance(provider_id, str) and len(provider_id) > 64) or (
            isinstance(model, str) and len(model) > 200):
        raise ValueError("invalid sub-agent model selection")
    provider_id = provider_id.strip() if isinstance(provider_id, str) else ""
    model = model.strip() if isinstance(model, str) else ""
    effort = effort.strip() if isinstance(effort, str) else ""
    if not (provider_id or model or effort):
        return isolated_parent_provider()

    inherited = parent_selection if isinstance(parent_selection, dict) else {}
    if provider_id:
        selected_provider = provider_id
        selected_model = model or None
    else:
        inherited_provider = inherited.get("provider_id")
        inherited_model = inherited.get("model")
        selected_provider = inherited_provider if isinstance(inherited_provider, str) else None
        selected_model = model or (inherited_model if isinstance(inherited_model, str) else None)

    # If an older session has no persisted profile identity, changing only the
    # effort setting should retain the live parent's profile. Modern sessions
    # carry model_selection and use the provider resolver below.
    if not selected_provider and not selected_model and model:
        selected_model = model
    if not selected_provider and not isinstance(inherited.get("model"), str) and not provider_id:
        if model or effort:
            from ..providers.provider import AnthropicMessages, OpenAICompatible
            from copy import copy
            clone = copy(parent_provider)
            if isinstance(clone, OpenAICompatible):
                clone.model = model or clone.model
                clone.reasoning_effort = effort or None
                if effort:
                    from ..providers.providers_api import known_reasoning_levels
                    if effort not in known_reasoning_levels(clone.model):
                        raise ValueError("selected model does not declare support for reasoning effort " + effort)
                return clone
            if isinstance(clone, AnthropicMessages):
                if effort:
                    raise ValueError("Anthropic provider does not support reasoning effort")
                clone.model = model or clone.model
                return clone

    from ..providers.provider_config import resolve
    return resolve(state_dir, selected_provider or None, selected_model,
                   reasoning_effort=effort or None)


def normalize_disallowed_tools(disallowed) -> set[str]:
    """Extract and normalize disallowed tool names, stripping rule arguments and normalizing case."""
    if not disallowed or not isinstance(disallowed, (list, tuple, set, frozenset)):
        return set()
    normalized = set()
    for item in disallowed:
        if not isinstance(item, str):
            continue
        trimmed = item.strip()
        if not trimmed:
            continue
        paren_idx = trimmed.find("(")
        base = trimmed[:paren_idx].strip() if paren_idx > 0 else trimmed
        if base:
            normalized.add(base)
            normalized.add(base.lower())
            if base.lower() == "websearch":
                normalized.add("web_search")
    return normalized


def provider_with_agent_tools(provider, agent, *, denied=(), parent_allowed=None):
    """Apply the explicit allowlist and hard read-only exceptions to a child.

    Inherit-all and explicit-all keep their full dynamic tool set (such as
    task/MCP schemas), except for durable workflow creation and amendment.
    """
    allowed = agent_tool_allowlist(agent)
    agent_denied = set(denied or ())
    if isinstance(agent, dict):
        disallowed = agent.get("disallowedTools") or agent.get("disallowed_tools") or ()
        agent_denied.update(normalize_disallowed_tools(disallowed))
    if parent_allowed is not None:
        inherited = frozenset(parent_allowed)
        allowed = inherited if allowed is None else allowed.intersection(inherited)
    if allowed is not None and agent_denied:
        allowed = allowed - agent_denied
    return _ToolFilteredProvider(
        provider, allowed,
        SUBAGENT_DENIED_TOOL_NAMES | frozenset(agent_denied),
    )


def clip(text: str, max_chars: int) -> str:
    """Trim to at most ``max_chars`` characters, keeping a truncation marker."""
    t = str(text)
    if not max_chars or len(t) <= max_chars:
        return t
    keep = max(0, max_chars - len(TRUNCATION_SUFFIX))
    if keep == 0:
        return TRUNCATION_SUFFIX[:max_chars]
    return t[:keep].rstrip() + TRUNCATION_SUFFIX


def _subagents_dir(state_dir) -> Path:
    return Path(state_dir) / "resources" / "subagents"


def _safe_read_json(path: Path):
    """Read one sub-agent file, refusing symlinks (``O_NOFOLLOW``).

    A symlinked entry, a file that is not valid JSON, an unreadable file, and
    a JSON document that is not an object all yield ``None`` so one broken
    entry can never take down the rest of the list or echo back a foreign file.
    """
    if _is_link(path):
        return None
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def load(state_dir) -> list:
    """Every usable sub-agent under ``state_dir``, in ascending id order.

    Skips symlinked entries and a symlinked directory, ``enabled == False``
    (absent counts as enabled), and entries whose ``id`` or ``name`` is not a
    non-empty string. The returned dicts carry whitespace-normalized ``id``
    and ``name`` so :func:`select` can match them exactly.
    """
    try:
        subagents_dir = _kind_dir({"state_dir": state_dir}, "subagents")
    except (OSError, ValueError):
        return []
    # A symlinked directory would relocate the whole jail; refuse it outright.
    if _is_link(subagents_dir):
        return []
    if not subagents_dir.is_dir():
        return []
    items = []
    for path in sorted(subagents_dir.glob("*.json")):
        if _is_link(path):
            continue
        item = _safe_read_json(path)
        if item is None:
            continue
        sid = item.get("id")
        name = item.get("name")
        if not isinstance(sid, str) or not sid.strip():
            continue
        if not isinstance(name, str) or not name.strip():
            continue
        if item.get("enabled") is False:
            continue
        entry = dict(item)
        entry["id"] = sid.strip()
        entry["name"] = name.strip()
        items.append(entry)
    items.sort(key=lambda entry: entry["id"])
    return items


def select(agents, name):
    """Return the agent whose ``id`` or ``name`` equals ``name``, else ``None``.

    A non-string or blank ``name`` never matches. The first hit wins, so the
    caller's ordering (see :func:`load`) decides ties. Fallback to built-in
    profiles matches ZCode built-in profiles.
    """
    if not isinstance(name, str) or not name.strip():
        return None
    if not isinstance(agents, (list, tuple)):
        agents = ()
    clean = name.strip().lower()
    for agent in agents:
        if not isinstance(agent, dict):
            continue
        aid = str(agent.get("id") or "").strip()
        aname = str(agent.get("name") or "").strip()
        if aid == name or aname == name or aid.lower() == clean or aname.lower() == clean:
            return agent
    if clean in ("general-purpose", "general_purpose"):
        return {
            "id": "general-purpose",
            "name": "general-purpose",
            "description": "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
            "tools": ["*"],
        }
    if clean == "explore":
        return {
            "id": "explore",
            "name": "explore",
            "description": "Read-only exploration agent for fast code search and directory inspection.",
            "tools": ["read", "list", "glob", "grep", "web_fetch", "web_search", "todo_read", "todo_write"],
        }
    return None


def _agent_prompt_text(agent) -> str:
    """The agent's instructions: ``systemPrompt`` → ``prompt`` → ``description``."""
    if not isinstance(agent, dict):
        return ""
    for key in PROMPT_KEYS:
        value = agent.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def build_system_prompt(agent, base_system: str) -> str:
    """``base_system`` + separator + the agent's instructions.

    Returns ``base_system`` untouched when the agent carries no usable text,
    and clips the composed prompt to :data:`PROMPT_MAX_CHARS` otherwise.
    """
    base = base_system if isinstance(base_system, str) else ""
    text = _agent_prompt_text(agent)
    if not text:
        return base
    return clip(base + PROMPT_SEPARATOR + text, PROMPT_MAX_CHARS)


def task_tool_schema() -> dict:
    """A fresh OpenAI-style function schema for the delegation tool."""
    return {
        "type": "function",
        "function": {
            "name": TASK_TOOL_NAME,
            "description": TASK_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                    "agent": {"type": "string"},
                },
                "required": ["prompt"],
                "additionalProperties": False,
            },
        },
    }
