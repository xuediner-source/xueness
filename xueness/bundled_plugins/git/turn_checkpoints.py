"""Automatic per-turn workspace checkpoints and turn-based rewind.

ZCode-style safety net: after the first write/exec capability of a conversation
turn passes Gate and before its handler continues, the workspace is snapshotted
once, so the turn can be undone without losing files it did not touch.

Everything here is deliberately inert outside its own conditions: a disabled
plugin, a non-git workspace, a remote-bound session or a missing policy store
each return without touching the run. The snapshot itself is the existing
``actions.checkpoint`` (temporary index, real index preserved), and rewind is
``actions.restore``, which writes a scoped recovery snapshot first.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from ... import plugin_runtime
from ...session_lease import lease
from . import actions

#: Turn records kept per session; older ones fall off like the hook log does.
MAX_RECORDS = 200
RECORD_FIELDS = ("turn", "checkpointId", "hash", "message", "tool", "createdAt")
#: ``Gate`` kinds that change the workspace or run a command. Read-only tools
#: never trigger a snapshot.
SNAPSHOT_GATE_KINDS = frozenset({"write", "edit", "exec"})
SESSION_RE = re.compile(r"[0-9a-f]{32}")
REWIND_KEYS = frozenset({"confirmed", "checkpoint", "latest", "root"})


class RewindError(ValueError):
    """An expected rewind refusal, with the status the API should report."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def turn_of(session: dict) -> int:
    """Current human-turn ordinal, matching the count used across sessions."""
    messages = session.get("messages")
    if not isinstance(messages, list):
        return 0
    return sum(isinstance(message, dict) and message.get("role") == "user"
               for message in messages)


def records(session) -> list:
    raw = session.get("turn_checkpoints") if isinstance(session, dict) else None
    return [item for item in raw if isinstance(item, dict) and item.get("checkpointId")] \
        if isinstance(raw, list) else []


def repository(root) -> bool:
    """True when ``root`` is a usable git workspace; never raises."""
    if not isinstance(root, str) or not root:
        return False
    try:
        actions._git(root, ["rev-parse", "--is-inside-work-tree"])
    except Exception:
        return False
    return True


def _state_dir(ctx: dict, store=None):
    state_dir = (ctx or {}).get("state_dir")
    if state_dir is None:
        state_dir = getattr(store if store is not None else (ctx or {}).get("store"),
                            "directory", None)
    return state_dir


def enabled(state_dir) -> bool:
    if state_dir is None:
        return False  # No policy store means no proof the plugin is effective.
    try:
        return bool(plugin_runtime.is_enabled(state_dir, "git"))
    except Exception:
        return False


def record_turn(state_dir, session, store, *, tool_name="", gate_kind="") -> dict | None:
    """Snapshot the workspace once for the current turn; never breaks a run.

    Called from the kernel's post-Gate seam, so a failure here must degrade to
    "no checkpoint" rather than propagate into a tool result.
    """
    try:
        if store is None or session is None or gate_kind not in SNAPSHOT_GATE_KINDS:
            return None
        if session.get("remote_connection"):
            return None  # The mutated files live on the remote host, not here.
        if not enabled(state_dir):
            return None
        turn = turn_of(session)
        if turn < 1:
            return None
        existing = records(session)
        if any(item.get("turn") == turn for item in existing):
            return None  # One snapshot per turn, whatever the step count.
        root = session.get("root")
        if not repository(root):
            return None
        commit = actions.checkpoint(root, "Turn %d before first change" % turn)
        entry = {
            "sessionId": session.get("id"),
            "turn": turn,
            "checkpointId": commit["id"],
            "hash": commit["hash"],
            "message": commit["message"],
            "tool": tool_name or "",
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        existing.append(entry)
        session["turn_checkpoints"] = existing[-MAX_RECORDS:]
        store.save(session)
        return entry
    except Exception:
        return None


def resolve(session: dict, *, checkpoint: str | None = None, latest: bool = False) -> dict:
    existing = records(session)
    if not existing:
        raise RewindError("该会话没有可用的轮次检查点", 409)
    if latest or checkpoint is None:
        return existing[-1]
    match = next((item for item in existing if item.get("checkpointId") == checkpoint), None)
    if match is None:
        raise RewindError("未知的轮次检查点", 404)
    return match


def list_for(ctx: dict, sid: str) -> dict:
    store = ctx["store"]
    if not enabled(_state_dir(ctx, store)):
        raise RewindError("plugin disabled or dependency unavailable: git", 403)
    session = _load(store, sid)
    return {"session": sid, "repository": repository(session.get("root")),
            "turns": [{key: item.get(key) for key in RECORD_FIELDS} for item in records(session)]}


def _load(store, sid: str) -> dict:
    try:
        return store.load(sid)
    except (OSError, ValueError, KeyError):
        raise RewindError("session not found", 404) from None


def rewind(ctx: dict, sid: str, *, checkpoint: str | None = None, latest: bool = False,
           confirmed=None, root: str | None = None) -> dict:
    """Restore the workspace to a turn snapshot, after a recovery snapshot."""
    store = ctx["store"]
    state_dir = _state_dir(ctx, store)
    if not enabled(state_dir):
        raise RewindError("plugin disabled or dependency unavailable: git", 403)
    if confirmed is not True:
        raise RewindError("review and confirm this rewind")
    session = _load(store, sid)
    workspace = session.get("root")
    if not repository(workspace):
        raise RewindError("该工作区不是 git 仓库", 404)
    if root is not None:
        try:
            requested = Path(root).resolve(strict=True)
            pinned = Path(workspace).resolve(strict=True)
        except (OSError, ValueError):
            raise RewindError("工作区目录不可用", 409) from None
        if requested != pinned:
            raise RewindError("--root 与该会话的工作区不一致", 403)
    target = resolve(session, checkpoint=checkpoint, latest=latest)
    result = actions.restore(workspace, target["checkpointId"])
    result["turn"] = target.get("turn")
    result["restoredFrom"] = target.get("checkpointId")
    return result


def after_tool_authorization(payload: dict) -> None:
    """Kernel seam contribution: snapshot after Gate and before handler effects."""
    record_turn(payload.get("state_dir"), payload.get("session"), payload.get("store"),
                tool_name=payload.get("tool") or "", gate_kind=payload.get("gate_kind") or "")


def dispatch(method, parts, query, data, ctx):
    """``/api/sessions/<sid>/git/turn-checkpoints[/rewind]``; None means not ours.

    The host already maps every ``api/sessions/*/git/*`` path to this plugin and
    applies Host/Origin/CSRF checks; ``enabled`` repeats the switch here because
    these handlers are also reachable from the CLI through the same dispatch.
    """
    if not isinstance(parts, list) or len(parts) not in (5, 6) or parts[:2] != ["api", "sessions"]:
        return None
    if len(parts) < 5 or parts[3] != "git" or parts[4] != "turn-checkpoints":
        return None
    sid = parts[2]
    if not isinstance(sid, str) or not SESSION_RE.fullmatch(sid):
        return None
    if len(parts) == 5:
        if method != "GET":
            return 405, {"error": "method not allowed"}
        try:
            return 200, list_for(ctx, sid)
        except RewindError as exc:
            return exc.status, {"error": str(exc)}
        except (OSError, ValueError, KeyError):
            return 400, {"error": "cannot list turn checkpoints"}
    if parts[5] != "rewind":
        return None
    if method != "POST":
        return 405, {"error": "method not allowed"}
    if not isinstance(data, dict) or set(data) - REWIND_KEYS or "confirmed" not in data:
        return 400, {"error": "expected confirmed, with checkpoint or latest"}
    checkpoint = data.get("checkpoint")
    latest = data.get("latest", False)
    root = data.get("root")
    if (checkpoint is not None and not (isinstance(checkpoint, str) and SESSION_RE.fullmatch(checkpoint))
            or not isinstance(latest, bool)
            or root is not None and (not isinstance(root, str) or not 0 < len(root) <= 4096)):
        return 400, {"error": "invalid rewind target"}
    if (checkpoint is not None) == (latest is True):
        return 400, {"error": "expected exactly one of checkpoint or latest"}
    try:
        with lease(ctx["store"], sid):
            return 200, rewind(ctx, sid, checkpoint=checkpoint, latest=latest,
                               confirmed=data.get("confirmed"), root=root)
    except RewindError as exc:
        return exc.status, {"error": str(exc)}
    except BlockingIOError:
        return 409, {"error": "workspace session is in use"}
    except (OSError, ValueError, KeyError):
        return 400, {"error": "cannot rewind workspace"}
