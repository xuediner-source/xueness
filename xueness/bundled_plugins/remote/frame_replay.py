"""Bounded replay of unacknowledged stdio frames. Experimental, default off.

Feature ``remote.frame_replay``. Settings key
``general.remoteFrameReplayEnabled`` must be boolean true. While it is off,
app-server frames stay plain JSON-RPC and the method list does not grow.

While it is on, each outbound frame carries ``xuenessSeq``. The peer acks
with ``xuenessAck`` on any inbound object, or with ``transport/ack``. A bool
is not an ack. An ack ahead of the sent sequence is rejected. ``transport/replay``
writes the unacked frames again with their original sequence numbers.
``transport/status`` reports the buffer.

Limits match a socket replay buffer: high water 1 MiB, low water one quarter
of that, hard cap 8 MiB, grace 45 seconds. Crossing the cap or the grace
clears the queue and emits one ``transport/abandoned`` notification. The
``session/event`` that discovered the limit is not written, and neither are
later ones; the client resumes from the event log. ``turn/started`` and
``turn/finished`` are still written, including the send that discovered the
limit. There is no keepalive thread and no ack timer: grace is checked when
a frame is sent or received.

Reference (idea, not copied code): ZCode v3.14.3
``packages/rpc/src/persistent-protocol.ts``. That transport also sends a
5-second keepalive and drops the socket after 20 seconds without an ack.
This stdio path does not.
"""
from __future__ import annotations

import threading
import time

FEATURE_ID = 'remote.frame_replay'
SETTINGS_SECTION = 'general'
SETTINGS_KEY = 'remoteFrameReplayEnabled'
SCHEMA = 'xueness.frame-replay.v1'

HIGH_WATER_BYTES = 1024 * 1024
LOW_WATER_BYTES = HIGH_WATER_BYTES // 4
MAX_REPLAY_BYTES = 8 * 1024 * 1024
GRACE_SECONDS = 45.0

TRANSPORT_METHODS = ('transport/ack', 'transport/replay', 'transport/status')
_CACHE_SECONDS = 1.0


class ReplayRejected(ValueError):
    """The peer's ack cannot be applied."""


class Replay:
    def __init__(self, ctx, frames=None, *, limits=None, now=None):
        self._ctx = ctx
        self._frames = frames
        self._now = now or time.monotonic
        limits = limits or {}
        self._high = limits.get('high', HIGH_WATER_BYTES)
        self._low = limits.get('low', LOW_WATER_BYTES)
        self._max = limits.get('max', MAX_REPLAY_BYTES)
        self._grace = limits.get('grace', GRACE_SECONDS)
        self._lock = threading.Lock()
        self._seq = 0
        self._acked = 0
        self._entries = []
        self._unacked = 0
        self._saturated = False
        self._abandoned = False
        self._note_passed = False
        self._cached = None
        self._cached_until = 0.0

    def bind_frames(self, frames):
        self._frames = frames

    def active(self) -> bool:
        """True only when the setting is boolean true. Cached for one second."""
        now = time.monotonic()
        if self._cached is not None and now < self._cached_until:
            return self._cached
        value = _setting_enabled(self._ctx)
        self._cached = value
        self._cached_until = now + _CACHE_SECONDS
        return value

    def blocks_new_events(self) -> bool:
        """The turn pump must not emit a new ``session/event`` or advance."""
        if not self.active():
            return False
        with self._lock:
            return self._saturated or self._abandoned

    def observe(self, message):
        """Apply an inbound ack and the grace clock. May emit one abandon note."""
        if not isinstance(message, dict):
            return
        note = self._expire()
        if note is not None and self._frames is not None:
            self._frames.send(note)
        if 'xuenessAck' not in message:
            return
        self.apply_ack(message['xuenessAck'])

    def apply_ack(self, ack):
        if type(ack) is not int or ack < 0:
            raise ReplayRejected('xuenessAck must be a non-negative integer')
        with self._lock:
            if ack > self._seq:
                raise ReplayRejected('xuenessAck is ahead of the sent sequence')
            if ack <= self._acked:
                return
            self._acked = ack
            kept = []
            total = 0
            for entry in self._entries:
                if entry['seq'] <= ack:
                    continue
                kept.append(entry)
                total += entry['nbytes']
            self._entries = kept
            self._unacked = total
            if self._saturated and not self._abandoned and total <= self._low:
                self._saturated = False

    def admit(self, payload):
        """Payloads ``send`` should write. Empty means drop this frame."""
        if not isinstance(payload, dict):
            return [payload]
        note = self._expire()
        if note is not None:
            with self._lock:
                self._note_passed = True
                rest = self._after_abandon_locked(payload)
            return [note, *rest]
        with self._lock:
            if self._abandoned:
                return self._after_abandon_locked(payload)
            stamped = dict(payload)
            self._seq += 1
            stamped['xuenessSeq'] = self._seq
            size = _frame_size(stamped)
            self._entries.append({
                'seq': self._seq,
                'payload': stamped,
                'nbytes': size,
                'queued_at': self._now(),
            })
            self._unacked += size
            if self._unacked > self._max:
                # The frame was not written. Reuse its sequence for the note
                # so the peer does not see a gap for a frame it never got.
                self._seq -= 1
                note = self._mark_abandoned_locked()
                self._note_passed = True
                rest = self._after_abandon_locked(payload)
                return [note, *rest]
            if not self._saturated and self._unacked > self._high:
                self._saturated = True
            return [stamped]

    def pending_payloads(self):
        with self._lock:
            if self._abandoned:
                return None
            return [dict(entry['payload']) for entry in self._entries]

    def rpc(self, method):
        if method == 'transport/ack':
            return self._rpc_ack
        if method == 'transport/replay':
            return self._rpc_replay
        if method == 'transport/status':
            return self._rpc_status
        return None

    def status_body(self):
        with self._lock:
            return {
                'schema': SCHEMA,
                'enabled': True,
                'sent': self._seq,
                'acked': self._acked,
                'unackedBytes': self._unacked,
                'saturated': self._saturated,
                'abandoned': self._abandoned,
                'limits': {
                    'highWaterBytes': self._high,
                    'lowWaterBytes': self._low,
                    'maxReplayBytes': self._max,
                    'graceSeconds': self._grace,
                },
            }

    def _rpc_ack(self, params):
        from .app_server import INVALID_PARAMS, _Refused, _reject_unknown
        _reject_unknown(params, {'ack'})
        if 'ack' not in params:
            raise _Refused('ack is required', INVALID_PARAMS)
        try:
            self.apply_ack(params['ack'])
        except ReplayRejected as exc:
            raise _Refused(str(exc), INVALID_PARAMS) from None
        return self.status_body()

    def _rpc_replay(self, params):
        from .app_server import REFUSED, _Refused, _reject_unknown
        _reject_unknown(params, set())
        payloads = self.pending_payloads()
        if payloads is None:
            raise _Refused(
                'frame replay was abandoned; resume from the event log', REFUSED)
        frames = self._frames
        if frames is not None:
            for item in payloads:
                frames.write_replay(item)
        return {'schema': SCHEMA, 'replayed': len(payloads)}

    def _rpc_status(self, params):
        from .app_server import _reject_unknown
        _reject_unknown(params, set())
        return self.status_body()

    def _expire(self):
        with self._lock:
            if self._abandoned or not self._entries:
                return None
            if self._now() - self._entries[0]['queued_at'] <= self._grace:
                return None
            return self._mark_abandoned_locked()

    def _mark_abandoned_locked(self):
        self._abandoned = True
        self._saturated = True
        self._entries.clear()
        self._unacked = 0
        self._seq += 1
        return {
            'jsonrpc': '2.0',
            'method': 'transport/abandoned',
            'params': {
                'schema': SCHEMA,
                'reason': 'replay_limit',
                'sent': self._seq,
            },
            'xuenessSeq': self._seq,
        }

    def _after_abandon_locked(self, payload):
        if payload.get('method') == 'session/event':
            return []
        if payload.get('method') == 'transport/abandoned':
            if self._note_passed:
                return []
            self._note_passed = True
            return [payload]
        self._seq += 1
        stamped = dict(payload)
        stamped['xuenessSeq'] = self._seq
        return [stamped]


def _setting_enabled(ctx) -> bool:
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


def _frame_size(payload) -> int:
    from .app_server import encode_frame
    return len(encode_frame(payload).encode('utf-8'))
