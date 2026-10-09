"""Explicit cancel receipt for ``POST /api/sessions/<sid>/stop``.

Feature ``sessions.cancel_receipt``. Settings key
``general.sessionsCancelReceiptEnabled`` must be boolean true. While the flag
is off the stop response stays exactly ``{id, stopping, status,
cancelled_tasks}`` and HTTP stays 200 either way.

A stop that finds nothing live used to look the same as a stop that flagged
the session and cancelled tasks: ``cancelled_tasks: []`` and ``stopping:
false``. With the flag on, the same response adds ``outcome`` and one ``works``
row per attempt. ``rejected`` means a task still looked running but ``cancel``
returned false (already finished, or the registry refused). ``idle`` means
there was nothing to cancel. The receipt copies only short work ids, never
task summaries or prompt text.

Reference (idea, not copied code): ZCode v3.14.3
``apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/interaction-background.ts``
(``cancelBackgroundWork`` returns an explicit fault when nothing was cancelled).
"""
from __future__ import annotations

FEATURE_ID = 'sessions.cancel_receipt'
SETTINGS_SECTION = 'general'
SETTINGS_KEY = 'sessionsCancelReceiptEnabled'
SCHEMA = 'xueness.cancel-receipt.v1'

#: Receipt copy only. ``cancelled_tasks`` keeps the registry id unchanged.
MAX_WORK_ID = 80


def enabled(ctx) -> bool:
    """Persistent flag for the state directory bound to ``ctx``. Only real True."""
    from ..settings.settings_store import load_settings
    try:
        state_dir = ctx['state_dir']
    except (KeyError, TypeError):
        return False
    try:
        section = load_settings(state_dir).get(SETTINGS_SECTION, {})
    except (OSError, ValueError, TypeError):
        return False
    return isinstance(section, dict) and section.get(SETTINGS_KEY) is True


def work_id(value) -> str:
    """A short printable id for the receipt. Control characters are dropped."""
    if isinstance(value, str):
        text = value
    elif value is None:
        text = ''
    else:
        text = str(value)
    cleaned = ''.join(ch for ch in text if ch.isprintable() and ch != '\x7f')
    return cleaned[:MAX_WORK_ID]


def build(session_id, *, busy, tasks):
    """Extra stop-response fields. Does not include the legacy keys.

    ``tasks`` is the list the stop handler already classified:
    ``{workId, outcome}`` with ``outcome`` ``cancelled`` or ``rejected``.
    A busy session is ``stop_requested`` even when tasks were also cancelled;
    the per-work rows still say what happened to each task.
    """
    works = [{
        'workId': work_id(session_id),
        'kind': 'session',
        'outcome': 'stop_requested' if busy else 'idle',
    }]
    for item in tasks or ():
        if not isinstance(item, dict):
            continue
        outcome = item.get('outcome')
        if outcome not in ('cancelled', 'rejected'):
            continue
        entry = {
            'workId': work_id(item.get('workId')),
            'kind': 'task',
            'outcome': outcome,
        }
        if outcome == 'rejected':
            entry['reason'] = 'not_running'
        works.append(entry)
    task_outcomes = [item['outcome'] for item in works if item['kind'] == 'task']
    if busy:
        outcome, reason = 'stop_requested', None
    elif 'cancelled' in task_outcomes:
        outcome, reason = 'cancelled', None
    elif 'rejected' in task_outcomes:
        outcome, reason = 'rejected', 'not_running'
    else:
        outcome, reason = 'idle', 'nothing_running'
    body = {
        'schema': SCHEMA,
        'feature': FEATURE_ID,
        'outcome': outcome,
        'works': works,
    }
    if reason is not None:
        body['reason'] = reason
    return body
