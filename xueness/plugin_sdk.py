"""Plugin SDK: manifest validation, capability gating, install/uninstall rollback.

Why this exists: ``plugins.py`` gives every opt-in capability one activation
seam, but it trusts its caller's name list and knows nothing about *what* is
being enabled. A settings resource could therefore name a capability without
ever declaring its version, its API level, or the powers it needs. This module
is the missing contract layer around that seam.

Three hard rules, in order of importance:

1. **A configuration resource is not executable code.** A manifest that names an
   ``entrypoint`` or a ``command`` is refused outright -- loading it would turn
   "a JSON file in the state directory" into code execution. External plugin
   code needs its own audit; this module deliberately cannot do it.
2. **Deny by default, twice.** A capability must be named by the caller *and*
   pass its manifest gate. A manifest that needs ``command`` does not get it
   because it asked; the caller has to grant it.
3. **A bad manifest costs only itself.** Validation is a pure function that
   never raises, discovery skips broken entries, and install validates
   everything before touching disk -- and rolls back if a write fails midway.

Stdlib only, no network, no writes outside ``<state>/resources/plugins``.
"""
from __future__ import annotations

import json  # noqa: F401  (kept for symmetry with the other loaders' imports)
import os
import re
from pathlib import Path

from . import plugins as _plugins
from .resources import _LOCK, _atomic_write_json, _is_link, _kind_dir, _load_item, _valid_id

#: Manifest API level this build understands.
API_VERSION = 1

#: Powers a manifest may ask for. Each one is a way to reach outside the
#: sandboxed run: spawning processes, opening sockets, or writing files.
CAPABILITIES = ("command", "network", "filesystem-write")

#: Fields that would make a resource executable. Presence (with a truthy value)
#: is an unconditional refusal, never a warning.
FORBIDDEN_FIELDS = ("entrypoint", "command")

_PLUGINS_KIND = "plugins"
_VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


class Plan:
    """Outcome of gating a caller's requested capability names.

    ``load`` is what may be handed to ``plugins.activate``; ``refused`` explains
    every name that did not make it, so a policy decision is never silent.
    """

    def __init__(self, load, refused, manifests):
        self.load = load
        self.refused = refused
        self.manifests = manifests

    def __repr__(self):  # pragma: no cover - debugging aid
        return "Plan(load=%r, refused=%r)" % (self.load, self.refused)


def _safe_plugins_parent(state_dir):
    try:
        _kind_dir({"state_dir": state_dir}, _PLUGINS_KIND)
    except (OSError, ValueError):
        return False
    return True


def _plugins_dir(state_dir) -> Path:
    return Path(state_dir) / "resources" / _PLUGINS_KIND


def validate_manifest(item):
    """Check one manifest document.

    Returns ``(manifest, errors)``. ``manifest`` is ``None`` when the document is
    unusable; ``errors`` is a list of stable, human-readable reasons. Never
    raises: a malformed resource must not be able to abort a run.
    """
    errors = []
    if not isinstance(item, dict):
        return None, ["manifest must be a JSON object"]

    # Executable-code fields are refused before anything else is considered: no
    # combination of otherwise-valid fields should be able to smuggle one in.
    for forbidden in FORBIDDEN_FIELDS:
        if item.get(forbidden):
            errors.append("external plugin code requires a separate audit")

    rid = item.get("id")
    if not _valid_id(rid):
        errors.append("invalid id")
        rid = None

    version = item.get("version")
    if not isinstance(version, str) or not _VERSION_PATTERN.match(version):
        errors.append("version must be MAJOR.MINOR.PATCH")

    api_version = item.get("apiVersion")
    if isinstance(api_version, bool) or not isinstance(api_version, int):
        errors.append("apiVersion must be an integer")
    elif api_version != API_VERSION:
        errors.append("incompatible apiVersion")

    builtin = item.get("builtin")
    if not isinstance(builtin, str) or builtin not in _plugins.PLUGINS:
        # A manifest must map to something this build can actually load.
        # Anything else would be a name ``activate()`` silently skips.
        errors.append("builtin must name a known capability")

    capabilities = item.get("capabilities")
    caps = []
    if capabilities is not None:
        if not isinstance(capabilities, list):
            errors.append("capabilities must be an array")
        else:
            for cap in capabilities:
                if cap not in CAPABILITIES:
                    errors.append("unknown capability: %r" % (cap,))
                    break
                if cap not in caps:
                    caps.append(cap)

    if errors:
        return None, errors

    manifest = {
        "id": rid,
        "version": version,
        "apiVersion": api_version,
        "enabled": item.get("enabled") is True,
        "builtin": builtin,
        "capabilities": caps,
    }
    return manifest, []


def _load_entries(state_dir) -> list:
    """Every readable manifest document, valid or not, with its verdict.

    ``plan`` needs the invalid ones too: a manifest that is refused for naming an
    ``entrypoint`` should say *that*, not be silently reclassified as "unknown
    capability" because it dropped out of the valid set.
    """
    directory = _plugins_dir(state_dir)
    # A symlinked directory would relocate the whole jail; refuse it outright.
    if not _safe_plugins_parent(state_dir) or not directory.is_dir():
        return []
    entries = []
    for path in sorted(directory.glob("*.json")):
        if _is_link(path):
            continue
        item = _load_item(path)
        if item is None:
            continue
        manifest, errors = validate_manifest(item)
        entries.append({"item": item, "manifest": manifest, "errors": errors})
    return entries


def load_manifests(state_dir) -> list:
    """Valid manifests under ``<state>/resources/plugins``, id ascending."""
    manifests = [entry["manifest"] for entry in _load_entries(state_dir)
                 if entry["manifest"] is not None]
    manifests.sort(key=lambda manifest: manifest["id"])
    return manifests


def _gate(item, grant_set):
    """First reason this manifest document may not take effect, or None.

    Runs on the *raw* document, not the validated manifest: a document that
    names a builtin but fails validation still governs that builtin, and the
    security-relevant refusals (an ``entrypoint``, a disabled flag, a missing
    grant) must fire whether or not the rest of the document is well formed.

    Order is fixed by the contract so the reported reason is stable even when
    several things are wrong at once.
    """
    if item.get("enabled") is not True:
        return "disabled"
    if item.get("apiVersion") != API_VERSION:
        return "incompatible apiVersion"
    for forbidden in FORBIDDEN_FIELDS:
        if item.get(forbidden):
            return "external plugin code requires a separate audit"
    capabilities = item.get("capabilities")
    if isinstance(capabilities, list):
        for capability in CAPABILITIES:
            if capability in capabilities and capability not in grant_set:
                return "missing grant: %s" % capability
    return None


def plan(state_dir, requested, grants=()) -> Plan:
    """Gate a caller's explicit capability list against the stored manifests.

    ``requested`` is the deny-by-default opt-in the call site already computes;
    this adds the manifest constraints on top of it.

    ``load`` contains **only** builtin capability names, because that is all
    ``plugins.activate`` can load. A manifest's ``id`` is an identifier for the
    settings UI, not a requestable alias: asking for ``mcp-ops`` when the
    manifest's builtin is ``mcp`` is refused as unknown, and the caller should
    request ``mcp``. Mapping ids onto builtins here would mean inventing a name
    the loader never agreed to accept.

    A manifest that names a builtin governs it even when the document is
    otherwise unusable -- refusing is the fail-closed reading, and the reason is
    reported instead of silently loading around a broken declaration. Documents
    that name no known builtin cannot govern anything and are ignored.
    """
    grant_set = {grant for grant in (grants or ()) if isinstance(grant, str)}
    by_builtin: dict = {}
    for entry in _load_entries(state_dir):
        builtin = entry["item"].get("builtin")
        if isinstance(builtin, str) and builtin in _plugins.PLUGINS:
            by_builtin.setdefault(builtin, []).append(entry)

    load: list = []
    refused: list = []
    manifests: dict = {}
    seen: set = set()

    for raw in requested or ():
        if not isinstance(raw, str) or not raw or raw in seen:
            continue
        seen.add(raw)
        name = raw

        if name not in _plugins.PLUGINS:
            # Nothing in this build can load it, manifest or not.
            refused.append({"name": name, "reason": "unknown capability"})
            continue

        candidates = sorted(by_builtin.get(name, []),
                            key=lambda entry: str(entry["item"].get("id", "")))
        if not candidates:
            # A builtin with no manifest is authorised by the caller's explicit
            # list alone. The manifest layer only ever adds constraints.
            load.append(name)
            continue

        winner = candidates[0]
        winner_id = str(winner["item"].get("id", ""))
        for loser in candidates[1:]:
            refused.append({"name": str(loser["item"].get("id", "")),
                            "reason": "conflicting manifest: %s" % winner_id})

        reason = _gate(winner["item"], grant_set)
        if reason is None and winner["manifest"] is None:
            # Structurally unusable (bad version, unknown capability, ...). The
            # document still claimed this builtin, so refuse rather than load.
            reason = (winner["errors"] or ["invalid manifest"])[0]
        if reason is not None:
            refused.append({"name": name, "reason": reason})
            continue
        load.append(name)
        manifests[name] = winner["manifest"]

    return Plan(load, refused, manifests)


def install_all(state_dir, items) -> dict:
    """Validate every manifest, then write them; roll back on any failure.

    Nothing is written unless the whole batch validates. If a write fails part
    way through, already-written entries are restored to their previous bytes
    (or removed when they are new), so a failed install cannot leave a
    half-applied set behind.
    """
    if not isinstance(items, list):
        return {"ok": False, "written": [], "errors": ["items must be an array"]}

    directory = _plugins_dir(state_dir)
    if not _safe_plugins_parent(state_dir):
        return {"ok": False, "written": [],
                "errors": ["plugins directory must not be a symlink"]}

    planned = []
    errors = []
    seen: set = set()
    for item in items:
        manifest, errs = validate_manifest(item)
        if manifest is None:
            rid = item.get("id") if isinstance(item, dict) else None
            errors.append({"id": rid, "errors": errs})
            continue
        if manifest["id"] in seen:
            errors.append({"id": manifest["id"], "errors": ["duplicate plugin id"]})
            continue
        seen.add(manifest["id"])
        planned.append((manifest["id"], item))

    if errors:
        return {"ok": False, "written": [], "errors": errors}

    snapshots: dict = {}
    written: list = []
    with _LOCK:
        try:
            directory.mkdir(parents=True, exist_ok=True)
            for rid, item in planned:
                path = directory / (rid + ".json")
                if _is_link(path):
                    raise ValueError("plugin id must not be a symlink: %s" % rid)
                snapshots[rid] = path.read_bytes() if path.exists() else None
                record = {"id": rid}
                for key, value in item.items():
                    if key in ("id", "createdAt", "updatedAt"):
                        continue
                    record[key] = value
                _atomic_write_json(path, record)
                written.append(rid)
        except Exception as exc:  # OSError, ValueError, anything a bad path throws
            for rid in reversed(written):
                path = directory / (rid + ".json")
                snapshot = snapshots.get(rid)
                try:
                    if snapshot is None:
                        if path.exists():
                            os.unlink(path)
                    else:
                        path.write_bytes(snapshot)
                except OSError:
                    pass
            return {"ok": False, "written": [], "errors": [str(exc)]}

    return {"ok": True, "written": written, "errors": []}


def uninstall(state_dir, plugin_id) -> dict:
    """Remove one manifest, returning it so the caller can roll back.

    A missing file is ``ok`` with ``removed: false`` -- uninstall is expected to
    be idempotent, and "it is already gone" is success, not failure.
    """
    if not _valid_id(plugin_id):
        return {"ok": False, "removed": False, "manifest": None, "error": "invalid plugin id"}

    directory = _plugins_dir(state_dir)
    if not _safe_plugins_parent(state_dir):
        return {"ok": False, "removed": False, "manifest": None,
                "error": "plugins directory must not be a symlink"}
    path = directory / (plugin_id + ".json")
    with _LOCK:
        if _is_link(path):
            return {"ok": False, "removed": False, "manifest": None,
                    "error": "plugin id must not be a symlink"}
        if not path.exists() or not path.is_file():
            return {"ok": True, "removed": False, "manifest": None}

        loaded = _load_item(path)
        manifest, _errors = validate_manifest(loaded) if loaded is not None else (None, [])
        try:
            os.unlink(path)
        except OSError as exc:
            return {"ok": False, "removed": False, "manifest": manifest, "error": str(exc)}
        return {"ok": True, "removed": True, "manifest": manifest}
