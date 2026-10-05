"""The saved default model selection (feature ``providers.default_selection``).

Storage is the settings document's ``modelDefault`` section: plain data, atomic
write through the settings store's own lock, unknown keys preserved. Nothing
here is executable, and the section is deliberately *not* in
``settings_store.SECTION_IDS``, so the settings HTTP surface cannot write it —
only the providers API below can.

Precedence in ``provider_config.resolve``:

1. anything explicit in the request (provider id, model or reasoning effort);
2. the saved default, applied only when the caller asks for nothing at all;
3. the ``XUENESS_PROVIDER`` / ``XUENESS_API_BASE`` / ``XUENESS_MODEL`` host
   fallback, unchanged for deployments that never saved a default.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

SECTION = "modelDefault"
_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_MODEL_MAX = 200
_TEXT_MAX = 200


def _clean(value, limit=_TEXT_MAX):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("model selection values must be strings")
    text = value.strip()
    if not text:
        return None
    if len(text) > limit:
        raise ValueError("model selection value is too long")
    return text


def _normalize(record) -> dict:
    """Whitelisted view of a stored selection; ``{}`` when unusable."""
    if not isinstance(record, dict):
        return {}
    provider_id = record.get("providerId")
    model = record.get("model")
    effort = record.get("reasoningEffort")
    if not isinstance(provider_id, str) or not _ID_RE.match(provider_id) or provider_id in {".", ".."}:
        provider_id = None
    if not isinstance(model, str) or not model.strip() or len(model) > _MODEL_MAX:
        model = None
    from . import providers_api
    if not isinstance(effort, str) or effort not in providers_api.REASONING_LEVELS:
        effort = None
    if provider_id is None and model is None:
        return {}
    cleaned = {"providerId": provider_id, "model": model, "reasoningEffort": effort}
    updated = record.get("updatedAt")
    if isinstance(updated, str) and updated.strip():
        cleaned["updatedAt"] = updated.strip()
    return cleaned


def _profile_exists(state_dir, provider_id) -> bool:
    """A default that points at a deleted profile must not break every run."""
    from . import providers_api
    return providers_api.profile_record(state_dir, provider_id) is not None


def load(state_dir) -> dict:
    """The live default selection, or ``{}`` when absent or no longer resolvable."""
    from ..settings.settings_store import load_settings
    record = _normalize(load_settings(state_dir).get(SECTION))
    if record.get("providerId") and not _profile_exists(state_dir, record["providerId"]):
        return {}
    return record


def save(state_dir, selection) -> dict:
    """Validate and store the default selection; returns the stored record."""
    if not isinstance(selection, dict):
        raise ValueError("selection must be an object")
    unknown = set(selection) - {"providerId", "provider_id", "model",
                                "reasoningEffort", "reasoning_effort"}
    if unknown:
        raise ValueError("unknown selection keys: " + ", ".join(sorted(unknown)))
    provider_id = _clean(selection.get("providerId", selection.get("provider_id")), 64)
    model = _clean(selection.get("model"), _MODEL_MAX)
    effort = _clean(selection.get("reasoningEffort", selection.get("reasoning_effort")))
    if provider_id is None and model is None:
        raise ValueError("a default selection needs a provider id or a model")
    # Validate with the run's own rules so a saved default can never be a choice
    # that every later unqualified request would fail on.
    from . import provider_config
    from . import providers_api
    if provider_id is not None:
        record = providers_api.profile_record(state_dir, provider_id)
        if record is None:
            raise ValueError("provider profile not found")
        if record.get("protocol") == "anthropic" and effort is not None:
            raise ValueError("Anthropic provider does not declare reasoning-effort support")
        provider_config._validate_reasoning_effort(
            model or record.get("model"), record.get("reasoningLevels"), effort)
    else:
        provider_config._validate_reasoning_effort(model, None, effort)
    record = {"providerId": provider_id, "model": model, "reasoningEffort": effort,
              "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    from ..settings.settings_store import update_settings
    update_settings(state_dir, lambda settings: settings.__setitem__(SECTION, record))
    return dict(record)


def clear(state_dir) -> bool:
    """Remove the saved default. Returns whether one was stored."""
    from ..settings.settings_store import update_settings
    removed = {"value": False}

    def mutate(settings):
        if SECTION in settings:
            settings.pop(SECTION, None)
            removed["value"] = True

    update_settings(state_dir, mutate)
    return removed["value"]


def dispatch(method: str, rest: list, data: dict, ctx: dict):
    """``/api/providers/default``: GET reads it, POST writes or clears it."""
    if rest != ["default"]:
        return None
    state_dir = ctx["state_dir"]
    if method == "GET":
        return 200, {"default": load(state_dir) or None}
    if method != "POST":
        # DELETE stays with the profile routes: a saved profile may legitimately
        # be named "default", so this path must not hijack it.
        return None
    if not isinstance(data, dict):
        return 400, {"error": "body must be a JSON object"}
    if set(data) == {"clear"} and data["clear"] is True:
        return 200, {"default": None, "cleared": clear(state_dir)}
    try:
        return 200, {"default": save(state_dir, data)}
    except ValueError as exc:
        return 400, {"error": str(exc)}
