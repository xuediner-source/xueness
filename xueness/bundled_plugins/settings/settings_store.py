"""Settings persistence for Xueness (Stage 2, section "settings_store").

Contract: docs/stage2-contract.md

HTTP surface
------------
GET  /api/settings              -> (200, {"settings": {section: values}})
GET  /api/settings/<section>    -> (200, {"section": s, "values": {...}})
POST /api/settings/<section>    -> body {"values": {...}}
                                -> (200, {"section": s, "values": {...}})

Storage: ``<state_dir>/settings.json`` (single file, atomic write, unknown
sections/keys preserved verbatim).

Standard library only.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path

__all__ = ["SECTION_IDS", "load_settings", "save_settings", "update_settings", "dispatch"]

#: Whitelist of accepted ``<section>`` identifiers. Anything else -> 404.
#: ``agent`` holds run-time capability opt-ins (MCP / sub-agents / hooks):
#: they spawn processes or nested model runs, so they are audited separately
#: from the cosmetic ``general`` keys.
SECTION_IDS = ("general", "appearance", "shortcuts", "browser", "agent")

#: Path prefix owned by this module.
_PREFIX = ("api", "settings")

SETTINGS_FILENAME = "settings.json"
_SETTINGS_LOCKS = {}
_SETTINGS_LOCKS_GUARD = threading.Lock()


def _settings_path(state_dir) -> Path:
    """Return the settings file path for ``state_dir`` (never creates it)."""
    return Path(state_dir) / SETTINGS_FILENAME


def load_settings(state_dir) -> dict:
    """Read ``<state_dir>/settings.json``.

    Missing file -> ``{}``. Corrupt JSON (or a non-object top level) -> ``{}``.
    Never raises for I/O or parse problems; only returns a plain dict.
    """
    # Workspace discovery reads settings outside update_settings. Coordinate
    # those readers too: Windows may deny replace while a reader is open.
    with _settings_lock(state_dir):
        return _load_settings_unlocked(state_dir)


def _load_settings_unlocked(state_dir) -> dict:
    path = _settings_path(state_dir)
    try:
        raw = path.read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError, PermissionError, OSError):
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return parsed


def save_settings(state_dir, settings) -> None:
    """Atomically write ``settings`` to ``<state_dir>/settings.json``.

    Mirrors ``core.Store.save``: tempfile.mkstemp in the target directory,
    flush + fsync, then ``os.replace``. The temp file is always cleaned up.
    """
    with _settings_lock(state_dir):
        _save_settings_unlocked(state_dir, settings)


def _save_settings_unlocked(state_dir, settings) -> None:
    directory = Path(state_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / SETTINGS_FILENAME
    fd, tmp = tempfile.mkstemp(prefix=".settings-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(settings, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _settings_lock(state_dir):
    key = str(Path(state_dir).expanduser().resolve())
    with _SETTINGS_LOCKS_GUARD:
        lock = _SETTINGS_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _SETTINGS_LOCKS[key] = lock
        return lock


def update_settings(state_dir, mutate):
    """Atomically apply one in-process read/modify/write to the settings file.

    ``save_settings`` already prevents partially written JSON, but without a
    keyed lock concurrent section updates could replace one another's fields.
    All HTTP and workspace preference mutations go through this helper.
    """
    if not callable(mutate):
        raise TypeError("mutate must be callable")
    with _settings_lock(state_dir):
        settings = load_settings(state_dir)
        mutate(settings)
        save_settings(state_dir, settings)
        return settings


def _is_settings_parts(parts) -> bool:
    return isinstance(parts, (list, tuple)) and len(parts) >= len(_PREFIX) and tuple(parts[: len(_PREFIX)]) == _PREFIX


def dispatch(method: str, parts: list, query: dict, data: dict, ctx: dict):
    """Handle ``/api/settings`` routes.

    Returns ``(status, payload)`` when handled, ``None`` when the request is
    not owned by this module.
    """
    if not _is_settings_parts(parts):
        return None

    method = (method or "").upper()
    depth = len(parts)

    # Deeper than /api/settings/<section> is not ours.
    if depth > 3:
        return None

    # GET /api/settings -> whole document
    if depth == 2:
        if method != "GET":
            return None
        state_dir = ctx["state_dir"]
        return 200, {"settings": load_settings(state_dir)}

    # depth == 3 -> /api/settings/<section>
    section = parts[2]
    if section not in SECTION_IDS:
        return 404, {"error": f"unknown settings section: {section}"}

    if method == "GET":
        state_dir = ctx["state_dir"]
        values = load_settings(state_dir).get(section, {})
        if not isinstance(values, dict):
            values = {}
        return 200, {"section": section, "values": values}

    if method == "POST":
        if not isinstance(data, dict):
            return 400, {"error": "request body must be an object"}
        values = data.get("values")
        if not isinstance(values, dict):
            return 400, {"error": "values must be an object"}
        from .preferences import validate
        try:
            validate(section, values)
        except ValueError as exc:
            return 400, {"error": str(exc)}
        state_dir = ctx["state_dir"]
        # Update only this section while preserving concurrent settings writes.
        settings = update_settings(state_dir, lambda current: current.__setitem__(section, values))
        return 200, {"section": section, "values": values}

    return None
