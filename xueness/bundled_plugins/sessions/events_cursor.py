"""Incremental cursor paging on the legacy session events route.

Experimental feature ``sessions.events_cursor``: with settings key
``general.sessionsEventsCursorEnabled`` (default off) the legacy endpoint
``GET /api/sessions/<sid>/events`` additionally accepts ``cursor`` (alias
``since``) and answers with an incremental window plus ``next_cursor``.
Clients that send no cursor parameter keep the unchanged legacy response,
so existing callers never see a difference.

Paging semantics (events.v1 semantics where they apply, documented where
they differ):

* The legacy derivation is deterministic, so it is numbered with a dense
  ``seq`` from 1 and a window returns ``seq > cursor`` in order, up to
  ``limit``. ``next_cursor`` is the last delivered ``seq`` (or the request
  cursor when nothing was new); ``has_more`` says whether another page is
  already waiting.
* Journal growth appends events, but compaction or a cleared pending
  question can shrink and renumber the list. A cursor beyond the current
  head is therefore rejected with 400 instead of silently answering an
  empty page: the client resyncs from 0 (or falls back to the legacy
  response) and can never miss renumbered events.
* ``seq`` 1 is the status event, which mutates in place while a run
  progresses; status and steps always travel in the envelope fields, never
  as repeated events.

The flag is read from the state directory bound to the request context on
every call, so toggling it takes effect without a restart. It never widens
anything: the route still only answers for a validated session id inside
this server's store, and payloads stay the truncated legacy summaries.
"""
from __future__ import annotations

import re
import sys

from ... import web as host

#: Stable ids for the feature catalog and the not-enabled answer.
FEATURE_ID = 'sessions.events_cursor'
SETTINGS_SECTION = 'general'
SETTINGS_KEY = 'sessionsEventsCursorEnabled'
NOT_ENABLED_ERROR = FEATURE_ID + ' not enabled'

#: JSON numbers lose integer precision beyond 2**53-1 in every browser
#: client, so a cursor that could not round-trip is rejected, not paged.
MAX_CURSOR = (1 << 53) - 1
#: Window bounds shared with the legacy route and events.v1.
DEFAULT_LIMIT = 200
MAX_LIMIT = 500

_DIGITS = re.compile(r'[0-9]+\Z')


class CursorError(ValueError):
    """A rejected cursor/limit value; the HTTP layer answers 400 with it."""


def enabled(ctx) -> bool:
    """The persistent flag, read from the state directory bound to ``ctx``."""
    from ..settings.settings_store import load_settings
    section = load_settings(ctx['state_dir']).get(SETTINGS_SECTION, {})
    return isinstance(section, dict) and section.get(SETTINGS_KEY) is True


def _first(raw) -> str:
    if isinstance(raw, (list, tuple)):
        return str(raw[0]) if raw else ''
    return str(raw)


def requested_cursor(query) -> int | None:
    """Parse ``cursor``/``since`` from a parsed query mapping.

    Returns ``None`` when neither name carries a value (a legacy request;
    ``parse_qs`` drops empty values, and an explicit empty string counts as
    absent too). Both names accept the same non-negative integer; conflicting
    values are rejected. Anything else — whitespace, signs, fractions —
    raises :class:`CursorError`; a value beyond :data:`MAX_CURSOR` could not
    round-trip through a JSON client and is rejected as well.
    """
    texts = []
    for key in ('cursor', 'since'):
        if not isinstance(query, dict) or key not in query:
            continue
        text = _first(query[key])
        if text:
            texts.append(text)
    if not texts:
        return None
    values = []
    for text in texts:
        if not _DIGITS.fullmatch(text):
            raise CursorError('invalid cursor')
        value = int(text)
        if value > MAX_CURSOR:
            raise CursorError('cursor too large')
        values.append(value)
    if any(value != values[0] for value in values[1:]):
        raise CursorError('conflicting cursor values')
    return values[0]


def requested_limit(query, default: int = DEFAULT_LIMIT) -> int:
    """Parse ``limit`` for a cursor request; digits only, clamped to 1..500.

    Unlike the legacy route, which falls back to 200 on garbage, a cursor
    request with a malformed limit is rejected: the incremental client is
    new and gets strict answers. Out-of-range values clamp, as before.
    """
    if not isinstance(query, dict) or 'limit' not in query:
        return default
    text = _first(query['limit'])
    if not _DIGITS.fullmatch(text):
        raise CursorError('invalid limit')
    return max(1, min(int(text), MAX_LIMIT))


def numbered_events(session: dict) -> list[dict]:
    """The full legacy derivation with a dense ``seq`` from 1 (no tail cut)."""
    events = host.session_events(session, sys.maxsize)
    return [{**event, 'seq': seq} for seq, event in enumerate(events, 1)]


def page(session: dict, cursor: int, limit: int) -> dict:
    """Build the incremental envelope for a validated cursor request.

    Raises :class:`CursorError` when ``cursor`` sits beyond the current
    head: the derivation shrank (compaction, cleared pending question) or
    the value was fabricated, and the only safe answer is a resync.
    """
    events = numbered_events(session)
    head = len(events)
    if cursor > head:
        raise CursorError('cursor ahead of session head')
    window = events[cursor:cursor + max(1, limit)]
    return {
        'id': session['id'],
        'status': session.get('status'),
        'steps': session.get('steps', 0),
        'events': window,
        'next_cursor': window[-1]['seq'] if window else cursor,
        'has_more': cursor + max(1, limit) < head,
    }
