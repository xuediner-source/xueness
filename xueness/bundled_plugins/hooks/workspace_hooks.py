"""Workspace (project-level) hooks: read-only discovery, digest trust, admission.

A repository can ship hooks next to its code. Because a workspace hook executes
a command, it must never run just because the file exists: every declaration is
fingerprinted with a stable sha256 digest over its canonical, normalized
content, shown for review, and only run after an explicit grant keyed by
``workspace canonical path + digest`` (the ZCode workspace-hook trust model).

Discovery is read-only and never executes anything::

    <workspace>/.xueness/hooks.json     project        (native flat list)
    <workspace>/.zcode/config.json      project-compat (ZCode nested format)

Compat entries are parsed from ZCode's nested ``hooks`` key; a ZCode
``command``-type declaration is a shell string the argv-only runner must never
execute, so it is reported as a diagnostic instead of a row. Links are refused
at every level (``resources._is_link``) and every resolved path must stay
inside the workspace, so a redirect cannot move the jail. Containment uses
the shared host-path comparison: Windows and macOS treat case variants as the
same path, and Linux does not. A mismatch is still a refusal, and discovery
still never raises. One broken entry costs that entry and produces a
structured diagnostic, never an exception.

The whole feature is default-off: ``<state_dir>/workspace-hooks.json`` must
explicitly hold ``{"enabled": true}``. While it is off nothing under the
workspace is read at all and the run seam sees user hooks only.

Trust records live in ``<state_dir>/hook-trust.json`` (strict schema, atomic
private writes). A corrupt store fails closed: nothing is trusted, and
grant/revoke refuse with ``trust_store_corrupt`` until the file is repaired.
Corruption is reported, never repaired silently: reading the store changes no
file, so ``status``, ``grant`` and ``revoke`` agree on the same broken store,
and fixing or removing the file is what rebuilds a fresh one.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from ...resources import _atomic_write_json, _is_link
from ...write_lock import host_path_contained, host_relative_to
from .hooks import HOOK_EVENTS

#: One hook row is a plain-data dict; a hook command only ever runs through the
#: existing :class:`~xueness.hooks.HookRunner` after admission.
DIGEST_VERSION = 1

#: Read budget for one workspace hook file; a committed file has no business
#: being enormous, and the cap bounds the cost of a hostile one.
MAX_HOOKS_FILE_BYTES = 256 * 1024
#: Entries parsed per source file / per workspace discovery.
MAX_HOOKS_PER_SOURCE = 64
MAX_HOOKS_PER_WORKSPACE = 128
#: Matcher groups accepted per event in the nested compat format.
MAX_MATCHER_GROUPS_PER_EVENT = 32

#: Where the feature switch and the trust store live (both state-dir data).
FEATURE_FILENAME = "workspace-hooks.json"
FEATURE_MAX_BYTES = 4096
TRUST_FILENAME = "hook-trust.json"
TRUST_SCHEMA_VERSION = 1
MAX_TRUST_BYTES = 256 * 1024
MAX_TRUST_RECORDS = 512

TRUST_RECORD_REQUIRED = ("workspace", "digest", "decision", "grantedAt")
TRUST_RECORD_OPTIONAL = ("eventAtGrant", "displayCommandAtGrant", "sourcePathAtGrant")

_HEX64 = re.compile(r"[0-9a-f]{64}\Z")

#: (source kind, directory name, file name), in discovery order.
SOURCES = (("project", ".xueness", "hooks.json"),
           ("project-compat", ".zcode", "config.json"))

#: Session diagnostics channel (same shape idea as tool_event_diagnostics).
MAX_DIAGNOSTICS = 50


def diagnostic(code: str, severity: str, message: str, path=None) -> dict:
    """One structured finding; a broken entry is an answer, never an exception."""
    item = {"code": code, "severity": severity, "message": message}
    if path is not None:
        item["path"] = str(path)
    return item


def _contained(child: Path, parent: Path) -> bool:
    return host_path_contained(child, parent)


def _real(path) -> Path | None:
    try:
        return Path(path).resolve()
    except OSError:
        return None


def canonical_workspace(root) -> str | None:
    """The workspace jail as a canonical absolute path, or ``None``."""
    if root is None:
        return None
    try:
        return str(Path(root).expanduser().resolve())
    except (OSError, RuntimeError, ValueError, TypeError):
        return None


def _sha256_payload(payload) -> str:
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def display_command(row: dict) -> str:
    """The command as shown for review: argv joined, never interpreted."""
    parts = [str(row.get("command") or "")]
    parts.extend(str(arg) for arg in (row.get("args") or []))
    return " ".join(part for part in parts if part)


# -- discovery ----------------------------------------------------------------

def _read_text(path: Path):
    """Read one non-link file as text within the byte budget."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None, "hook_unreadable"
    try:
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read(MAX_HOOKS_FILE_BYTES + 1)
    except OSError:
        return None, "hook_unreadable"
    if len(raw) > MAX_HOOKS_FILE_BYTES:
        return None, "hook_file_too_large"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, "hook_invalid_encoding"


def _timeout_ms(timeout=None, timeout_ms=None):
    """Canonical milliseconds for the digest; ``None`` when left to the cap."""
    if timeout_ms is not None:
        return int(round(float(timeout_ms)))
    if timeout is not None:
        return int(round(float(timeout) * 1000))
    return None


def _row(*, hook_id, event, matcher, command, args, timeout, timeout_ms, enabled,
         pipeline, source, source_index, index, workspace, source_path,
         source_relative) -> dict:
    digest = _sha256_payload([
        "xueness-workspace-hook-declaration", DIGEST_VERSION,
        source_relative, index, hook_id, event, matcher,
        command, list(args or []), _timeout_ms(timeout, timeout_ms), bool(pipeline),
    ])
    row = {"id": hook_id, "event": event, "command": command,
           "enabled": bool(enabled), "source": source, "index": index,
           "sourceIndex": source_index, "sourcePath": str(source_path),
           "sourceRelative": source_relative, "workspace": workspace,
           "digest": digest}
    if matcher:
        row["matcher"] = matcher
    if args:
        row["args"] = list(args)
    if timeout is not None:
        row["timeout"] = float(timeout)
    elif timeout_ms is not None:
        row["timeout"] = int(round(float(timeout_ms))) / 1000.0
    if pipeline:
        row["pipeline"] = True
    return row


def _native_entry(entry, *, source_index, index, workspace, source_path,
                  source_relative):
    """One flat entry shaped like a user hook resource, or a diagnostic code."""
    if not isinstance(entry, dict):
        return None, "hook_invalid_shape"
    hook_id = entry.get("id")
    if hook_id is None:
        hook_id = "workspace-hook-%d-%d" % (source_index, index)
    elif not isinstance(hook_id, str) or not hook_id.strip():
        return None, "hook_invalid_id"
    hook_id = hook_id.strip()
    event = entry.get("event")
    if event not in HOOK_EVENTS:
        return None, "hook_invalid_event"
    command = entry.get("command")
    if not isinstance(command, str) or not command.strip():
        return None, "hook_invalid_command"
    args = entry.get("args")
    if args is not None:
        if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
            return None, "hook_invalid_args"
        args = args or None
    matcher = entry.get("matcher")
    if matcher is not None and not isinstance(matcher, str):
        return None, "hook_invalid_matcher"
    if matcher == "":
        matcher = None
    timeout = entry.get("timeout")
    if timeout is not None and (isinstance(timeout, bool)
                                or not isinstance(timeout, (int, float)) or timeout <= 0):
        return None, "hook_invalid_timeout"
    enabled = entry.get("enabled")
    if enabled is None:
        enabled = True
    elif not isinstance(enabled, bool):
        return None, "hook_invalid_enabled"
    pipeline = entry.get("pipeline")
    if pipeline is None:
        pipeline = False
    elif not isinstance(pipeline, bool):
        return None, "hook_invalid_pipeline"
    return _row(hook_id=hook_id, event=event, matcher=matcher, command=command,
                args=args, timeout=timeout, timeout_ms=None, enabled=enabled,
                pipeline=pipeline, source="project", source_index=source_index,
                index=index, workspace=workspace, source_path=source_path,
                source_relative=source_relative), None


def _parse_native(document, *, source_index, workspace, source_path,
                  source_relative, diagnostics):
    """``{"hooks": [...]}`` or a bare array of user-hook-shaped entries."""
    if isinstance(document, list):
        entries = document
    elif isinstance(document, dict) and isinstance(document.get("hooks"), list):
        entries = document["hooks"]
    else:
        diagnostics.append(diagnostic("hook_invalid_shape", "error",
                                      "hooks.json must hold a list of hook entries",
                                      source_path))
        return []
    rows = []
    for index, entry in enumerate(entries):
        if len(rows) >= MAX_HOOKS_PER_SOURCE:
            diagnostics.append(diagnostic("hook_limit", "warning",
                                          "only the first %d hooks are read from this file"
                                          % MAX_HOOKS_PER_SOURCE, source_path))
            break
        row, issue = _native_entry(entry, source_index=source_index, index=index,
                                   workspace=workspace, source_path=source_path,
                                   source_relative=source_relative)
        if issue:
            diagnostics.append(diagnostic(issue, "error",
                                          "hook entry %d was refused" % index,
                                          source_path))
            continue
        rows.append(row)
    return rows


def _compat_hook_entry(hook, *, event, matcher, source_index, index, workspace,
                       source_path, source_relative, root_enabled, root_timeout_ms):
    """One ZCode nested hook declaration, or a diagnostic code."""
    if not isinstance(hook, dict):
        return None, "hook_invalid_shape"
    hook_type = hook.get("type")
    if hook_type == "command":
        # A ZCode command hook is a shell string; the argv-only runner must not
        # pretend to execute it, so it stays visible as a diagnostic instead.
        return None, "hook_unsupported_type"
    if hook_type != "process":
        return None, "hook_invalid_shape"
    command = hook.get("command")
    if not isinstance(command, str) or not command.strip():
        return None, "hook_invalid_command"
    args = hook.get("args")
    if args is not None:
        if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
            return None, "hook_invalid_args"
        args = args or None
    timeout_ms = hook.get("timeoutMs")
    if timeout_ms is None:
        timeout_ms = root_timeout_ms
    elif isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) \
            or timeout_ms <= 0:
        return None, "hook_invalid_timeout"
    enabled = hook.get("enabled")
    if enabled is None:
        enabled = True
    elif not isinstance(enabled, bool):
        return None, "hook_invalid_enabled"
    return _row(hook_id="workspace-hook-%d-%d" % (source_index, index),
                event=event, matcher=matcher, command=command, args=args,
                timeout=None, timeout_ms=timeout_ms,
                enabled=bool(root_enabled and enabled), pipeline=False,
                source="project-compat", source_index=source_index, index=index,
                workspace=workspace, source_path=source_path,
                source_relative=source_relative), None


def _parse_compat(document, *, source_index, workspace, source_path,
                  source_relative, diagnostics):
    """ZCode's nested ``hooks`` key; a file without it is simply not a hook config."""
    if not isinstance(document, dict) or "hooks" not in document:
        return None
    hooks = document["hooks"]
    if not isinstance(hooks, dict):
        diagnostics.append(diagnostic("hook_invalid_shape", "error",
                                      "the hooks value must be an object", source_path))
        return []
    root_enabled = hooks.get("enabled")
    if root_enabled is None:
        root_enabled = True
    elif not isinstance(root_enabled, bool):
        diagnostics.append(diagnostic("hook_invalid_shape", "error",
                                      "hooks.enabled must be a boolean", source_path))
        return []
    timeout_ms = hooks.get("timeoutMs")
    if timeout_ms is not None and (isinstance(timeout_ms, bool)
                                   or not isinstance(timeout_ms, (int, float))
                                   or timeout_ms <= 0):
        diagnostics.append(diagnostic("hook_invalid_shape", "error",
                                      "hooks.timeoutMs must be a positive number",
                                      source_path))
        return []
    events = hooks.get("events")
    if events is None:
        return []
    if not isinstance(events, dict):
        diagnostics.append(diagnostic("hook_invalid_shape", "error",
                                      "hooks.events must be an object", source_path))
        return []
    rows = []
    index = 0
    limit_hit = False
    for event, groups in events.items():
        if event not in HOOK_EVENTS:
            diagnostics.append(diagnostic("hook_invalid_event", "error",
                                          "unknown hook event: %s" % event, source_path))
            continue
        if not isinstance(groups, list):
            diagnostics.append(diagnostic("hook_invalid_shape", "error",
                                          "event %s must hold a list of matcher groups"
                                          % event, source_path))
            continue
        if len(groups) > MAX_MATCHER_GROUPS_PER_EVENT:
            groups = groups[:MAX_MATCHER_GROUPS_PER_EVENT]
            diagnostics.append(diagnostic("hook_limit", "warning",
                                          "only the first %d matcher groups are read for %s"
                                          % (MAX_MATCHER_GROUPS_PER_EVENT, event),
                                          source_path))
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list) \
                    or not group["hooks"]:
                diagnostics.append(diagnostic("hook_invalid_shape", "error",
                                              "matcher group under %s is unusable" % event,
                                              source_path))
                continue
            matcher = group.get("matcher")
            if matcher is not None and not isinstance(matcher, str):
                diagnostics.append(diagnostic("hook_invalid_matcher", "error",
                                              "matcher under %s must be a string" % event,
                                              source_path))
                continue
            if matcher == "":
                matcher = None
            for hook in group["hooks"]:
                if len(rows) >= MAX_HOOKS_PER_SOURCE:
                    if not limit_hit:
                        limit_hit = True
                        diagnostics.append(diagnostic("hook_limit", "warning",
                                                      "only the first %d hooks are read "
                                                      "from this file" % MAX_HOOKS_PER_SOURCE,
                                                      source_path))
                    return rows
                row, issue = _compat_hook_entry(
                    hook, event=event, matcher=matcher, source_index=source_index,
                    index=index, workspace=workspace, source_path=source_path,
                    source_relative=source_relative, root_enabled=root_enabled,
                    root_timeout_ms=timeout_ms)
                index += 1
                if issue:
                    diagnostics.append(diagnostic(issue, "error",
                                                  "hook declaration under %s was refused"
                                                  % event, source_path))
                    continue
                rows.append(row)
    return rows


def discover(root) -> dict:
    """Every usable workspace hook declaration; read-only, never raises."""
    workspace = canonical_workspace(root)
    rows: list = []
    diagnostics: list = []
    sources: list = []
    if workspace is None:
        return {"hooks": [], "diagnostics": diagnostics, "sources": sources,
                "bundleDigest": None, "workspace": None}
    jail = Path(workspace)
    for source_index, (kind, dir_name, file_name) in enumerate(SOURCES):
        directory = jail / dir_name
        if os.path.lexists(str(directory)) and _is_link(directory):
            diagnostics.append(diagnostic("hook_root_symlink", "error",
                                          "%s must not be a link" % dir_name, directory))
            continue
        path = directory / file_name
        if not os.path.lexists(str(path)):
            continue
        if _is_link(path):
            diagnostics.append(diagnostic("hook_file_symlink", "error",
                                          "%s must not be a link" % path.name, path))
            continue
        resolved = _real(path)
        relative = None if resolved is None else host_relative_to(resolved, jail)
        if relative is None:
            diagnostics.append(diagnostic("hook_escapes_workspace", "error",
                                          "hook file resolves outside the workspace", path))
            continue
        text, failure = _read_text(path)
        if failure:
            diagnostics.append(diagnostic(failure, "error",
                                          "%s could not be read" % path.name, path))
            continue
        try:
            document = json.loads(text)
        except ValueError:
            diagnostics.append(diagnostic("hook_invalid_json", "error",
                                          "%s is not valid JSON" % path.name, path))
            continue
        if kind == "project":
            parsed = _parse_native(document, source_index=source_index,
                                   workspace=workspace, source_path=path,
                                   source_relative=relative, diagnostics=diagnostics)
            source_enabled = True
        else:
            parsed = _parse_compat(document, source_index=source_index,
                                   workspace=workspace, source_path=path,
                                   source_relative=relative, diagnostics=diagnostics)
            source_enabled = True
            if isinstance(document, dict) and isinstance(document.get("hooks"), dict):
                declared = document["hooks"].get("enabled")
                source_enabled = True if not isinstance(declared, bool) else declared
        if parsed is None:
            continue
        if len(rows) + len(parsed) > MAX_HOOKS_PER_WORKSPACE:
            parsed = parsed[:MAX_HOOKS_PER_WORKSPACE - len(rows)]
            diagnostics.append(diagnostic("hook_limit", "warning",
                                          "only the first %d workspace hooks are read"
                                          % MAX_HOOKS_PER_WORKSPACE, path))
        sources.append({"kind": kind, "path": relative, "enabled": bool(source_enabled)})
        rows.extend(parsed)
    seen: set = set()
    unique_rows = []
    for row in rows:
        if row["id"] in seen:
            diagnostics.append(diagnostic("hook_duplicate_id", "error",
                                          "duplicate workspace hook id: %s" % row["id"],
                                          row["sourcePath"]))
            continue
        seen.add(row["id"])
        unique_rows.append(row)
    bundle = _sha256_payload([
        "xueness-workspace-hook-bundle", DIGEST_VERSION,
        [[source["path"], source["kind"], source["enabled"]] for source in sources],
        [[row["digest"], row["enabled"]] for row in unique_rows],
    ]) if unique_rows else None
    return {"hooks": unique_rows, "diagnostics": diagnostics, "sources": sources,
            "bundleDigest": bundle, "workspace": workspace}


# -- feature switch -----------------------------------------------------------

def _feature_path(state_dir) -> Path:
    return Path(state_dir) / FEATURE_FILENAME


def feature_status(state_dir) -> dict:
    """The workspace-hook feature switch; anything unusual reads as disabled."""
    path = _feature_path(state_dir)
    try:
        if _is_link(path):
            return {"enabled": False, "status": "corrupt"}
        if not path.exists():
            return {"enabled": False, "status": "absent"}
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(str(path), flags)
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read(FEATURE_MAX_BYTES + 1)
    except OSError:
        return {"enabled": False, "status": "corrupt"}
    if len(raw) > FEATURE_MAX_BYTES:
        return {"enabled": False, "status": "corrupt"}
    try:
        document = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {"enabled": False, "status": "corrupt"}
    if (not isinstance(document, dict) or set(document) != {"enabled"}
            or type(document["enabled"]) is not bool):
        return {"enabled": False, "status": "corrupt"}
    return {"enabled": document["enabled"], "status": "ok"}


def feature_enabled(state_dir) -> bool:
    return feature_status(state_dir)["enabled"]


def set_feature(state_dir, enabled: bool) -> dict:
    """Persist the explicit opt-in; the feature never turns on by silence."""
    if type(enabled) is not bool:
        raise ValueError("enabled must be a boolean")
    path = _feature_path(state_dir)
    if _is_link(path):
        raise ValueError("workspace hook settings must not be a symlink")
    _atomic_write_json(path, {"enabled": enabled})
    return {"enabled": enabled, "status": "ok"}


# -- trust store --------------------------------------------------------------

def _trust_path(state_dir) -> Path:
    return Path(state_dir) / TRUST_FILENAME


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _valid_record(record) -> bool:
    if not isinstance(record, dict):
        return False
    keys = set(record)
    if not set(TRUST_RECORD_REQUIRED) <= keys:
        return False
    if keys - set(TRUST_RECORD_REQUIRED) - set(TRUST_RECORD_OPTIONAL):
        return False
    if not isinstance(record["workspace"], str) or not record["workspace"]:
        return False
    if not isinstance(record["digest"], str) or not _HEX64.match(record["digest"]):
        return False
    if record["decision"] != "trusted":
        return False
    if not isinstance(record["grantedAt"], str) or not record["grantedAt"]:
        return False
    for field in TRUST_RECORD_OPTIONAL:
        if field in keys and (not isinstance(record[field], str) or not record[field]):
            return False
    return True


def _corrupt(path: Path) -> dict:
    return {"status": "corrupt", "records": [], "corruptPath": str(path)}


def load_trust(state_dir) -> dict:
    """``{"status": ok|absent|corrupt, "records": [...], "corruptPath": ...}``.

    Any deviation from the strict schema — unknown fields, wrong types, a bad
    digest shape, duplicate keys, a link at the path, oversize content — is
    corrupt: the store is a permission boundary and must fail closed as a
    whole, never partially. Detecting it never touches the file. This is a
    plain read, called from the run seam and from ``status``; renaming a
    permission boundary aside as a side effect of looking at it would also
    make the next command report a healthy empty store, so ``status``,
    ``grant`` and ``revoke`` would disagree about the same broken file.
    Repair is an explicit act: fix or remove the file, and the next grant
    writes a fresh store.
    """
    path = _trust_path(state_dir)
    try:
        if _is_link(path):
            return _corrupt(path)
        if not path.exists():
            return {"status": "absent", "records": [], "corruptPath": None}
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(str(path), flags)
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read(MAX_TRUST_BYTES + 1)
    except OSError:
        return {"status": "corrupt", "records": [], "corruptPath": str(path)}
    if len(raw) > MAX_TRUST_BYTES:
        return _corrupt(path)
    try:
        document = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return _corrupt(path)
    if not isinstance(document, dict) or set(document) != {"schemaVersion", "records"}:
        return _corrupt(path)
    if type(document["schemaVersion"]) is not int \
            or document["schemaVersion"] != TRUST_SCHEMA_VERSION:
        return _corrupt(path)
    records = document["records"]
    if not isinstance(records, list) or len(records) > MAX_TRUST_RECORDS:
        return _corrupt(path)
    if any(not _valid_record(record) for record in records):
        return _corrupt(path)
    keys = [(record["workspace"], record["digest"]) for record in records]
    if len(set(keys)) != len(keys):
        return _corrupt(path)
    return {"status": "ok", "records": records, "corruptPath": None}


def _write_trust(path: Path, records: list) -> bool:
    if _is_link(path):
        return False
    try:
        _atomic_write_json(path, {"schemaVersion": TRUST_SCHEMA_VERSION,
                                  "records": records})
        return True
    except OSError:
        return False


def grant_trust(state_dir, workspace, rows, *, now=None) -> dict:
    """Append one trusted record per granted declaration; idempotent per digest.

    A corrupt store refuses the grant outright (fail closed, matching ZCode's
    ``trust_store_corrupt`` semantics): recovery must be an explicit repair,
    never a side effect of what looks like a successful authorization.
    """
    loaded = load_trust(state_dir)
    if loaded["status"] == "corrupt":
        return {"ok": False, "reason": "trust_store_corrupt", "trustStatus": "corrupt",
                "corruptPath": loaded["corruptPath"]}
    records = list(loaded["records"])
    existing = {(record["workspace"], record["digest"]) for record in records}
    stamp = now or _now_iso()
    granted = 0
    for row in rows:
        key = (workspace, row["digest"])
        if key in existing:
            continue
        existing.add(key)
        records.append({"workspace": workspace, "digest": row["digest"],
                        "decision": "trusted", "grantedAt": stamp,
                        "eventAtGrant": row["event"],
                        "displayCommandAtGrant": display_command(row),
                        "sourcePathAtGrant": row["sourceRelative"]})
        granted += 1
    if granted and len(records) > MAX_TRUST_RECORDS:
        return {"ok": False, "reason": "trust_store_full", "trustStatus": "ok",
                "corruptPath": None}
    if granted and not _write_trust(_trust_path(state_dir), records):
        return {"ok": False, "reason": "trust_store_write_failed",
                "trustStatus": loaded["status"], "corruptPath": None}
    return {"ok": True, "granted": granted, "records": records, "trustStatus": "ok",
            "corruptPath": None}


def revoke_trust(state_dir, workspace, digests=None, *, revoke_all=False) -> dict:
    """Drop this workspace's records for ``digests`` (or all of them)."""
    loaded = load_trust(state_dir)
    if loaded["status"] == "corrupt":
        return {"ok": False, "reason": "trust_store_corrupt", "trustStatus": "corrupt",
                "corruptPath": loaded["corruptPath"]}
    records = loaded["records"]
    wanted = set(digests or ())
    if revoke_all:
        kept = [record for record in records if record["workspace"] != workspace]
    else:
        kept = [record for record in records
                if not (record["workspace"] == workspace and record["digest"] in wanted)]
    removed = len(records) - len(kept)
    if removed and not _write_trust(_trust_path(state_dir), kept):
        return {"ok": False, "reason": "trust_store_write_failed",
                "trustStatus": loaded["status"], "corruptPath": None}
    return {"ok": True, "removed": removed, "records": kept, "trustStatus": "ok",
            "corruptPath": None}


# -- admission ----------------------------------------------------------------

def _note_pending_trust(session, pending) -> None:
    """One bounded, deduplicated diagnostic per pending hook; never raises."""
    if not isinstance(session, dict) or not pending:
        return
    try:
        log = session.setdefault("hook_diagnostics", [])
        if not isinstance(log, list):
            return
        seen = {entry.get("digest") for entry in log
                if isinstance(entry, dict) and entry.get("kind") == "pending_trust"}
        for row in pending:
            if row["digest"] in seen:
                continue
            seen.add(row["digest"])
            log.append({"kind": "pending_trust", "id": row["id"],
                        "event": row["event"], "source": row["source"],
                        "sourcePath": row["sourceRelative"], "digest": row["digest"],
                        "message": "workspace hook is pending trust and was not run"})
        if len(log) > MAX_DIAGNOSTICS:
            del log[:-MAX_DIAGNOSTICS]
    except Exception:  # noqa: BLE001 - diagnostics must never break a run
        pass


def admitted(state_dir, root, session=None) -> dict:
    """Which workspace hooks may run, which are pending, and why.

    The feature switch gates everything: while it is off this returns
    ``feature_disabled`` without reading a single workspace file.
    """
    empty = {"hooks": [], "pending": [], "reason": "feature_disabled",
             "diagnostics": [], "bundleDigest": None}
    feature = feature_status(state_dir)
    if not feature["enabled"]:
        return empty
    workspace = canonical_workspace(root)
    if workspace is None:
        return {**empty, "reason": "no_workspace"}
    found = discover(workspace)
    trust = load_trust(state_dir)
    trusted = frozenset()
    if trust["status"] == "ok":
        trusted = frozenset(record["digest"] for record in trust["records"]
                            if record["workspace"] == workspace)
    admitted_rows: list = []
    pending: list = []
    for row in found["hooks"]:
        if not row["enabled"]:
            continue
        (admitted_rows if row["digest"] in trusted else pending).append(row)
    if trust["status"] == "corrupt":
        reason = "trust_store_corrupt"
    elif not found["hooks"]:
        reason = "no_workspace_hooks"
    elif pending:
        reason = "pending_trust"
    elif admitted_rows:
        reason = "trusted"
    else:
        reason = "no_enabled_hooks"
    _note_pending_trust(session, pending)
    return {"hooks": admitted_rows, "pending": pending, "reason": reason,
            "diagnostics": found["diagnostics"], "bundleDigest": found["bundleDigest"],
            "trustStatus": trust["status"], "corruptPath": trust["corruptPath"],
            "featureStatus": feature["status"]}


def _runner_row(row: dict) -> dict:
    """The minimal hook dict the existing HookRunner understands."""
    hook = {"id": row["id"], "event": row["event"], "command": row["command"]}
    if row.get("matcher"):
        hook["matcher"] = row["matcher"]
    if row.get("args"):
        hook["args"] = list(row["args"])
    if row.get("timeout") is not None:
        hook["timeout"] = row["timeout"]
    if row.get("pipeline"):
        hook["pipeline"] = True
    return hook


def extend_for_runner(state_dir, root, user_hooks, session=None) -> list:
    """User hooks first, admitted workspace hooks after; never raises.

    With the feature off (the default) this is exactly ``user_hooks`` and no
    workspace file is read, so existing user-hook behaviour is untouched.
    """
    user = list(user_hooks or [])
    try:
        extra = admitted(state_dir, root, session)["hooks"]
    except Exception:  # noqa: BLE001 - admission must degrade, not fail a run
        return user
    return user + [_runner_row(row) for row in extra]


# -- status document (CLI review / HTTP read-only) ----------------------------

def status_document(state_dir, root) -> dict:
    """The full review document: every declaration, its digest and trust state."""
    workspace = canonical_workspace(root)
    feature = feature_status(state_dir)
    if not feature["enabled"] or workspace is None:
        return {"workspace": workspace, "featureEnabled": False,
                "featureStatus": feature["status"], "bundleDigest": None,
                "reason": "feature_disabled" if not feature["enabled"] else "no_workspace",
                "trustStatus": "unknown", "corruptPath": None,
                "items": [], "diagnostics": []}
    found = discover(workspace)
    trust = load_trust(state_dir)
    trusted = frozenset()
    if trust["status"] == "ok":
        trusted = frozenset(record["digest"] for record in trust["records"]
                            if record["workspace"] == workspace)
    items = [{"id": row["id"], "event": row["event"],
              "matcher": row.get("matcher"),
              "command": display_command(row), "source": row["source"],
              "sourcePath": row["sourceRelative"], "enabled": row["enabled"],
              "digest": row["digest"],
              "trustState": "trusted" if row["digest"] in trusted else "pending_trust"}
             for row in found["hooks"]]
    enabled_items = [item for item in items if item["enabled"]]
    if trust["status"] == "corrupt":
        reason = "trust_store_corrupt"
    elif not items:
        reason = "no_workspace_hooks"
    elif not enabled_items:
        reason = "no_enabled_hooks"
    elif any(item["trustState"] != "trusted" for item in enabled_items):
        reason = "pending_trust"
    else:
        reason = "trusted"
    return {"workspace": workspace, "featureEnabled": True,
            "featureStatus": feature["status"], "bundleDigest": found["bundleDigest"],
            "reason": reason, "trustStatus": trust["status"],
            "corruptPath": trust["corruptPath"], "items": items,
            "diagnostics": found["diagnostics"]}
