"""Model provider configuration API (Stage 2 contract, section 3).

Standard library only.

Security properties enforced here:

* The api key is **never** echoed back. Every response body is built from an
  explicit field whitelist, so ``apiKey`` cannot leak by accident; clients
  only ever see ``hasKey: bool``.
* Keys land in ``<state_dir>/providers/<id>.json`` written atomically
  (``tempfile.mkstemp`` + ``fsync`` + ``os.replace``) with POSIX mode
  ``0o600`` or a protected Windows DACL limited to trusted system principals.
* Every user-supplied identifier is regex-whitelisted and the resolved target
  must stay inside ``<state_dir>/providers`` (path jail).
* Symlinks are refused outright: a symlinked ``providers`` directory would
  silently redirect the jail outside ``state_dir``, and a symlinked
  ``<id>.json`` would let an unrelated file be read back through the API.
  Directory containment is checked **before** any ``resolve()`` on the target,
  and file reads use ``O_NOFOLLOW``.
"""
from __future__ import annotations

import json
import hashlib
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from .runtime_options import public_runtime_options, resolve_runtime_options, validate_compatibility
from .lightweight_config import validate_options
from ...resources import _is_link, _protect_private_file, replace_file

ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# Dot-only names are legal for the regex but are traversal/parent markers.
RESERVED_IDS = frozenset({".", ".."})
DIR_MODE = 0o700
SUBDIR = "providers"
REQUIRED_TEXT_FIELDS = ("name", "baseUrl", "model")
_PUBLIC_FIELDS = ("id", "name", "baseUrl", "model")
REASONING_LEVELS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
ARK_CODING_PLAN_REASONING_LEVELS = ("low", "medium", "high")
ARK_CODING_PLAN_DEEPSEEK_MODEL = "deepseek-v4.1-flash"
CONNECTION_TEST_TIMEOUT_SECONDS = 8.0
MODEL_DISCOVERY_TIMEOUT_SECONDS = 8.0
COMPATIBILITY_TEST_TIMEOUT_SECONDS = 120.0
COMPATIBILITY_TEST_MODES = frozenset({
    "conversation", "native_tool_call", "json_tool_call", "stream", "tool_roundtrip", "json_tool_roundtrip",
})
COMPATIBILITY_STEPS = frozenset({
    "conversation", "native_tool_call", "json_tool_call", "stream", "tool_result_followup",
})
COMPATIBILITY_SAFE_ERRORS = frozenset({
    "The provider returned no assistant text.",
    "The provider did not return exactly one function call.",
    "The provider returned an invalid function-call envelope.",
    "The provider returned an invalid function-call ID.",
    "The provider returned an unexpected function name or shape.",
    "The provider returned invalid function arguments.",
    "The provider returned arguments outside the required {a: 3, b: 4} schema.",
    "The provider returned no bounded JSON tool-call response.",
    "The provider did not return strict JSON.",
    "The provider returned JSON outside the required function name and argument schema.",
    "The endpoint did not return an SSE event stream.",
    "The SSE stream contained no assistant text delta.",
    "The provider did not echo the deterministic tool-result receipt.",
    "The endpoint rejected one or more request fields (HTTP 400). Change compatibility options explicitly and rerun this check.",
    "The provider compatibility request failed (details suppressed).",
    "Unsupported provider compatibility test mode.",
})

# A profile's key is preserved when an edit omits apiKey. Protect that
# read/merge/write transaction, as well as deletes and resolved snapshots.
# This lock is shared with provider_config.resolve; it is deliberately released
# before any network request so a slow provider cannot block credential edits.
PROVIDER_STORE_LOCK = threading.RLock()


def known_reasoning_levels(model):
    """Conservative reasoning settings for model families documented by OpenAI."""
    if not isinstance(model, str):
        return ()
    name = model.strip().casefold()
    # Keep inference to model families whose current official guidance names
    # these levels. Custom/older aliases can declare their own supported list
    # on the saved profile instead of inheriting guesses.
    if any(name == prefix or name.startswith(prefix + "-")
           for prefix in ("gpt-6-astra", "gpt-6-sol", "gpt-6-luna")):
        return ("low", "medium", "high", "xhigh", "max")
    if any(name == prefix or name.startswith(prefix + "-") for prefix in ("o3", "o4")):
        return ("low", "medium", "high")
    return ()


def reasoning_levels_for_provider(model, base_url=None, configured=None):
    """Return supported levels from an explicit declaration or trusted endpoint.

    Coding Plan's DeepSeek alias is deliberately scoped by both the official
    HTTPS endpoint and exact model name. A profile declaration takes priority,
    including an explicit empty list, so operators can override inferred
    capability data. Generic model-family inference remains unchanged.
    """
    if configured is not None:
        if not isinstance(configured, list):
            return ()
        return tuple(level for level in configured
                     if isinstance(level, str) and level in REASONING_LEVELS)

    if _is_ark_coding_plan_deepseek_flash(model, base_url):
        return ARK_CODING_PLAN_REASONING_LEVELS
    return known_reasoning_levels(model)


def _is_ark_coding_plan_deepseek_flash(model, base_url):
    if (not isinstance(model, str)
            or model.strip().casefold() != ARK_CODING_PLAN_DEEPSEEK_MODEL):
        return False
    if not isinstance(base_url, str):
        return False
    try:
        parsed = urlsplit(base_url.strip())
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme.casefold() == "https"
        and (parsed.hostname or "").casefold() == "ark.cn-beijing.volces.com"
        and port in (None, 443)
        and parsed.username is None
        and parsed.password is None
        and parsed.path in ("/api/coding/v3", "/api/coding/v3/")
        and not parsed.query
        and not parsed.fragment
    )


def profile_record(state_dir, provider_id):
    """One saved profile record, under the same jail as every other profile read."""
    if not isinstance(provider_id, str) or not _valid_id(provider_id):
        return None
    try:
        with PROVIDER_STORE_LOCK:
            path = _path_for(_providers_dir({"state_dir": state_dir}), provider_id)
            return _read_record(path) if path else None
    except (OSError, ValueError):
        return None


def declared_reasoning_levels(state_dir, provider_id=None, model=None):
    """Levels to offer for a choice: profile declaration, known family, full whitelist.

    Callers that *validate* a request must not use this: an undeclared profile
    means "no evidence", and ``_validate_reasoning_effort`` deliberately refuses
    a level it cannot point at. Offering is allowed to fall back to the shared
    whitelist so ``/effort list`` still shows what can be typed.
    """
    record = profile_record(state_dir, provider_id) if provider_id else None
    effective_model = model or (record or {}).get("model")
    if isinstance(record, dict) and "reasoningLevels" in record:
        return reasoning_levels_for_provider(
            effective_model, record.get("baseUrl"), record.get("reasoningLevels"))
    known = reasoning_levels_for_provider(
        effective_model, (record or {}).get("baseUrl"))
    if known:
        return known
    return REASONING_LEVELS


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _within(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def _providers_dir(ctx: dict) -> Path:
    """``<state_dir>/providers``, jailed to ``state_dir``.

    ``state_dir`` is resolved first (so a symlinked tmp root is fine), but the
    providers directory itself must **not** be a symlink: if it were, every
    path built from it would live outside ``state_dir`` while still looking
    contained, which silently defeats the jail.
    """
    state_dir = Path(ctx["state_dir"]).resolve()
    directory = state_dir / SUBDIR
    if _is_link(directory):
        raise ValueError("providers directory must not be a symlink, junction, or reparse point")
    if not _within(directory, state_dir):
        raise ValueError("providers directory escapes state dir")
    return directory


def _path_for(directory: Path, pid: str) -> Path | None:
    """Jailed path for ``<id>.json``; ``None`` when it escapes the jail.

    ``pid`` is already regex-whitelisted (no separators, not ``.``/``..``), so
    the only remaining escape hatch is an existing symlink at that name.
    """
    candidate = directory / f"{pid}.json"
    if _is_link(candidate):
        return None
    if candidate.parent != directory or candidate.name != f"{pid}.json":
        return None
    return candidate


def _valid_id(value) -> bool:
    """Regex whitelist plus an explicit reject of the ``.`` / ``..`` markers."""
    return (
        isinstance(value, str)
        and bool(ID_RE.match(value))
        and value not in RESERVED_IDS
    )


def _valid_base_url(value) -> bool:
    """True only for an absolute ``http://`` / ``https://`` URL."""
    if not isinstance(value, str):
        return False
    raw = value.strip()
    if not raw:
        return False
    try:
        parts = urlsplit(raw)
        # Match the adapter's accepted endpoint shape. Credentials in URL
        # userinfo or query parameters would otherwise be echoed in the public
        # profile summary even though adapter construction later rejects them.
        parts.port  # Validate malformed ports before persisting the profile.
    except ValueError:
        return False
    if parts.scheme not in ("http", "https"):
        return False
    return (bool(parts.hostname and parts.netloc)
            and parts.username is None and parts.password is None
            and not parts.query and not parts.fragment)


def _clean_text(value) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _public_base_url(value) -> str:
    """Strip legacy URL credentials and query secrets from public summaries."""
    if not isinstance(value, str):
        return ""
    try:
        parts = urlsplit(value)
        if (parts.username is None and parts.password is None
                and not parts.query and not parts.fragment):
            return value
        hostname = parts.hostname
        if not hostname:
            return ""
        port = parts.port
    except ValueError:
        return ""
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    netloc = hostname + (f":{port}" if port is not None else "")
    return f"{parts.scheme}://{netloc}{parts.path}"


def _public(record: dict) -> dict:
    """Whitelisted view: the api key can never be part of this dict."""
    result = {
        "id": record.get("id", ""),
        "name": record.get("name", ""),
        "baseUrl": _public_base_url(record.get("baseUrl", "")),
        "model": record.get("model", ""),
        "hasKey": bool(record.get("apiKey")),
    }
    # Keep the original response schema byte-for-byte for default profiles.
    # The non-default protocol is surfaced only when it is needed to render an
    # editable Anthropic profile in clients that understand it.
    if record.get("protocol") == "anthropic":
        result["protocol"] = "anthropic"
    if record.get("capabilities"):
        result["capabilities"] = list(record["capabilities"])
    declared_levels = "reasoningLevels" in record
    levels = record.get("reasoningLevels")
    if declared_levels:
        if (not isinstance(levels, list)
                or any(item not in REASONING_LEVELS for item in levels)
                or len(set(levels)) != len(levels)):
            levels = None
    elif record.get("protocol", "openai") == "openai":
        levels = reasoning_levels_for_provider(record.get("model"), record.get("baseUrl"))
    # Keep the historical public shape for models whose capabilities are not
    # declared and cannot be inferred. An explicit [] remains meaningful: it
    # says the operator has disabled reasoning for this profile.
    if levels is not None and (declared_levels or bool(levels)):
        result["reasoningLevels"] = list(levels)
    result.update(public_runtime_options(record))
    diagnostics = record.get("_compatibilityDiagnostics")
    revision = record.get("_profileRevision")
    if isinstance(diagnostics, dict) and isinstance(revision, str):
        groups = []
        for options_hash, group in diagnostics.items():
            if (not isinstance(options_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", options_hash)
                    or not isinstance(group, dict) or group.get("profileRevision") != revision):
                continue
            try:
                options = validate_compatibility(group.get("compatibility"))
            except (TypeError, ValueError):
                continue
            if _compatibility_hash(options) != options_hash:
                continue
            checks = []
            for mode, check in (group.get("checks") or {}).items():
                safe = _public_check(mode, check)
                if safe is not None:
                    checks.append(safe)
            groups.append({"optionsHash": options_hash, "compatibility": options,
                           "checks": sorted(checks, key=lambda item: item["mode"])})
        if groups:
            result["compatibilityDiagnostics"] = groups[-8:]
    verification = record.get("_compatibilityVerification")
    if (isinstance(verification, dict) and verification.get("profileRevision") == revision
            and isinstance(verification.get("optionsHash"), str)
            and _compatibility_hash(record.get("compatibility", {})) == verification.get("optionsHash")):
        safe_checks = [_public_check(item.get("mode"), item)
                       for item in verification.get("checks", []) if isinstance(item, dict)]
        result["compatibilityVerification"] = {
            "verifiedAt": verification.get("verifiedAt"),
            "optionsHash": verification["optionsHash"],
            "checks": [item for item in safe_checks if item is not None],
        }
    return result


def _compatibility_hash(options) -> str:
    clean = validate_compatibility(options)
    canonical = json.dumps(clean, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _required_compatibility_modes(record):
    tool_mode = "json_tool_roundtrip" if record.get("toolCalling") == "json" else "tool_roundtrip"
    return ("conversation", "stream", tool_mode)


def _safe_compatibility_error(value):
    """Keep only adapter-owned diagnostics; never persist arbitrary response text."""
    if isinstance(value, str) and value in COMPATIBILITY_SAFE_ERRORS:
        return value
    return "The provider compatibility request failed (details suppressed)."


def _compatibility_result_has_proof(mode, result):
    """Require mode-specific evidence before recording a passing check."""
    details = result.get("details") if isinstance(result, dict) else None
    if not isinstance(details, dict) or details.get("mode") != mode:
        return False
    expected_count = 2 if mode in ("tool_roundtrip", "json_tool_roundtrip") else 1
    if details.get("requestCount") != expected_count or type(details.get("requestCount")) is not int:
        return False
    requests = details.get("requests")
    expected_steps = {
        "conversation": ["conversation"],
        "native_tool_call": ["native_tool_call"],
        "json_tool_call": ["json_tool_call"],
        "stream": ["stream"],
        "tool_roundtrip": ["native_tool_call", "tool_result_followup"],
        "json_tool_roundtrip": ["json_tool_call", "tool_result_followup"],
    }.get(mode)
    if not isinstance(requests, list) or len(requests) != expected_count:
        return False
    if [item.get("step") if isinstance(item, dict) else None for item in requests] != expected_steps:
        return False
    for item in requests:
        fields = item.get("fields")
        if (not isinstance(fields, list)
                or any(not isinstance(field, str)
                       or not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", field)
                       for field in fields)
                or "messages" not in fields or "model" not in fields):
            return False
    arguments = details.get("arguments")
    valid_arguments = (type(arguments) is dict and set(arguments) == {"a", "b"}
                       and type(arguments.get("a")) is int and arguments["a"] == 3
                       and type(arguments.get("b")) is int and arguments["b"] == 4)
    if mode == "conversation":
        fields = requests[0]["fields"]
        return (details.get("assistantTextReceived") is True
                and "tools" not in fields and "stream" not in fields)
    if mode in ("native_tool_call", "json_tool_call"):
        flag = "jsonToolCallValidated" if mode == "json_tool_call" else "toolCallValidated"
        fields = requests[0]["fields"]
        request_shape = (("tools" in fields and "stream" not in fields)
                         if mode == "native_tool_call"
                         else ("tools" not in fields and "stream" not in fields))
        return (request_shape and details.get(flag) is True
                and details.get("toolName") == "xueness_fixture_add"
                and valid_arguments
                and details.get("fixtureExecuted") is False)
    if mode == "stream":
        return ("stream" in requests[0]["fields"] and "tools" not in requests[0]["fields"]
                and details.get("sseContentType") is True
                and details.get("doneReceived") is True
                and type(details.get("deltaCount")) is int and details["deltaCount"] > 0
                and type(details.get("deltaCharacters")) is int and details["deltaCharacters"] > 0)
    if mode in ("tool_roundtrip", "json_tool_roundtrip"):
        json_mode = mode == 'json_tool_roundtrip'
        return (all("stream" in item["fields"] and (('tools' not in item['fields']) if json_mode else ('tools' in item['fields'])) for item in requests)
                and (not json_mode or details.get('jsonToolCallValidated') is True)
                and details.get("toolCallValidated") is True
                and details.get("toolResultFollowupValidated") is True
                and details.get("toolName") == "xueness_fixture_add"
                and valid_arguments
                and details.get("fixtureExecuted") is True
                and details.get("sseContentType") is True
                and details.get("doneReceived") is True
                and type(details.get("deltaCount")) is int and details["deltaCount"] > 0
                and type(details.get("deltaCharacters")) is int and details["deltaCharacters"] > 0)
    return False


def _public_check(mode, check):
    if not isinstance(mode, str) or mode not in COMPATIBILITY_TEST_MODES or not isinstance(check, dict):
        return None
    if type(check.get("ok")) is not bool:
        return None
    safe = {"mode": mode, "ok": check["ok"]}
    for field in ("testedAt", "error"):
        value = check.get(field)
        if isinstance(value, str):
            if field == "error":
                safe[field] = _safe_compatibility_error(value)
            else:
                safe[field] = value[:80]
    for field in ("requestCount", "latencyMs", "httpStatus", "failedStep"):
        value = check.get(field)
        if ((field == "failedStep" and isinstance(value, str) and value in COMPATIBILITY_STEPS) or
                (field == "httpStatus" and type(value) is int and 100 <= value <= 599) or
                (field in ("requestCount", "latencyMs") and type(value) is int and 0 <= value <= 100000)):
            safe[field] = value
    details = check.get("details")
    if isinstance(details, dict):
        safe_details = {}
        for field in ("assistantTextReceived", "toolCallValidated", "jsonToolCallValidated", "toolResultFollowupValidated",
                      "sseContentType", "doneReceived", "fixtureExecuted"):
            value = details.get(field)
            if type(value) is bool:
                safe_details[field] = value
        if type(details.get("requestCount")) is int and 0 <= details["requestCount"] <= 100000:
            safe_details["requestCount"] = details["requestCount"]
        if type(details.get("httpStatus")) is int and 100 <= details["httpStatus"] <= 599:
            safe_details["httpStatus"] = details["httpStatus"]
        if isinstance(details.get("failedStep"), str) and details["failedStep"] in COMPATIBILITY_STEPS:
            safe_details["failedStep"] = details["failedStep"]
        for field in ("deltaCount", "deltaCharacters"):
            value = details.get(field)
            if type(value) is int and 0 <= value <= 100000:
                safe_details[field] = value
        requests = details.get("requests")
        if isinstance(requests, list):
            safe_details["requests"] = [
                {"step": item["step"][:80],
                 "fields": [field[:80] for field in item["fields"][:32]
                            if isinstance(field, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,79}", field)]}
                for item in requests[:3]
                if isinstance(item, dict) and isinstance(item.get("step"), str)
                and item["step"] in COMPATIBILITY_STEPS
                and isinstance(item.get("fields"), list)
            ]
        if safe_details:
            safe["details"] = safe_details
    return safe


def _stored_check(mode, result, tested_at):
    details = result.get("details") if isinstance(result.get("details"), dict) else {}
    public = _public_check(mode, {"ok": bool(result.get("ok")), "details": details}) or {}
    request_count = details.get("requestCount")
    stored = {"ok": bool(result.get("ok")), "testedAt": tested_at,
              "requestCount": request_count if type(request_count) is int and 0 <= request_count <= 100000 else 0,
              "details": public.get("details", {})}
    latency = result.get("latencyMs")
    if type(latency) is int and 0 <= latency <= 24 * 60 * 60 * 1000:
        stored["latencyMs"] = latency
    if isinstance(result.get("error"), str):
        stored["error"] = _safe_compatibility_error(result["error"])
    if type(details.get("httpStatus")) is int and 100 <= details["httpStatus"] <= 599:
        stored["httpStatus"] = details["httpStatus"]
    if isinstance(details.get("failedStep"), str) and details["failedStep"] in COMPATIBILITY_STEPS:
        stored["failedStep"] = details["failedStep"]
    return stored


def _read_record(path: Path) -> dict | None:
    """Read a provider record, refusing symlinks/reparse points and nofollow."""
    if _is_link(path):
        return None
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            raw = json.load(stream)
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    try:
        resolve_runtime_options(raw, raw.get("protocol", "openai"))
    except (ValueError, TypeError):
        return None
    return raw


def _atomic_write(path: Path, payload: dict) -> None:
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, DIR_MODE)
    except OSError:
        pass
    fd, tmp = tempfile.mkstemp(prefix=".provider-", dir=str(directory))
    try:
        try:
            _protect_private_file(fd)
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        replace_file(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _list(ctx: dict) -> list:
    directory = _providers_dir(ctx)
    out: list = []
    if not directory.is_dir():
        return out
    for entry in sorted(directory.glob("*.json")):
        if _is_link(entry):
            continue
        record = _read_record(entry)
        if record is None:
            continue
        pid = record.get("id")
        if not _valid_id(pid):
            continue
        out.append(_public(record))
    out.sort(key=lambda item: item["id"])
    return out


# --------------------------------------------------------------------------
# handlers
# --------------------------------------------------------------------------

def _handle_save(ctx: dict, data) -> tuple:
    if not isinstance(data, dict):
        return 400, {"error": "body must be a JSON object"}
    pid = data.get("id")
    if not _valid_id(pid):
        return 400, {"error": "id must match ^[A-Za-z0-9._-]{1,64}$"}

    values: dict = {}
    for field in REQUIRED_TEXT_FIELDS:
        text = _clean_text(data.get(field))
        if text is None:
            return 400, {"error": f"{field} is required"}
        values[field] = text

    with PROVIDER_STORE_LOCK:
        existing_path = _path_for(_providers_dir(ctx), pid)
        existing = _read_record(existing_path) if existing_path and existing_path.exists() else None
        protocol = data.get("protocol", (existing or {}).get("protocol", "openai"))
        if protocol not in ("openai", "anthropic"):
            return 400, {"error": "protocol must be openai or anthropic"}

        runtime_record = {"protocol": protocol}
        for field in ("runtimeProfile", "contextWindow", "maxOutputTokens", "toolCalling"):
            if field in data:
                runtime_record[field] = data[field]
            elif existing is not None and field in existing:
                runtime_record[field] = existing[field]
        if "compatibility" in data:
            submitted_compatibility = data["compatibility"]
            try:
                submitted_compatibility = validate_compatibility(submitted_compatibility)
                if submitted_compatibility and existing and isinstance(existing.get("compatibility"), dict):
                    prior_compatibility = validate_compatibility(existing["compatibility"])
                    prior_compatibility.update(submitted_compatibility)
                    submitted_compatibility = prior_compatibility
            except (ValueError, TypeError) as exc:
                return 400, {"error": str(exc)}
            runtime_record["compatibility"] = submitted_compatibility
        elif existing is not None and "compatibility" in existing:
            runtime_record["compatibility"] = existing["compatibility"]
        if 'lightweightOptions' in data:
            try:
                submitted = validate_options(data['lightweightOptions'], protocol)
                runtime_record['lightweightOptions'] = submitted
            except (ValueError, TypeError) as exc:
                return 400, {'error': str(exc)}
        elif existing is not None and 'lightweightOptions' in existing:
            runtime_record['lightweightOptions'] = existing['lightweightOptions']
        try:
            resolve_runtime_options(runtime_record, protocol)
        except (ValueError, TypeError) as exc:
            return 400, {"error": str(exc)}

        capabilities = data.get("capabilities", (existing or {}).get("capabilities"))
        if capabilities is not None:
            if (not isinstance(capabilities, list) or len(capabilities) > 3
                    or any(item not in ("image", "pdf", "video") for item in capabilities)
                    or len(set(capabilities)) != len(capabilities)):
                return 400, {"error": "capabilities must be unique image/pdf/video values"}
        reasoning_levels = data.get("reasoningLevels", (existing or {}).get("reasoningLevels"))
        if protocol == "anthropic":
            if "reasoningLevels" in data and data["reasoningLevels"] is not None:
                return 400, {"error": "reasoningLevels are supported only for OpenAI-compatible providers"}
            # Changing an existing profile from OpenAI to Anthropic clears its old
            # OpenAI-only declaration rather than persisting an invalid empty list.
            reasoning_levels = None
        if reasoning_levels is not None:
            if (not isinstance(reasoning_levels, list) or len(reasoning_levels) > len(REASONING_LEVELS)
                    or any(item not in REASONING_LEVELS for item in reasoning_levels)
                    or len(set(reasoning_levels)) != len(reasoning_levels)):
                return 400, {"error": "reasoningLevels must contain unique supported reasoning values"}

        if not _valid_base_url(values["baseUrl"]):
            return 400, {"error": "baseUrl must start with http:// or https://"}

        directory = _providers_dir(ctx)
        path = _path_for(directory, pid)
        if path is None:
            return 400, {"error": "invalid id"}

        if "apiKey" in data:
            api_key = data["apiKey"]
            if not isinstance(api_key, str):
                return 400, {"error": "apiKey must be a string"}
        else:
            previous = existing.get("apiKey") if existing else None
            api_key = previous if isinstance(previous, str) else ""

        record = {"id": pid}
        record.update(values)
        for field in ("runtimeProfile", "contextWindow", "maxOutputTokens", "toolCalling"):
            if field in runtime_record:
                record[field] = runtime_record[field]
        if "compatibility" in runtime_record:
            record["compatibility"] = dict(runtime_record["compatibility"])
        if 'lightweightOptions' in runtime_record:
            record['lightweightOptions'] = dict(runtime_record['lightweightOptions'])
        if protocol == "anthropic":
            record["protocol"] = protocol
        if capabilities:
            record["capabilities"] = sorted(capabilities)
        if reasoning_levels is not None:
            record["reasoningLevels"] = list(reasoning_levels)
        if api_key:
            record["apiKey"] = api_key
        # Any explicit profile save changes the identity against which tests
        # were performed. Diagnostics are retained only until this point and
        # are cleared with a fresh opaque revision nonce.
        record["_profileRevision"] = uuid.uuid4().hex

        try:
            _atomic_write(path, record)
        except OSError as exc:
            # e.g. the name is already a directory: client-shaped problem, not a 500.
            return 400, {"error": "could not persist provider: %s" % (exc.strerror or exc.__class__.__name__)}
        return 200, {"provider": _public(record)}


def _handle_delete(ctx: dict, pid: str) -> tuple:
    if not _valid_id(pid):
        return 400, {"error": "id must match ^[A-Za-z0-9._-]{1,64}$"}
    with PROVIDER_STORE_LOCK:
        directory = _providers_dir(ctx)
        path = _path_for(directory, pid)
        if path is None:
            return 400, {"error": "invalid id"}
        if not path.is_file():
            return 404, {"error": "provider not found"}
        try:
            path.unlink()
        except OSError:
            return 404, {"error": "provider not found"}
        return 200, {"ok": True, "id": pid}


def _handle_connection_test(ctx: dict, data) -> tuple:
    """Verify a saved profile with one explicit, bounded model request.

    The browser may identify a profile, but cannot provide an endpoint, model,
    or key. Credentials are read only from the jailed provider store, and the
    result contains an allowlisted profile summary rather than provider text.
    """
    if ctx.get("allow_real") is not True:
        return 403, {"error": "real model requests are disabled by the server"}
    if not isinstance(data, dict) or set(data) != {"id"}:
        return 400, {"error": "expected provider id only"}
    pid = data.get("id")
    if not _valid_id(pid):
        return 400, {"error": "invalid provider id"}

    from . import provider_config
    try:
        with PROVIDER_STORE_LOCK:
            summary = next((item for item in _list(ctx) if item.get("id") == pid), None)
            if summary is None:
                return 404, {"error": "provider profile not found"}
            # Resolve one consistent saved-profile snapshot under the store lock;
            # release it before the paid network request below.
            provider = provider_config.resolve(ctx["state_dir"], pid)
    except ValueError as exc:
        return 400, {"error": provider_config.configuration_error(exc)}
    except (OSError, KeyError):
        return 400, {"error": "provider profile is unavailable"}

    test_call = getattr(provider, "test_connection", None)
    if not callable(test_call):
        return 400, {"error": "provider protocol does not support connection tests"}
    started = time.monotonic()
    try:
        reply = test_call(timeout=CONNECTION_TEST_TIMEOUT_SECONDS)
        if not isinstance(reply, dict):
            raise ValueError("invalid provider response")
    except Exception:
        # Adapter exceptions intentionally suppress remote bodies, request URLs,
        # and credentials. Keep this response equally narrow.
        return 502, {"error": "provider connection failed (details suppressed)"}

    return 200, {
        "ok": True,
        "provider": {
            "id": summary["id"],
            "name": summary["name"],
            "model": summary["model"],
            "protocol": summary.get("protocol", "openai"),
        },
        "latencyMs": max(0, int((time.monotonic() - started) * 1000)),
    }


def _handle_compatibility_test(ctx: dict, data) -> tuple:
    """Run one opt-in compatibility check against a saved OpenAI profile.

    Only the profile ID, finite check mode, and allowlisted compatibility
    options can come from the client. Endpoint, model, and credentials are
    read from one jailed profile snapshot. The diagnostic itself never saves
    the candidate options or chooses the active runtime profile.
    """
    if ctx.get("allow_real") is not True:
        return 403, {"error": "real model requests are disabled by the server"}
    if not isinstance(data, dict) or set(data) - {"id", "mode", "compatibility"}:
        return 400, {"error": "expected provider id, test mode and optional compatibility object"}
    if not {"id", "mode"} <= set(data):
        return 400, {"error": "provider id and test mode are required"}
    pid = data.get("id")
    mode = data.get("mode")
    if not _valid_id(pid):
        return 400, {"error": "invalid provider id"}
    if not isinstance(mode, str) or mode not in COMPATIBILITY_TEST_MODES:
        return 400, {"error": "unsupported provider compatibility test mode"}
    candidate_compatibility = None
    if "compatibility" in data:
        try:
            candidate_compatibility = validate_compatibility(data["compatibility"])
        except ValueError as exc:
            return 400, {"error": str(exc)}

    from . import provider_config
    try:
        with PROVIDER_STORE_LOCK:
            directory = _providers_dir(ctx)
            path = _path_for(directory, pid)
            record = _read_record(path) if path and path.exists() else None
            if record is None:
                return 404, {"error": "provider profile not found"}
            if record.get("protocol", "openai") != "openai":
                return 400, {"error": "compatibility diagnostics require an OpenAI-compatible profile"}
            revision = record.get("_profileRevision")
            if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{32}", revision):
                # One-time metadata migration for profiles created before
                # verification history existed; this does not alter runtime
                # options or credentials.
                revision = uuid.uuid4().hex
                record["_profileRevision"] = revision
                _atomic_write(path, record)
            if candidate_compatibility is None:
                candidate_compatibility = validate_compatibility(record.get("compatibility", {}))
            options_hash = _compatibility_hash(candidate_compatibility)
            summary = _public(record)
            provider = provider_config.resolve(ctx["state_dir"], pid)
    except ValueError as exc:
        return 400, {"error": provider_config.configuration_error(exc)}
    except (OSError, KeyError):
        return 400, {"error": "provider profile is unavailable"}

    if mode in ("json_tool_call", "json_tool_roundtrip") and getattr(provider, "runtime_profile", None) != "lightweight":
        return 400, {"error": "JSON tool-call diagnostics require a lightweight profile"}
    check = getattr(provider, "compatibility_test", None)
    if not callable(check):
        return 400, {"error": "provider protocol does not support compatibility diagnostics"}
    started = time.monotonic()
    try:
        result = check(
            mode, compatibility=candidate_compatibility,
            timeout=COMPATIBILITY_TEST_TIMEOUT_SECONDS,
        )
    except ValueError as exc:
        return 400, {"error": str(exc)}
    if not isinstance(result, dict) or type(result.get("ok")) is not bool:
        return 502, {"error": "invalid provider compatibility result"}
    details = result.get("details")
    request_count = details.get("requestCount") if isinstance(details, dict) else None
    max_requests = 2 if mode in ("tool_roundtrip", "json_tool_roundtrip") else 1
    if (not isinstance(details, dict) or details.get("mode") != mode
            or type(request_count) is not int or not 1 <= request_count <= max_requests):
        return 502, {"error": "invalid provider compatibility result"}
    if result["ok"] and not _compatibility_result_has_proof(mode, result):
        return 502, {"error": "provider compatibility result did not contain the required proof"}
    tested_at = _timestamp()
    safe_error = _safe_compatibility_error(result.get("error")) if result.get("error") is not None else None
    stored_input = dict(result)
    if safe_error is not None:
        stored_input["error"] = safe_error
    stored_check = _stored_check(mode, stored_input, tested_at)
    try:
        with PROVIDER_STORE_LOCK:
            directory = _providers_dir(ctx)
            path = _path_for(directory, pid)
            current = _read_record(path) if path and path.exists() else None
            if current is None:
                return 409, {"error": "provider profile changed during diagnostics; rerun the check"}
            if current.get("_profileRevision") != revision:
                return 409, {"error": "provider profile changed during diagnostics; rerun the check"}
            diagnostics = current.get("_compatibilityDiagnostics")
            if not isinstance(diagnostics, dict):
                diagnostics = {}
            group = diagnostics.get(options_hash)
            if (not isinstance(group, dict) or group.get("profileRevision") != revision
                    or group.get("compatibility") != candidate_compatibility):
                group = {"profileRevision": revision,
                         "compatibility": dict(candidate_compatibility), "checks": {}}
            checks = group.get("checks")
            if not isinstance(checks, dict):
                checks = {}
            checks[mode] = stored_check
            group["checks"] = checks
            group["updatedAt"] = tested_at
            diagnostics[options_hash] = group
            # Bound retained candidate history so repeated manual probes cannot
            # grow the credential file without limit.
            if len(diagnostics) > 8:
                oldest = sorted(
                    diagnostics.items(),
                    key=lambda item: str(item[1].get("updatedAt", ""))
                    if isinstance(item[1], dict) else "",
                )
                for old_hash, _old in oldest[:len(diagnostics) - 8]:
                    diagnostics.pop(old_hash, None)
            current["_compatibilityDiagnostics"] = diagnostics
            _atomic_write(path, current)
            updated_summary = _public(current)
    except OSError:
        return 500, {"error": "could not persist compatibility diagnostic metadata"}
    safe_result = _public_check(mode, {
        "ok": result["ok"], "error": safe_error,
        "requestCount": request_count,
        "latencyMs": max(0, int((time.monotonic() - started) * 1000)),
        "httpStatus": details.get("httpStatus"),
        "failedStep": details.get("failedStep"),
        "details": details,
    }) or {"mode": mode, "ok": result["ok"], "requestCount": request_count}
    safe_result.update({
        "provider": {
            "id": summary["id"],
            "name": summary["name"],
            "model": summary["model"],
            "protocol": "openai",
        },
        "latencyMs": max(0, int((time.monotonic() - started) * 1000)),
        "optionsHash": options_hash,
        "testedAt": tested_at,
        "providerCompatibilityDiagnostics": updated_summary.get("compatibilityDiagnostics", []),
    })
    return 200, safe_result


def _handle_compatibility_adopt(ctx: dict, data) -> tuple:
    """Explicitly adopt only options whose required diagnostics passed server-side."""
    if not isinstance(data, dict) or set(data) != {"id", "optionsHash"}:
        return 400, {"error": "expected provider id and verified options hash"}
    pid, options_hash = data.get("id"), data.get("optionsHash")
    if not _valid_id(pid) or not isinstance(options_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", options_hash):
        return 400, {"error": "invalid provider id or options hash"}
    try:
        with PROVIDER_STORE_LOCK:
            directory = _providers_dir(ctx)
            path = _path_for(directory, pid)
            record = _read_record(path) if path and path.exists() else None
            if record is None:
                return 404, {"error": "provider profile not found"}
            if record.get("protocol", "openai") != "openai":
                return 400, {"error": "compatibility diagnostics require an OpenAI-compatible profile"}
            revision = record.get("_profileRevision")
            diagnostics = record.get("_compatibilityDiagnostics")
            group = diagnostics.get(options_hash) if isinstance(diagnostics, dict) else None
            if (not isinstance(revision, str) or not isinstance(group, dict)
                    or group.get("profileRevision") != revision):
                return 409, {"error": "verified diagnostics are stale or unavailable; rerun the checks"}
            try:
                candidate = validate_compatibility(group.get("compatibility"))
            except (ValueError, TypeError):
                return 409, {"error": "verified compatibility options are invalid; rerun the checks"}
            if _compatibility_hash(candidate) != options_hash:
                return 409, {"error": "verified compatibility options changed; rerun the checks"}
            checks = group.get("checks")
            required = _required_compatibility_modes(record)
            if not isinstance(checks, dict) or any(
                    not isinstance(checks.get(mode), dict) or checks[mode].get("ok") is not True
                    for mode in required):
                return 409, {"error": "all required compatibility checks must pass before adoption"}
            verified_at = _timestamp()
            new_revision = uuid.uuid4().hex
            group["profileRevision"] = new_revision
            group["updatedAt"] = verified_at
            record["_profileRevision"] = new_revision
            record["_compatibilityDiagnostics"] = diagnostics
            record["compatibility"] = dict(candidate)
            record["_compatibilityVerification"] = {
                "profileRevision": new_revision,
                "optionsHash": options_hash,
                "verifiedAt": verified_at,
                "checks": [dict(checks[mode], mode=mode) for mode in required],
            }
            _atomic_write(path, record)
            return 200, {"provider": _public(record)}
    except OSError:
        return 500, {"error": "could not save verified compatibility options"}


def _handle_model_discovery(ctx: dict, data) -> tuple:
    """Discover models from one explicitly selected saved profile."""
    if ctx.get("allow_real") is not True:
        return 403, {"error": "real model requests are disabled by the server"}
    if not isinstance(data, dict) or set(data) != {"id"}:
        return 400, {"error": "expected provider id only"}
    pid = data.get("id")
    if not _valid_id(pid):
        return 400, {"error": "invalid provider id"}

    from . import provider_config
    try:
        with PROVIDER_STORE_LOCK:
            directory = _providers_dir(ctx)
            path = _path_for(directory, pid)
            record = _read_record(path) if path and path.exists() else None
            if record is None:
                return 404, {"error": "provider profile not found"}
            protocol = record.get("protocol", "openai")
            if protocol == "anthropic":
                return 400, {"error": "model discovery is not supported for Anthropic providers"}
            if protocol != "openai":
                return 400, {"error": "provider profile uses an unsupported protocol"}
            summary = _public(record)
            # Capture the profile under the same lock used by saves/deletes;
            # release it before making the bounded network request.
            provider = provider_config.resolve(ctx["state_dir"], pid)
    except ValueError as exc:
        return 400, {"error": provider_config.configuration_error(exc)}
    except (OSError, KeyError):
        return 400, {"error": "provider profile is unavailable"}

    discover = getattr(provider, "discover_models", None)
    if not callable(discover):
        return 400, {"error": "provider protocol does not support model discovery"}
    try:
        models = discover(timeout=MODEL_DISCOVERY_TIMEOUT_SECONDS)
        if not isinstance(models, list):
            raise ValueError("invalid provider model list")
    except Exception:
        # Adapter failures intentionally suppress remote bodies, URLs, and
        # credentials. Keep this API response equally narrow.
        return 502, {"error": "provider model discovery failed (details suppressed)"}

    return 200, {
        "ok": True,
        "provider": {
            "id": summary["id"],
            "name": summary["name"],
            "model": summary["model"],
            "protocol": "openai",
        },
        "models": models,
    }


def dispatch(method: str, parts: list, query: dict, data: dict, ctx: dict):
    """Handle ``/api/providers``; ``None`` means "not ours"."""
    if not isinstance(parts, list) or len(parts) < 2:
        return None
    if parts[0] != "api" or parts[1] != "providers":
        return None
    rest = parts[2:]
    try:
        if method == "GET" and not rest:
            return 200, {"providers": _list(ctx)}

        if method == "POST" and not rest:
            return _handle_save(ctx, data)

        if method == "POST" and rest == ["discover"]:
            return _handle_model_discovery(ctx, data)

        if method == "POST" and rest == ["test"]:
            return _handle_connection_test(ctx, data)

        if method == "POST" and rest == ["compatibility-test"]:
            return _handle_compatibility_test(ctx, data)

        if method == "POST" and rest == ["compatibility-adopt"]:
            return _handle_compatibility_adopt(ctx, data)

        if rest == ["default"]:
            from . import default_selection
            handled = default_selection.dispatch(method, rest, data, ctx)
            if handled is not None:
                return handled

        if method == "DELETE" and len(rest) == 1:
            return _handle_delete(ctx, rest[0])
    except ValueError as exc:
        # Jail violations (symlinked / escaping providers directory) are client-
        # shaped problems: report 400 rather than escaping as an unhandled error.
        return 400, {"error": str(exc)}

    return None
