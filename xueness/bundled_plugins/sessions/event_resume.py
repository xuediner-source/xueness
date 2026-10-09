"""Epoch resume for derived session events. Experimental, default off.

Feature ``sessions.event_resume``. Settings key
``general.sessionsEventResumeEnabled`` must be boolean true. The route is
``GET /api/sessions/<sid>/events.resume``. It does not change
``xueness.events.v1`` or the legacy ``/events`` response.

The wire shape follows the subscribe/resync split used by an append-only
conversation log: a client may continue only when it still holds a consistent
``(logEpoch, seq)`` base. Otherwise the answer is a tail snapshot and the
client drops its local projection. ``logEpoch`` is a hash of the immutable
event prefix through ``seq`` (the mutable ``session.status`` row is excluded
and travels in the envelope). Appending events keeps an old base valid.
Rewriting, compacting, or shortening that prefix returns 409 with a fresh
snapshot instead of an empty page that looks caught up.

Two delivery profiles share that epoch. ``replayable`` (the default) omits
``session.status`` because that row keeps ``seq`` 1 and changes in place.
``continuous`` includes it when it falls in the window. Every response's
``status`` / ``steps`` / ``mode`` is the full row that closes the omission, so
both profiles end on the same session state.

Reference (ideas, not copied code): ZCode v3.14.3
``packages/shared/src/zcode-protocol-v4/transport.ts`` (subscribe base and
snapshot vs resume), ``packages/shared/src/zcode-protocol-v4/core.ts``
(snapshot tail of 60 and the two delivery profiles).
"""
from __future__ import annotations

import hashlib
import json
import re

from ... import events as events_protocol
from ... import web as host

FEATURE_ID = 'sessions.event_resume'
SETTINGS_SECTION = 'general'
SETTINGS_KEY = 'sessionsEventResumeEnabled'
NOT_ENABLED_ERROR = FEATURE_ID + ' not enabled'
SCHEMA = 'xueness.events.resume.v1'
RESYNC_CODE = 'sessions.event_resume.resync_required'

#: Tail returned when the client has no consistent base. Same bound as a
#: conversation snapshot tail: enough to paint the recent transcript, not the
#: whole audit log. A client that needs older rows pages from ``origin``.
SNAPSHOT_TAIL = 60
DEFAULT_RESUME_LIMIT = 200
MAX_LIMIT = events_protocol.MAX_LIMIT
MAX_SEQ = (1 << 53) - 1

PROFILES = ('replayable', 'continuous')
#: Not append-only. The envelope on every response is the closer.
REPLAYABLE_OMIT = frozenset({'session.status'})

_DIGITS = re.compile(r'[0-9]+\Z')
_EPOCH = re.compile(r'[0-9a-f]{64}\Z')
_EVENT_ID = re.compile(r'([0-9]+)\.([0-9a-f]{64})\Z')
_DOMAIN = b'\0events-resume-v1\0'


class Base:
    """A client claim: immutable prefix through ``seq`` hashed to ``epoch``."""

    __slots__ = ('seq', 'epoch')

    def __init__(self, seq: int, epoch: str):
        self.seq = seq
        self.epoch = epoch

    def __eq__(self, other):
        return (isinstance(other, Base) and self.seq == other.seq
                and self.epoch == other.epoch)

    def __repr__(self):
        return f'Base({self.seq}, {self.epoch!r})'


class ResumeError(ValueError):
    """Rejected resume input. ``body`` is the HTTP payload when set."""

    def __init__(self, message, *, status=400, code='xueness.error.invalid_argument',
                 body=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body


class ResyncRequired(ResumeError):
    """The base does not describe the current journal. Body carries a snapshot."""

    def __init__(self, message, snapshot):
        body = {
            'error': message,
            'errorCode': RESYNC_CODE,
            'resync': True,
            **snapshot,
        }
        super().__init__(message, status=409, code=RESYNC_CODE, body=body)


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


def _firsts(query, key):
    if not isinstance(query, dict) or key not in query:
        return []
    raw = query[key]
    values = raw if isinstance(raw, (list, tuple)) else (raw,)
    return [str(value) for value in values if str(value)]


def _one(query, key):
    values = _firsts(query, key)
    if not values:
        return None
    if any(value != values[0] for value in values[1:]):
        raise ResumeError('conflicting ' + key + ' values')
    return values[0]


def requested_profile(query) -> str:
    text = _one(query, 'profile')
    if text is None:
        return 'replayable'
    if text not in PROFILES:
        raise ResumeError('invalid profile')
    return text


def requested_limit(query, *, snapshot: bool) -> int:
    text = _one(query, 'limit')
    if text is None:
        return SNAPSHOT_TAIL if snapshot else DEFAULT_RESUME_LIMIT
    if not _DIGITS.fullmatch(text):
        raise ResumeError('invalid limit')
    try:
        value = int(text)
    except ValueError:
        raise ResumeError('invalid limit') from None
    return max(1, min(value, MAX_LIMIT))


def _parse_event_id(text):
    match = _EVENT_ID.fullmatch(text or '')
    if match is None:
        raise ResumeError('invalid Last-Event-ID')
    return _base_parts(match.group(1), match.group(2))


def _base_parts(seq_text, epoch_text):
    if not _DIGITS.fullmatch(seq_text):
        raise ResumeError('invalid seq')
    if not _EPOCH.fullmatch(epoch_text):
        raise ResumeError('invalid logEpoch')
    try:
        seq = int(seq_text)
    except ValueError:
        raise ResumeError('seq too large') from None
    if seq > MAX_SEQ:
        raise ResumeError('seq too large')
    return Base(seq, epoch_text)


def requested_base(query, last_event_id: str = '') -> Base | None:
    """Parse ``log_epoch``/``logEpoch`` + ``seq``, or a ``Last-Event-ID``.

    Both halves are required together. A bare number is not a base: it cannot
    prove the prefix. An explicit empty header is ignored. When the header and
    the query both name a base, they must be the same base.
    """
    if not isinstance(query, dict):
        raise ResumeError('invalid query')
    epoch_keys = [key for key in ('log_epoch', 'logEpoch') if _firsts(query, key)]
    epochs = []
    for key in epoch_keys:
        epochs.extend(_firsts(query, key))
    seqs = _firsts(query, 'seq')
    header = (last_event_id or '').strip()
    if not epochs and not seqs and not header:
        return None
    if bool(epochs) != bool(seqs):
        raise ResumeError('logEpoch and seq are required together')
    query_base = None
    if epochs or seqs:
        if any(value != epochs[0] for value in epochs[1:]):
            raise ResumeError('conflicting logEpoch values')
        if any(value != seqs[0] for value in seqs[1:]):
            raise ResumeError('conflicting seq values')
        query_base = _base_parts(seqs[0], epochs[0])
    header_base = _parse_event_id(header) if header else None
    if query_base is not None and header_base is not None and query_base != header_base:
        raise ResumeError('conflicting resume base')
    return query_base or header_base


def _digest(session):
    digest = hashlib.sha256()
    digest.update(str(session.get('id', '')).encode('utf-8'))
    digest.update(_DOMAIN)
    return digest


def _update(digest, event):
    encoded = json.dumps(event, ensure_ascii=False, sort_keys=True,
                         separators=(',', ':')).encode('utf-8')
    digest.update(len(encoded).to_bytes(8, 'big'))
    digest.update(encoded)


def prefix_epoch(session, events, position: int) -> str:
    """Hash of immutable events with ``1 < seq <= position``.

    ``session.status`` is seq 1 and is not part of the epoch, so a running
    session can keep the same base while its envelope status changes.
    """
    digest = _digest(session)
    if position <= 1:
        return digest.hexdigest()
    for event in events:
        seq = event.get('seq', 0)
        if seq <= 1:
            continue
        if seq > position:
            break
        _update(digest, event)
    return digest.hexdigest()


def _visible(event, profile: str) -> bool:
    if profile == 'replayable' and event.get('type') in REPLAYABLE_OMIT:
        return False
    return True


def _envelope(session, events, *, resume_mode, profile, window, next_seq, head,
              from_seq, has_more, gap_before):
    shown = [event for event in window if _visible(event, profile)]
    return {
        'schema': SCHEMA,
        'sessionId': str(session.get('id', '')),
        'resumeMode': resume_mode,
        'deliveryProfile': profile,
        'logEpoch': prefix_epoch(session, events, next_seq),
        'originEpoch': prefix_epoch(session, events, 0),
        'seq': next_seq,
        'nextCursor': next_seq,
        'head': head,
        'fromSeq': from_seq,
        'hasMore': has_more,
        'gapBefore': gap_before,
        'status': session.get('status'),
        'steps': session.get('steps', 0),
        'mode': session.get('mode') or '',
        'events': shown,
    }


def _derived(session):
    return events_protocol.derive_events(session)


def _snapshot(session, events, limit, profile):
    head = len(events)
    window = events[-limit:] if limit < head else list(events)
    from_seq = window[0]['seq'] - 1 if window else 0
    return _envelope(
        session, events, resume_mode='snapshot', profile=profile, window=window,
        next_seq=head, head=head, from_seq=from_seq, has_more=False,
        gap_before=from_seq > 0,
    )


def page(session, base: Base | None, limit: int, profile: str) -> dict:
    """One snapshot or one resume page.

    A base past ``head``, or whose epoch is not the immutable prefix through
    ``seq``, raises :class:`ResyncRequired`. The error body is itself a
    snapshot the client can adopt.
    """
    if profile not in PROFILES:
        raise ResumeError('invalid profile')
    if type(limit) is not int or isinstance(limit, bool) or limit < 1:
        raise ResumeError('invalid limit')
    limit = min(limit, MAX_LIMIT)
    events = _derived(session)
    if base is None:
        return _snapshot(session, events, limit, profile)
    if not isinstance(base, Base):
        raise ResumeError('invalid resume base')
    head = len(events)
    if base.seq > head:
        raise ResyncRequired(
            'seq ahead of session head',
            _snapshot(session, events, limit, profile),
        )
    expected = prefix_epoch(session, events, base.seq)
    if expected != base.epoch:
        raise ResyncRequired(
            'logEpoch does not match the event prefix',
            _snapshot(session, events, limit, profile),
        )
    remaining = [event for event in events if event.get('seq', 0) > base.seq]
    window = remaining[:limit]
    next_seq = window[-1]['seq'] if window else base.seq
    return _envelope(
        session, events, resume_mode='resume', profile=profile, window=window,
        next_seq=next_seq, head=head, from_seq=base.seq,
        has_more=len(remaining) > len(window), gap_before=False,
    )


def _cursor_meta(envelope):
    return {key: envelope[key] for key in (
        'schema', 'sessionId', 'resumeMode', 'deliveryProfile', 'logEpoch',
        'originEpoch', 'seq', 'nextCursor', 'head', 'fromSeq', 'hasMore',
        'gapBefore', 'status', 'steps', 'mode',
    )}


def sse_body(session, envelope) -> bytes:
    """Finite SSE page. The last id is the continuation base.

    Per-event ids are ``<seq>.<prefix epoch>``. A final ``resume.cursor``
    event carries the envelope without repeating row bodies, so a client that
    only stored ``Last-Event-ID`` resumes from ``nextCursor`` even when the
    page's last visible row was filtered.
    """
    events = _derived(session)
    wanted = {event['seq'] for event in envelope.get('events') or [] if 'seq' in event}
    chunks = []
    if wanted:
        digest = _digest(session)
        max_seq = max(wanted)
        for event in events:
            seq = event.get('seq', 0)
            if seq > max_seq:
                break
            if seq > 1:
                _update(digest, event)
            if seq not in wanted:
                continue
            chunks.append('id: ' + str(seq) + '.' + digest.copy().hexdigest())
            chunks.append('event: ' + str(event.get('type', 'message')))
            chunks.append('data: ' + json.dumps(event, ensure_ascii=False))
            chunks.append('')
    chunks.append('id: ' + str(envelope['nextCursor']) + '.' + envelope['logEpoch'])
    chunks.append('event: resume.cursor')
    chunks.append('data: ' + json.dumps(_cursor_meta(envelope), ensure_ascii=False))
    chunks.append('')
    return ('\n'.join(chunks) + '\n').encode()


def dispatch(method, parts, query, data, ctx):
    if (len(parts) != 4 or parts[0] != 'api' or parts[1] != 'sessions'
            or parts[3] != 'events.resume'):
        return None
    if method != 'GET':
        return 405, {'error': 'method not allowed'}
    if not host._valid_sid(parts[2]):
        return 404, {'error': 'not found'}
    # Flag before the store read: a disabled deployment does not reveal
    # whether a well-formed session id exists.
    if not enabled(ctx):
        return 400, {'error': NOT_ENABLED_ERROR, 'feature': FEATURE_ID}
    try:
        session = ctx['store'].load(parts[2])
    except (OSError, ValueError, KeyError):
        return 404, {'error': 'session not found'}
    handler = ctx.get('handler')
    header = ''
    if handler is not None:
        try:
            header = handler.headers.get('Last-Event-ID', '') or ''
        except (AttributeError, TypeError):
            header = ''
    try:
        base = requested_base(query if isinstance(query, dict) else {}, header)
        profile = requested_profile(query if isinstance(query, dict) else {})
        limit = requested_limit(query if isinstance(query, dict) else {},
                                snapshot=base is None)
        envelope = page(session, base, limit, profile)
    except ResumeError as exc:
        payload = exc.body if exc.body is not None else {
            'error': str(exc), 'errorCode': exc.code,
        }
        return exc.status, payload
    accept = ''
    if handler is not None:
        try:
            accept = handler.headers.get('Accept') or ''
        except (AttributeError, TypeError):
            accept = ''
    if 'text/event-stream' in accept and hasattr(handler, '_send'):
        handler._send(200, sse_body(session, envelope), 'text/event-stream')
        from ...http_contract import HANDLED_RESPONSE
        return HANDLED_RESPONSE
    return 200, envelope
