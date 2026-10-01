"""Model provider configuration API (Stage 2 contract, section 3).

Standard library only.

Security properties enforced here:

* The api key is **never** echoed back. Every response body is built from an
  explicit field whitelist, so ``apiKey`` cannot leak by accident; clients
  only ever see ``hasKey: bool``.
* Keys land in ``<state_dir>/providers/<id>.json`` written atomically
  (``tempfile.mkstemp`` + ``fsync`` + ``os.replace``) with mode ``0o600``.
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
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from .runtime_options import public_runtime_options, resolve_runtime_options, validate_compatibility
from .lightweight_config import validate_options

ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# Dot-only names are legal for the regex but are traversal/parent markers.
RESERVED_IDS = frozenset({".", ".."})
FILE_MODE = 0o600
DIR_MODE = 0o700
SUBDIR = "providers"
REQUIRED_TEXT_FIELDS = ("name", "baseUrl", "model")
_PUBLIC_FIELDS = ("id", "name", "baseUrl", "model")
REASONING_LEVELS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
CONNECTION_TEST_TIMEOUT_SECONDS = 8.0
MODEL_DISCOVERY_TIMEOUT_SECONDS = 8.0

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
    if directory.is_symlink():
        raise ValueError("providers directory must not be a symlink")
    if not _within(directory, state_dir):
        raise ValueError("providers directory escapes state dir")
    return directory


def _path_for(directory: Path, pid: str) -> Path | None:
    """Jailed path for ``<id>.json``; ``None`` when it escapes the jail.

    ``pid`` is already regex-whitelisted (no separators, not ``.``/``..``), so
    the only remaining escape hatch is an existing symlink at that name.
    """
    candidate = directory / f"{pid}.json"
    if candidate.is_symlink():
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
    except ValueError:
        return False
    if parts.scheme not in ("http", "https"):
        return False
    return bool(parts.netloc)


def _clean_text(value) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _public(record: dict) -> dict:
    """Whitelisted view: the api key can never be part of this dict."""
    result = {
        "id": record.get("id", ""),
        "name": record.get("name", ""),
        "baseUrl": record.get("baseUrl", ""),
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
        levels = known_reasoning_levels(record.get("model"))
    # Keep the historical public shape for models whose capabilities are not
    # declared and cannot be inferred. An explicit [] remains meaningful: it
    # says the operator has disabled reasoning for this profile.
    if levels is not None and (declared_levels or bool(levels)):
        result["reasoningLevels"] = list(levels)
    result.update(public_runtime_options(record))
    return result


def _read_record(path: Path) -> dict | None:
    """Read one provider record, refusing symlinks (``O_NOFOLLOW``)."""
    if path.is_symlink():
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
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, FILE_MODE)
        os.replace(tmp, path)
        os.chmod(path, FILE_MODE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _list(ctx: dict) -> list:
    directory = _providers_dir(ctx)
    out: list = []
    if not directory.is_dir():
        return out
    for entry in sorted(directory.glob("*.json")):
        if entry.is_symlink():
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

        if method == "DELETE" and len(rest) == 1:
            return _handle_delete(ctx, rest[0])
    except ValueError as exc:
        # Jail violations (symlinked / escaping providers directory) are client-
        # shaped problems: report 400 rather than escaping as an unhandled error.
        return 400, {"error": str(exc)}

    return None
