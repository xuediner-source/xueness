"""Hook loader + executor (Stage 4 contract).

Hooks are user-configured commands that run at fixed points of a run. The
settings page stores them as resources (Stage 2 ``resources.py`` product)::

    <state_dir>/resources/hooks/<id>.json

Each file is a JSON object with ``id``, ``event``, ``command`` and optional
``matcher`` / ``args`` / ``enabled`` / ``timeout``.

Like ``skills.py`` this loader never writes anything, refuses symlinked
entries and a symlinked directory (``O_NOFOLLOW``), and skips a single broken
entry instead of failing the whole list.

Execution is opt-in and deliberately paranoid:

* ``enabled=False`` short-circuits ``fire`` before any process is spawned.
* POSIX children see only ``PATH`` and ``HOME``; Windows also restores a fixed
  public OS/runtime allowlist, never the full private environment, so
  server secrets cannot leak into a user hook.
* the event payload travels on **stdin** as JSON, not through argv or env.
* argv is a list with ``shell=False``; the command is never a shell string.
* a per-hook timeout is clamped by ``timeout_cap`` and merged output is
  truncated to ``output_cap``.
* no exception from a hook (missing binary, bad arguments, invalid regex,
  timeout) may propagate: every failure becomes ``exit_code: -1``.

Exit codes follow the Claude Code convention:

* ``0`` -> pass
* ``2`` -> block (only meaningful for ``PreToolUse``)
* anything else non-zero -> a warning, never a block
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path
from ...resources import _is_link, _kind_dir

from ...process_runtime import run_external

# The seven upstream events, in upstream order.
HOOK_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
)

EXIT_BLOCK = 2
DEFAULT_TIMEOUT_CAP = 30
DEFAULT_OUTPUT_CAP = 2000

#: The two Post events a hook may move onto the kernel tool event pipeline
#: with an explicit ``"pipeline": true`` declaration. For these events the
#: legacy fire point skips pipeline hooks and the pipeline fires only them,
#: so a hook runs exactly once whichever way it is wired. For every other
#: event the flag is ignored and behaviour is unchanged.
POST_PIPELINE_EVENTS = ("PostToolUse", "PostToolUseFailure")

TRUNCATION_SUFFIX = "…(truncated)"

# Characters of a hook's output echoed back as a pre_tool_use summary.
SUMMARY_CAP = 500


def clip(text, max_chars: int) -> str:
    """Trim ``text`` to ``max_chars`` characters, keeping a truncation marker."""
    t = text if isinstance(text, str) else str(text)
    if not max_chars or len(t) <= max_chars:
        return t
    keep = max_chars - len(TRUNCATION_SUFFIX)
    if keep <= 0:
        return TRUNCATION_SUFFIX[:max_chars]
    return t[:keep] + TRUNCATION_SUFFIX


def _hooks_dir(state_dir) -> Path:
    return Path(state_dir) / "resources" / "hooks"


def _safe_read_json(path: Path):
    """Read one hook file, refusing symlinks (``O_NOFOLLOW``).

    A symlinked entry, an unreadable file, invalid JSON, and a document that
    is not an object all yield ``None`` so one broken entry can never take
    down the list or echo back a foreign file.
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
    """Every usable hook under ``<state_dir>/resources/hooks``, id ascending.

    Skips (in this order): a symlinked directory, symlinked entries, broken
    JSON / non-object documents, entries without a usable ``id``, disabled
    entries, unknown events, and non-string or blank commands. One bad entry
    only costs that entry.
    """
    try:
        hooks_dir = _kind_dir({"state_dir": state_dir}, "hooks")
    except (OSError, ValueError):
        return []
    # A symlinked directory would relocate the whole jail; refuse it outright.
    if _is_link(hooks_dir):
        return []
    if not hooks_dir.is_dir():
        return []
    hooks = []
    for path in sorted(hooks_dir.glob("*.json")):
        if _is_link(path):
            continue
        item = _safe_read_json(path)
        if item is None:
            continue
        hook_id = item.get("id")
        if not isinstance(hook_id, str) or not hook_id.strip():
            continue
        if item.get("enabled") is False:
            continue
        if item.get("event") not in HOOK_EVENTS:
            continue
        command = item.get("command")
        if not isinstance(command, str) or not command.strip():
            continue
        hook = dict(item)
        hook["id"] = hook_id.strip()
        hooks.append(hook)
    hooks.sort(key=lambda hook: hook["id"])
    return hooks


def _subject_text(subject) -> str:
    return subject if isinstance(subject, str) else ""


def select(hooks, event, subject=None) -> list:
    """Hooks whose event matches and whose matcher accepts ``subject``.

    ``matcher`` absent, empty or ``*`` matches everything; otherwise it is a
    regular expression searched against ``subject`` (the tool name for
    ``PreToolUse``, ``''`` elsewhere). An invalid regex matches nothing and
    never raises.
    """
    subject_text = _subject_text(subject)
    matches = []
    for hook in hooks or []:
        if not isinstance(hook, dict) or hook.get("event") != event:
            continue
        matcher = hook.get("matcher")
        if matcher is None or matcher == "" or matcher == "*":
            matches.append(hook)
            continue
        if not isinstance(matcher, str):
            continue
        try:
            pattern = re.compile(matcher)
        except re.error:
            continue
        try:
            if pattern.search(subject_text):
                matches.append(hook)
        except re.error:
            continue
    return matches


class HookRunner:
    """Runs the selected hooks for an event and reports structured results."""

    def __init__(self, hooks, root, *, enabled=True, timeout_cap: int = DEFAULT_TIMEOUT_CAP,
                 output_cap: int = DEFAULT_OUTPUT_CAP):
        self.hooks = [hook for hook in (hooks or []) if isinstance(hook, dict)]
        try:
            self.root = Path(root) if root is not None else None
        except TypeError:
            self.root = None
        self.enabled = bool(enabled)
        self.timeout_cap = timeout_cap
        self.output_cap = output_cap

    @property
    def active(self) -> bool:
        """True when hooks may fire: enabled and at least one hook loaded."""
        return bool(self.enabled and self.hooks)

    # --- execution ----------------------------------------------------------

    def _timeout_for(self, hook) -> float:
        try:
            cap = float(self.timeout_cap)
        except (TypeError, ValueError):
            cap = float(DEFAULT_TIMEOUT_CAP)
        if cap <= 0:
            cap = float(DEFAULT_TIMEOUT_CAP)
        try:
            requested = hook.get("timeout")
            seconds = float(requested) if requested else cap
        except (TypeError, ValueError):
            seconds = cap
        if seconds <= 0:
            seconds = cap
        return min(seconds, cap)

    def _run(self, hook, event: str, payload) -> dict:
        """Run one hook; never raises."""
        result = {
            "id": hook.get("id"),
            "event": event,
            "exit_code": -1,
            "blocked": False,
            "timeout": False,
            "duration_ms": 0,
            "output": "",
        }
        started = time.monotonic()
        try:
            command = hook.get("command")
            extra = hook.get("args") or []
            if not isinstance(extra, list):
                extra = []
            argv = [command] + list(extra)

            root = self.root
            if root is None or not root.is_dir():
                result["output"] = "invalid working directory; hook not executed"
                result["duration_ms"] = int((time.monotonic() - started) * 1000)
                return result

            env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
            }
            completed = run_external(
                subprocess.run,
                argv,
                shell=False,
                cwd=str(root),
                input=json.dumps(payload),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=self._timeout_for(hook),
                env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            )
            result["exit_code"] = int(completed.returncode)
            result["output"] = clip(completed.stdout or "", self.output_cap)
        except subprocess.TimeoutExpired as exc:
            # Timeout counts as "non-zero, non-2": never a block, always a warning.
            result["timeout"] = True
            result["exit_code"] = -1
            result["output"] = clip(_timeout_output(exc), self.output_cap)
        except Exception as exc:  # noqa: BLE001 - a hook must never break a run
            result["exit_code"] = -1
            result["output"] = clip(
                "%s: %s" % (type(exc).__name__, exc), self.output_cap)
        result["duration_ms"] = int((time.monotonic() - started) * 1000)
        result["blocked"] = bool(
            result["exit_code"] == EXIT_BLOCK and not result["timeout"])
        return result

    def _matches(self, event: str, subject=None) -> list:
        if not self.enabled:
            return []
        return select(self.hooks, event, subject)

    def fire(self, event, payload, *, pipeline: bool = False) -> list:
        """Run every hook selected for ``event``; ``[]`` when disabled/unmatched.

        ``matcher`` is driven by the tool name for the tool-scoped events. The
        run loop labels it ``tool_name`` on the Pre hook and ``tool`` on the
        Post hooks, so both keys are accepted — otherwise a matcher on
        ``PostToolUse`` could never match and the hook would silently never run.

        For the two Post events, ``pipeline`` selects which wiring runs: the
        default legacy fire point skips hooks that declared ``"pipeline": true``
        (the kernel tool event pipeline fires those instead, with the tool
        result in the payload), and ``pipeline=True`` fires only those. Every
        other event ignores the flag entirely, so existing hooks are unchanged.
        """
        subject = None
        if isinstance(payload, dict) and event in (
            "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"
        ):
            subject = payload.get("tool_name") or payload.get("tool")
        matches = self._matches(event, subject)
        if event in POST_PIPELINE_EVENTS:
            matches = [hook for hook in matches
                       if bool(hook.get("pipeline")) is pipeline]
        if not matches:
            return []
        data = payload if isinstance(payload, dict) else {"payload": payload}
        return [self._run(hook, event, data) for hook in matches]

    # --- PreToolUse gate ----------------------------------------------------

    def pre_tool_use(self, tool_name, arguments) -> tuple:
        """``(allowed, message)`` for a tool call about to run.

        No match -> ``(True, '')``. Any hook exiting ``2`` -> ``(False, output)``.
        Otherwise -> ``(True, warning summary)``, which may be empty.
        """
        matches = self._matches("PreToolUse", tool_name)
        if not matches:
            return (True, "")
        payload = {
            "event": "PreToolUse",
            "tool_name": tool_name,
            "arguments": arguments,
        }
        results = [self._run(hook, "PreToolUse", payload) for hook in matches]
        for result in results:
            if result["exit_code"] == EXIT_BLOCK and not result["timeout"]:
                return (False, clip(result["output"], SUMMARY_CAP))
        notes = []
        for result in results:
            if result["exit_code"] == 0 and not result["timeout"]:
                continue
            # A timed-out child is killed before its pipe is drained (POSIX
            # ``subprocess.run``), so output may legitimately be empty; fall
            # back to a self-describing note rather than a silent warning.
            text = result["output"].strip()
            if not text:
                if result["timeout"]:
                    text = "hook %s timed out" % result["id"]
                else:
                    text = "hook %s exited with code %s" % (result["id"], result["exit_code"])
            notes.append(text)
        return (True, clip("; ".join(notes), SUMMARY_CAP))


def _timeout_output(exc) -> str:
    raw = getattr(exc, "stdout", None)
    if isinstance(raw, bytes):
        try:
            return raw.decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return ""
    return raw if isinstance(raw, str) else ""
