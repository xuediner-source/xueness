"""Incremental cursor paging on the legacy session events route.

Experimental feature ``sessions.events_cursor``: with settings key
``general.sessionsEventsCursorEnabled`` (default off) the legacy endpoint
``GET /api/sessions/<sid>/events`` additionally accepts ``cursor`` (alias
``since``). Cursor mode returns a numeric diagnostic ``next_cursor`` and a
revision-bound ``next_cursor_token`` for safe continuation. Clients that send
no cursor parameter keep the unchanged legacy response.

Paging semantics (events.v1 semantics where they apply, documented where
they differ):

* The derivation is numbered densely with ``seq`` from 1. ``cursor=0`` starts
  or resyncs; a nonzero numeric cursor cannot prove its consumed prefix is
  unchanged and is rejected with 409 plus ``resync_cursor: 0``. The response's
  opaque token binds a position to a hash of its consumed event prefix. Pass
  ``next_cursor_token`` as ``cursor`` or ``since`` to continue safely. A
  rewritten or shortened prefix rejects the token with 409 rather than
  silently skipping renumbered events.
* ``next_cursor`` is kept as a diagnostic/compatibility field. New clients
  must use ``next_cursor_token``; SSE ``id`` fields carry the same opaque token
  format so reconnects retain prefix validation.
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
import hashlib
import json
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
_TOKEN = re.compile(r'c1\.([0-9]+)\.([0-9a-f]{64})\Z')


class Cursor:
    """A numeric migration cursor or a revision-bound continuation token."""

    __slots__ = ('position', 'revision')

    def __init__(self, position: int, revision: str | None = None):
        self.position = position
        self.revision = revision

    def __eq__(self, other):
        if isinstance(other, int):
            return self.position == other and self.revision is None
        return (isinstance(other, Cursor)
                and self.position == other.position
                and self.revision == other.revision)

    def __repr__(self):
        if self.revision is None:
            return f'Cursor({self.position})'
        return f'Cursor({self.position}, {self.revision!r})'

    @property
    def token(self) -> bool:
        return self.revision is not None


class CursorError(ValueError):
    """A rejected cursor/limit value; the HTTP layer answers with its status."""

    def __init__(self, message, *, status=400, code='xueness.error.invalid_argument',
                 resync_cursor=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.resync_cursor = resync_cursor


class ResyncRequired(CursorError):
    """A prior numeric position cannot prove that its event prefix is intact."""

    def __init__(self, message='cursor revision required'):
        super().__init__(message, status=409, code='sessions.events_cursor.resync_required',
                         resync_cursor=0)


def enabled(ctx) -> bool:
    """The persistent flag, read from the state directory bound to ``ctx``."""
    from ..settings.settings_store import load_settings
    section = load_settings(ctx['state_dir']).get(SETTINGS_SECTION, {})
    return isinstance(section, dict) and section.get(SETTINGS_KEY) is True


def _first(raw) -> str:
    if isinstance(raw, (list, tuple)):
        return str(raw[0]) if raw else ''
    return str(raw)


def requested_cursor(query) -> Cursor | None:
    """Parse ``cursor``/``since`` from a parsed query mapping.

    Returns ``None`` when neither name carries a value (a legacy request;
    ``parse_qs`` drops empty values, and an explicit empty string counts as
    absent too). Both names accept either a non-negative numeric migration
    cursor or an opaque revision token; conflicting values are rejected.
    Numeric positions other than zero are parsed for compatibility but later
    require resync because they carry no prefix revision. Anything malformed
    or beyond :data:`MAX_CURSOR` is rejected.
    """
    texts = []
    for key in ('cursor', 'since'):
        if not isinstance(query, dict) or key not in query:
            continue
        raw = query[key]
        values = raw if isinstance(raw, (list, tuple)) else (raw,)
        for value in values:
            text = str(value)
            if text:
                texts.append(text)
    if not texts:
        return None
    values = []
    for text in texts:
        token_match = _TOKEN.fullmatch(text)
        if token_match:
            try:
                position = int(token_match.group(1))
            except ValueError:
                raise CursorError('cursor too large') from None
            if position > MAX_CURSOR:
                raise CursorError('cursor too large')
            values.append(Cursor(position, token_match.group(2)))
            continue
        if not _DIGITS.fullmatch(text):
            raise CursorError('invalid cursor')
        try:
            value = int(text)
        except ValueError:
            raise CursorError('cursor too large') from None
        if value > MAX_CURSOR:
            raise CursorError('cursor too large')
        values.append(Cursor(value))
    if any(value.position != values[0].position or value.revision != values[0].revision
           for value in values[1:]):
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
    try:
        value = int(text)
    except ValueError:
        # Python bounds decimal conversion length; an oversized query is still
        # an invalid limit, rather than an unhandled HTTP 500.
        return MAX_LIMIT
    return max(1, min(value, MAX_LIMIT))


def numbered_events(session: dict) -> list[dict]:
    """The full legacy derivation with a dense ``seq`` from 1 (no tail cut)."""
    events = host.session_events(session, sys.maxsize)
    return [{**event, 'seq': seq} for seq, event in enumerate(events, 1)]


def _prefix_revision(session: dict, events: list[dict], position: int) -> str:
    """Fingerprint consumed events, excluding the mutable status envelope.

    The hash is built in one pass. A continuation remains valid when events are
    appended after its position, while any change to an already-consumed event
    (including compaction or replacement of a pending question) forces resync.
    """
    digest = hashlib.sha256()
    digest.update(str(session.get('id', '')).encode('utf-8'))
    digest.update(b'\0events-cursor-v1\0')
    # seq 1 is the mutable status event; its current value is carried in the
    # response envelope and must not invalidate a cursor as a run advances.
    for event in events[1:position]:
        encoded = json.dumps(event, ensure_ascii=False, sort_keys=True,
                             separators=(',', ':')).encode('utf-8')
        digest.update(len(encoded).to_bytes(8, 'big'))
        digest.update(encoded)
    return digest.hexdigest()


def _token(position: int, revision: str) -> str:
    return f'c1.{position}.{revision}'


def sse_body(session: dict, all_events: list[dict], window: list[dict]) -> bytes:
    """Render a window with safe ids, hashing each prefix in one pass.

    Rehashing the full prefix for every event makes a large SSE page quadratic.
    Keep one digest while scanning the already-derived list and snapshot it only
    for events in the outgoing window.
    """
    chunks = []
    wanted = {event['seq'] for event in window}
    if wanted:
        digest = hashlib.sha256()
        digest.update(str(session.get('id', '')).encode('utf-8'))
        digest.update(b'\0events-cursor-v1\0')
        max_seq = max(wanted)
        for event in all_events:
            seq = event['seq']
            if seq > max_seq:
                break
            if seq > 1:
                encoded = json.dumps(event, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')
                digest.update(len(encoded).to_bytes(8, 'big'))
                digest.update(encoded)
            if seq not in wanted:
                continue
            chunks.append('id: ' + _token(seq, digest.copy().hexdigest()))
            chunks.append('event: ' + str(event.get('type', 'message')))
            chunks.append('data: ' + json.dumps(event, ensure_ascii=False))
            chunks.append('')
    return ('\n'.join(chunks) + '\n').encode() if chunks else b''


def page(session: dict, cursor: Cursor | int, limit: int) -> dict:
    """Build one page, validating opaque tokens against their consumed prefix.

    Legacy numeric cursor 0 remains the resync entrypoint. A nonzero numeric
    cursor cannot prove its prefix survived a rewrite, so it safely requests a
    resync instead of risking a silent skip.
    """
    if isinstance(cursor, int):
        cursor = Cursor(cursor)
    if not isinstance(cursor, Cursor):
        raise CursorError('invalid cursor')
    events = numbered_events(session)
    head = len(events)
    position = cursor.position
    if position > head:
        raise ResyncRequired('cursor ahead of session head')
    if position and cursor.revision is None:
        raise ResyncRequired()
    revision = _prefix_revision(session, events, position)
    if cursor.revision is not None and cursor.revision != revision:
        raise ResyncRequired('cursor revision changed')
    window = events[position:position + max(1, limit)]
    next_position = window[-1]['seq'] if window else position
    next_revision = _prefix_revision(session, events, next_position)
    return {
        'id': session['id'],
        'status': session.get('status'),
        'steps': session.get('steps', 0),
        'events': window,
        # Keep the numeric field for existing readers that display or persist
        # it. New clients must use next_cursor_token for safe continuation.
        'next_cursor': next_position,
        'next_cursor_token': _token(next_position, next_revision),
        'has_more': position + max(1, limit) < head,
    }
