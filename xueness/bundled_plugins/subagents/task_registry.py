"""Task registry: task ids, progress mirroring and cancellation for sub-runs.

Why this exists: a delegated sub-run (the ``task`` tool) used to be a black box.
The parent saw one line at the end -- a summary or nothing -- and had no way to
ask what was running, how far along it was, or to change its mind. Everything a
caller needed to make those decisions (id, agent, step count, status) lived only
inside the child's own dict, which was discarded when the call returned.

This registry keeps that metadata alive for the duration of the run and cancels
cooperatively:

* **One id per run**, minted here, so a parent can name a sub-run in a log line.
* **Metadata only.** The prompt itself is never stored -- only its length. The
  child prompt is untrusted text, and a mirror that copied it would spread that
  text into every progress surface that reads the registry.
* **Cancellation is a flag, not a kill.** ``cancel`` marks the task; the child
  checks between steps and stops at a boundary, so no tool call is torn in half.

In-process and thread-safe, matching the rest of the harness: there is no
distributed scheduler here and this must not pretend to be one.
"""
from __future__ import annotations

import threading
import time
import uuid

#: Summary/error caps, matching the sub-agent result contract.
SUMMARY_MAX = 4000
ERROR_MAX = 500

RUNNING = "running"
COMPLETED = "completed"
FAILED = "failed"
CANCELLED = "cancelled"


class TaskRegistry:
    """Live metadata for delegated sub-runs, keyed by task id."""

    def __init__(self):
        self._guard = threading.Lock()
        self._tasks: dict[str, dict] = {}

    @staticmethod
    def new_id() -> str:
        """A fresh task id.

        Deliberately *not* the child session id (``sub-…``): the child session is
        an internal detail that the parent journal must not carry, and an
        existing invariant pins that. A task id is a name for the *delegation*,
        which is exactly what a parent needs to refer to one.
        """
        return "task-" + uuid.uuid4().hex

    def record(self, task_id, *, parent_session, agent, prompt, root) -> dict:
        """Register a starting task and return its metadata.

        ``prompt`` is measured, never stored: only its character count survives.

        If this id is already marked cancelled, the cancellation is preserved.
        A cancel that a later ``record`` could clear would be a cancel that did
        not work -- and the ordering (cancel arrives, then the child starts) is
        exactly the race a parent is most likely to hit.
        """
        text = prompt if isinstance(prompt, str) else ""
        with self._guard:
            existing = self._tasks.get(task_id)
            task = {
                "id": task_id,
                "parent": parent_session,
                "agent": agent if isinstance(agent, str) and agent else None,
                "promptChars": len(text),
                "status": RUNNING,
                "steps": 0,
                "startedAt": time.time(),
                "endedAt": None,
                "summary": "",
                "error": "",
                "root": str(root) if root is not None else None,
            }
            if existing is not None and existing.get("status") == CANCELLED:
                task["status"] = CANCELLED
                task["endedAt"] = existing.get("endedAt")
            self._tasks[task_id] = task
            return dict(task)

    def update(self, task_id, **fields) -> None:
        """Merge ``fields`` into a live task. Unknown ids are ignored.

        Silently ignoring an unknown id is deliberate: a task that already
        finished and was forgotten should not resurrect as a half-record.
        """
        with self._guard:
            task = self._tasks.get(task_id)
            if task is None:
                return
            for key, value in fields.items():
                if key in ("id", "parent", "startedAt"):
                    continue
                task[key] = value

    def restore(self, task_id, *, parent_session, root, record) -> None:
        """Restore a bounded persisted projection without inventing start times."""
        with self._guard:
            if task_id in self._tasks:
                return
            terminal = record.get('status') in (COMPLETED, FAILED, CANCELLED)
            self._tasks[task_id] = {
                'id': task_id, 'parent': parent_session, 'root': str(root),
                'agent': record.get('agent') if isinstance(record.get('agent'), str) else None,
                'status': record.get('status') if terminal else FAILED,
                'steps': record.get('steps', 0), 'promptChars': record.get('promptChars', 0),
                'startedAt': record.get('startedAt'), 'endedAt': record.get('endedAt'),
                'summary': str(record.get('summary') or '')[:SUMMARY_MAX],
                'error': (str(record.get('error') or '')[:ERROR_MAX] if terminal
                          else 'interrupted before result collection'),
                'workerActive': False,
            }

    def finish(self, task_id, *, ok, summary="", error="", steps=None) -> dict:
        """Terminal transition. Returns the final record (or an empty dict)."""
        with self._guard:
            task = self._tasks.get(task_id)
            if task is None:
                return {}
            # A cancelled task stays cancelled: the run stopping is the cancel
            # taking effect, not a failure, and not a success either.
            if task.get("status") != CANCELLED:
                task["status"] = COMPLETED if ok else FAILED
            task["endedAt"] = time.time()
            task["summary"] = (summary or "")[:SUMMARY_MAX]
            task["error"] = (error or "")[:ERROR_MAX]
            if steps is not None:
                task["steps"] = steps
            return dict(task)

    def get(self, task_id):
        with self._guard:
            task = self._tasks.get(task_id)
            return dict(task) if task is not None else None

    def list(self, parent_session=None) -> list:
        """Tasks in start order, optionally filtered to one parent session."""
        with self._guard:
            tasks = [dict(task) for task in self._tasks.values()
                     if parent_session is None or task.get("parent") == parent_session]
        tasks.sort(key=lambda task: (task.get("startedAt") or 0, task.get("id") or ""))
        return tasks

    def cancel(self, task_id) -> bool:
        """Flag a task for cooperative cancellation. False when it is not live.

        A task that already reached a terminal state is not cancellable: saying
        so is more honest than flipping a finished record back to cancelled.
        """
        with self._guard:
            task = self._tasks.get(task_id)
            if task is None or task.get("status") != RUNNING:
                return False
            task["status"] = CANCELLED
            task["endedAt"] = time.time()
            return True

    def is_cancelled(self, task_id) -> bool:
        with self._guard:
            task = self._tasks.get(task_id)
            return bool(task is not None and task.get("status") == CANCELLED)

    def forget(self, task_id) -> None:
        """Drop a finished task from the live table."""
        with self._guard:
            self._tasks.pop(task_id, None)

    def clear(self) -> None:
        """Drop everything. Tests only."""
        with self._guard:
            self._tasks.clear()


def mirror(registry, parent_session) -> list:
    """Read-only progress projection for one parent session.

    Returns the registry's current view without touching the journal: the mirror
    is derived state, and persisting it would make a stale copy authoritative.
    """
    if registry is None:
        return []
    return registry.list(parent_session)
