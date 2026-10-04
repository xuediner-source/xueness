"""Manual, deterministic context compaction (``/compact``).

``core.compact`` already bounds the prompt view on every step of a standard run.
This is the same machinery asked for by hand between turns, carrying an operator
note: no model call, no new summariser, and the invariants stay whatever the
kernel guarantees -- the system prompt and the original task survive, every user
turn survives verbatim, tool calls are never split from their results, and
anything dropped moves to ``archived_messages`` inside the same journal.

Three faces -- chat ``/compact [instructions]``, ``xueness sessions compact`` and
``POST /api/sessions/<sid>/compact`` -- all reach :func:`compact_now`, so the
instruction cap, the budget rule and the recorded shape exist exactly once. A
lightweight session is bounded by the input budget its profile already computed,
so asking for a compaction can never widen the window that profile enforces.
"""
from __future__ import annotations

import json
import re

from ... import core, plugin_runtime
from ...session_lease import lease

PLUGIN = 'sessions'
MAX_INSTRUCTIONS = 2000
INSTRUCTION_DIGEST_CHARS = 200
#: The ``--max-chars`` default, i.e. the budget a standard run works to per step.
DEFAULT_MAX_CHARS = 24000
#: Under this the live window is already small; forcing a shrink would only cost
#: detail the operator never asked to lose.
MIN_ACTIVE_CHARS = 1024
#: How much of the current window the compaction is asked to give back. It is a
#: request, not a guarantee: user turns are never rewritten.
SHRINK_RATIO = 0.6
#: The lightweight estimator counts ``utf8 bytes / 2``, so assuming two
#: characters per token can only ever under-ask, never overstate that budget.
LIGHTWEIGHT_CHARS_PER_TOKEN = 2
SOURCES = ('chat', 'cli', 'http')
SESSION_RE = re.compile(r'[0-9a-f]{32}')


class CompactError(ValueError):
    """An expected compaction refusal, with the status each face should report."""

    def __init__(self, reason: str, detail: str, status: int = 400, **extra):
        super().__init__(f'{reason}: {detail}')
        self.reason, self.detail, self.status, self.extra = reason, detail, status, extra

    def payload(self) -> dict:
        return {'ok': False, 'status': self.status,
                'refusal': {'reason': self.reason, 'detail': self.detail}, **self.extra}


def require_enabled(state_dir) -> None:
    if state_dir is None or not plugin_runtime.is_enabled(state_dir, PLUGIN):
        raise CompactError('plugin_disabled', f'插件已禁用或依赖不可用: {PLUGIN}', 403)


def normalize_instructions(value) -> str | None:
    """Bound the operator note *before* anything is written or handed over."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise CompactError('invalid_instructions', '压缩说明必须是文本。', 400)
    text = value.strip()
    if not text:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise CompactError('invalid_instructions', '压缩说明不能包含控制字符。', 400)
    if len(text) > MAX_INSTRUCTIONS:
        raise CompactError('instructions_too_long',
                           f'压缩说明最长 {MAX_INSTRUCTIONS} 个字符（当前 {len(text)}）。', 400)
    return text


def _window(session) -> tuple[int, list]:
    messages = session.get('messages')
    if not isinstance(messages, list):
        raise CompactError('invalid_session', '该会话没有可压缩的消息记录。', 409)
    return len(json.dumps(messages, ensure_ascii=False)), messages


def budget_chars(session, current: int, override=None) -> int:
    """This compaction's target, always inside the budget the profile already uses."""
    if override is not None:
        if type(override) is not int or override < 256:
            raise CompactError('invalid_budget', '压缩预算需要是不小于 256 的整数。', 400)
        base = min(override, DEFAULT_MAX_CHARS)
    else:
        base = DEFAULT_MAX_CHARS
    if session.get('runtime_profile') == 'lightweight':
        stored = session.get('runtime_budget')
        tokens = stored.get('inputBudgetTokens') if isinstance(stored, dict) else None
        if type(tokens) is int and tokens > 0:
            base = min(base, tokens * LIGHTWEIGHT_CHARS_PER_TOKEN)
    return max(256, min(base, int(current * SHRINK_RATIO)))


def _totals(records) -> tuple[int, int]:
    dropped = masked = 0
    for record in records:
        if not isinstance(record, dict):
            continue
        for key, total in (('removed', 'dropped'), ('masked', 'masked')):
            value = record.get(key)
            if type(value) is int and value > 0:
                if total == 'dropped':
                    dropped += value
                else:
                    masked += value
    return dropped, masked


def _report(sid, source, note, target, session, before, before_messages, records) -> dict:
    messages = session.get('messages') if isinstance(session.get('messages'), list) else []
    after = len(json.dumps(messages, ensure_ascii=False))
    dropped, masked = _totals(records)
    return {'ok': True, 'session': sid, 'manual': True, 'source': source,
            'compacted': bool(dropped or masked or after < before),
            'budget': target, 'withinBudget': after <= target,
            'before': {'chars': before, 'estimatedTokens': before // 4, 'messages': before_messages},
            'after': {'chars': after, 'estimatedTokens': after // 4, 'messages': len(messages)},
            'dropped': dropped, 'masked': masked,
            'archived': len(session.get('archived_messages') or []),
            'instructions': {'provided': note is not None, 'chars': len(note or ''),
                             'digest': (note[:INSTRUCTION_DIGEST_CHARS] if note else None)},
            'compactions': records}


def _require_sid(sid) -> str:
    """Validate before any face touches the filesystem: a lease needs a real id."""
    if not isinstance(sid, str) or not SESSION_RE.fullmatch(sid):
        raise CompactError('invalid_session', '需要 32 位十六进制的会话 id。', 400)
    return sid


def compact_now(store, sid: str, instructions=None, *, state_dir, source: str = 'cli',
                budget=None) -> dict:
    """Compact one session. The caller holds the single-writer lease.

    The chat loop already leases the session it is driving, and a second flock
    from the same process can be denied, so leasing is deliberately the caller's
    choice here rather than a surprise inside this function.
    """
    require_enabled(state_dir)
    if source not in SOURCES:
        raise CompactError('invalid_source', '未知的压缩入口。', 400)
    sid = _require_sid(sid)
    note = normalize_instructions(instructions)
    try:
        session = store.load(sid)
    except (OSError, ValueError, KeyError):
        raise CompactError('session_not_found', f'未知会话: {sid}', 404) from None
    if not isinstance(session, dict) or session.get('id') != sid:
        raise CompactError('session_not_found', f'未知会话: {sid}', 404)
    before, messages = _window(session)
    target = budget_chars(session, before, budget)
    if len(messages) <= 3 or before <= max(MIN_ACTIVE_CHARS, target):
        # Nothing to give back: leave the journal untouched instead of churning
        # it for show, and say so in the same vocabulary the refusals use.
        return {'ok': True, 'session': sid, 'manual': True, 'source': source,
                'compacted': False, 'reason': 'nothing_to_compact', 'budget': target,
                'before': {'chars': before, 'estimatedTokens': before // 4,
                           'messages': len(messages)},
                'after': {'chars': before, 'estimatedTokens': before // 4,
                          'messages': len(messages)},
                'dropped': 0, 'masked': 0, 'archived': len(session.get('archived_messages') or []),
                'instructions': {'provided': note is not None, 'chars': len(note or ''),
                                 'digest': (note[:INSTRUCTION_DIGEST_CHARS] if note else None)},
                'compactions': []}
    recorded = len(session.get('compactions') or [])
    before_messages = len(messages)
    core.compact(session, target, instructions=note)
    fresh = session.get('compactions') or []
    created = fresh[recorded:]
    for record in created:
        if not isinstance(record, dict):
            continue
        # ``manual``/``source`` is what tells a hand-asked compaction apart from
        # the automatic per-step ones in the same journal.
        record.update({'manual': True, 'source': source, 'targetChars': target,
                       'instructions': note[:INSTRUCTION_DIGEST_CHARS] if note else None,
                       'instructionsChars': len(note or '')})
    dropped, masked = _totals(created)
    after = len(json.dumps(session.get('messages') or [], ensure_ascii=False))
    if created or dropped or masked or after != before:
        store.save(session)
    return _report(sid, source, note, target, session, before, before_messages, created)


def compact_leased(store, sid: str, instructions=None, *, state_dir, source: str = 'cli',
                   budget=None) -> dict:
    """Take the lease this caller does not already hold, then compact."""
    _require_sid(sid)
    try:
        with lease(store, sid):
            return compact_now(store, sid, instructions, state_dir=state_dir,
                               source=source, budget=budget)
    except BlockingIOError:
        raise CompactError('session_busy', '会话正在被写入，请停止运行后再压缩。', 409) from None


def chat(store, session, argument, *, state_dir) -> dict:
    """Chat-loop ``/compact``: same implementation, lease already held."""
    if not isinstance(session, dict) or not isinstance(session.get('id'), str):
        raise CompactError('session_not_found', '当前还没有会话，无法压缩上下文。', 404)
    return compact_now(store, session['id'], argument, state_dir=state_dir, source='chat')


def dispatch(method, parts, query, data, ctx):
    """``POST /api/sessions/<sid>/compact``; ``None`` means this is not our route.

    Host supplies transport and the Host/Origin/CSRF gates; a running session is
    refused before the lease is taken, because the run owns the journal.
    """
    if (not isinstance(parts, list) or len(parts) != 4 or parts[:2] != ['api', 'sessions']
            or parts[3] != 'compact'):
        return None
    sid = parts[2]
    if not isinstance(sid, str) or not SESSION_RE.fullmatch(sid):
        return None
    if method != 'POST':
        return 405, {'error': 'method not allowed'}
    state_dir = ctx.get('state_dir')
    store = ctx.get('store')
    if store is None:
        return 500, {'error': 'session store unavailable'}
    if not plugin_runtime.is_enabled(state_dir, PLUGIN):
        return 403, {'error': f'plugin disabled or dependency unavailable: {PLUGIN}',
                     'plugin': PLUGIN}
    if not isinstance(data, dict) or set(data) - {'instructions'}:
        return 400, {'error': 'expected only an instructions string'}
    if 'instructions' in data and not isinstance(data['instructions'], (str, type(None))):
        return 400, {'error': 'instructions must be text'}
    if sid in (ctx.get('running') or ()):
        return 409, {'error': '请先停止运行，再压缩上下文。', 'reason': 'run_in_progress'}
    try:
        return 200, compact_leased(store, sid, data.get('instructions'),
                                   state_dir=state_dir, source='http')
    except CompactError as exc:
        return exc.status, exc.payload()
    except (OSError, ValueError, KeyError, TypeError):
        return 400, {'error': 'cannot compact session'}
