"""One durable session objective, a per-request reminder and a host-side stop check.

ZCode-style target: the objective outlives a single turn, so it is stored on the
session record instead of being repeated by the user. Every model request gets a
short reminder while the goal is active, and a run that tries to finish without
declaring the goal done is reported as needing review.

Verification is deliberately deterministic: no extra model call, achievement is
only recognised from an explicit statement in the final answer. Anything the
host cannot prove stays a question for the user rather than a silent pass.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone

from ... import plugin_runtime
from ...session_lease import lease

MAX_GOAL_CHARS = 5000
REMINDER_CHARS = 600
HISTORY_LIMIT = 20
STATUSES = ('active', 'achieved', 'cleared')
#: Worst-of order: an unassessed goal must not look like a passed one.
STATUS_RANK = ('passed', 'not_assessed', 'failed')
SESSION_RE = re.compile(r'[0-9a-f]{32}')
ACHIEVED_RE = re.compile(r'目标已(?:完成|达成|实现)|goal\s+(?:achieved|complete|completed)', re.I)
DENIED_RE = re.compile(r'未|没|无法|尚未|not\s|never|still', re.I)
#: Statuses that still occupy the session's single goal slot.
OCCUPIED = ('active', 'achieved')
SOURCES = ('cli', 'http', 'composer', 'agent')


class GoalError(ValueError):
    """An expected goal refusal, with the status the API should report."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def sanitize(raw) -> dict | None:
    """Read one stored goal defensively; state files are data, not a contract."""
    if not isinstance(raw, dict):
        return None
    text, status = raw.get('text'), raw.get('status')
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_GOAL_CHARS:
        return None
    if status not in STATUSES:
        return None
    history = []
    for entry in (raw.get('history') if isinstance(raw.get('history'), list) else ()):
        if not isinstance(entry, dict) or entry.get('action') not in ('set', 'replace', 'clear', 'achieved'):
            continue
        item = {'action': entry['action'], 'at': str(entry.get('at', ''))[:40]}
        for key in ('text', 'source'):
            value = entry.get(key)
            if isinstance(value, str) and value:
                item[key] = value[:300] if key == 'text' else value[:20]
        history.append(item)
    return {'text': text.strip(), 'status': status,
            'setAt': str(raw.get('setAt', ''))[:40], 'updatedAt': str(raw.get('updatedAt', ''))[:40],
            'history': history[-HISTORY_LIMIT:]}


def current(session) -> dict | None:
    return sanitize(session.get('goal')) if isinstance(session, dict) else None


def public(session) -> dict | None:
    """The API view of the goal: a cleared slot reads as empty."""
    goal = current(session)
    return None if goal is None or goal['status'] == 'cleared' else goal


def require_enabled(state_dir) -> None:
    if state_dir is None or not plugin_runtime.is_enabled(state_dir, 'planning'):
        raise GoalError('plugin disabled or dependency unavailable: planning', 403)


def _append(history: list, entry: dict) -> list:
    return [*history, entry][-HISTORY_LIMIT:]


def set_goal(session, text, *, state_dir, replace: bool = False, source: str = 'cli') -> dict:
    """Install ``text`` as the session objective; an occupied slot needs ``replace``."""
    require_enabled(state_dir)
    if not isinstance(text, str) or not text.strip():
        raise GoalError('会话目标需要 1..5000 个字符的非空文本')
    if len(text) > MAX_GOAL_CHARS:
        raise GoalError('会话目标最长 5000 个字符')
    if source not in SOURCES:
        raise GoalError('未知的会话目标设置来源')
    objective = text.strip()
    existing = current(session)
    if existing and existing['status'] in OCCUPIED and not replace:
        raise GoalError('该会话已有目标，确认替换后再覆盖：CLI 用 --target-replace 或 goal replace，'
                        'HTTP 传 replace=true', 409)
    now = _stamp()
    history = list(existing['history']) if existing else []
    action = 'replace' if existing else 'set'
    session['goal'] = {'text': objective, 'status': 'active', 'setAt': now, 'updatedAt': now,
                       'history': _append(history, {'action': action, 'text': objective[:300],
                                                    'at': now, 'source': source})}
    return session['goal']


def clear_goal(session, *, state_dir, source: str = 'cli') -> dict:
    require_enabled(state_dir)
    existing = current(session)
    if existing is None or existing['status'] == 'cleared':
        raise GoalError('该会话当前没有可清除的目标', 404)
    now = _stamp()
    session['goal'] = {**existing, 'status': 'cleared', 'updatedAt': now,
                       'history': _append(existing['history'], {'action': 'clear', 'at': now,
                                                                'source': source})}
    return session['goal']


def persist_set(store, session, text, *, state_dir, replace: bool = False, source: str = 'cli') -> dict:
    """Mutate and save one session's goal; the caller holds the session lease."""
    record = set_goal(session, text, state_dir=state_dir, replace=replace, source=source)
    store.save(session)
    return record


def persist_clear(store, session, *, state_dir, source: str = 'cli') -> dict:
    """Mark the goal cleared and save it; the caller holds the session lease."""
    record = clear_goal(session, state_dir=state_dir, source=source)
    store.save(session)
    return record


def reminder(session) -> str:
    """Short request-time reminder, or nothing unless the goal is active."""
    goal = current(session)
    if not goal or goal['status'] != 'active':
        return ''
    prefix = '会话目标：'
    suffix = ('（持久目标，跨轮有效。结束前请对照目标自查：已达成就在最终回答中明确写出「目标已完成」'
              '/“Goal achieved”；未达成请说明剩余工作并继续。）')
    budget = max(1, REMINDER_CHARS - len(prefix) - len(suffix))
    text = goal['text'] if len(goal['text']) <= budget else goal['text'][:budget - 1].rstrip() + '…'
    return prefix + text + suffix


def declares_achievement(summary) -> bool:
    """Explicit achievement wording, ignoring negated sentences."""
    text = summary if isinstance(summary, str) else ''
    for match in ACHIEVED_RE.finditer(text):
        start = text.rfind('\n', 0, match.start()) + 1
        end = text.find('\n', match.end())
        line = text[start:] if end < 0 else text[start:end]
        if not DENIED_RE.search(line):
            return True
    return False


def verify(session, summary) -> dict | None:
    """Compare the final answer against the active goal; never calls a model.

    An achieved goal is recorded on the session so later turns stop reminding,
    which the surrounding run loop persists together with its completion.
    """
    goal = current(session)
    if not goal or goal['status'] != 'active':
        return None
    now = _stamp()
    passed = declares_achievement(summary)
    if passed:
        session['goal'] = {**goal, 'status': 'achieved', 'updatedAt': now,
                           'history': _append(goal['history'], {'action': 'achieved', 'at': now,
                                                                'source': 'agent'})}
    label = '会话目标：' + goal['text'][:300]
    missing = ([] if passed else
               ['目标尚未确认达成：请在结束前说明目标完成情况。已完成请明确写出「目标已完成」/'
                '“Goal achieved”，尚未完成请继续完成或说明剩余工作。'])
    return {'status': 'passed' if passed else 'failed', 'items': [
        {'id': 'session_goal', 'label': label, 'path': None, 'contains': [],
         'min_links': 0, 'passed': passed, 'missing': missing}],
        'reason': '' if passed else missing[0],
        'goal': {'status': 'achieved' if passed else 'active', 'text': goal['text'][:300]}}


def merge_completion_check(delivery: dict, goal: dict | None) -> dict:
    """Fold the goal verdict into planning's single completion-check contribution."""
    if goal is None:
        return delivery
    status = STATUS_RANK[max(STATUS_RANK.index(delivery.get('status', 'not_assessed')),
                             STATUS_RANK.index(goal['status']))]
    merged = {**delivery, 'status': status, 'items': list(delivery.get('items') or []) + goal['items'],
              'goal': goal['goal']}
    reason = goal['reason'] if goal['status'] == 'failed' else delivery.get('reason', '')
    if reason:
        merged['reason'] = reason
    else:
        merged.pop('reason', None)
    return merged


def _load(store, sid: str) -> dict:
    try:
        return store.load(sid)
    except (OSError, ValueError, KeyError):
        raise GoalError('session not found', 404) from None


def _data_keys(data, allowed: set) -> None:
    if not isinstance(data, dict) or set(data) - allowed:
        raise GoalError('expected text, with optional replace boolean')
    if 'replace' in data and not isinstance(data['replace'], bool):
        raise GoalError('replace must be a boolean')


def goal_view(ctx: dict, sid: str, *, state_dir) -> dict:
    """Read-only goal view, also used by the CLI so both faces agree."""
    if not plugin_runtime.is_enabled(state_dir, 'planning'):
        raise GoalError('plugin disabled or dependency unavailable: planning', 403)
    return {'session': sid, 'goal': public(_load(ctx['store'], sid))}


def dispatch(method, parts, query, data, ctx):
    """``/api/sessions/<sid>/goal`` for GET/POST/DELETE; None means not ours.

    The host maps the path to this plugin and applies Host/Origin/CSRF, and the
    same handler answers the CLI, so the switch, the confirm-before-replace rule
    and the session lease exist in exactly one place.
    """
    if not isinstance(parts, list) or len(parts) != 4 or parts[:2] != ['api', 'sessions']:
        return None
    if parts[3] != 'goal':
        return None
    sid = parts[2]
    if not isinstance(sid, str) or not SESSION_RE.fullmatch(sid):
        return None
    state_dir = ctx.get('state_dir')
    store = ctx.get('store')
    if store is None:
        return 500, {'error': 'session store unavailable'}
    try:
        if method == 'GET':
            return 200, goal_view(ctx, sid, state_dir=state_dir)
        if method not in ('POST', 'DELETE'):
            return 405, {'error': 'method not allowed'}
        if not plugin_runtime.is_enabled(state_dir, 'planning'):
            return 403, {'error': 'plugin disabled or dependency unavailable: planning',
                         'plugin': 'planning'}
        if method == 'DELETE':
            _data_keys(data, set())
        else:
            _data_keys(data, {'text', 'replace'})
        if sid in ctx.get('running', ()):
            return 409, {'error': '请先停止运行，再修改会话目标。'}
        with lease(store, sid):
            session = _load(store, sid)
            if method == 'DELETE':
                record = persist_clear(store, session, state_dir=state_dir,
                                       source=ctx.get('goal_source', 'http'))
            else:
                record = persist_set(store, session, data.get('text'), state_dir=state_dir,
                                     replace=data.get('replace', False),
                                     source=ctx.get('goal_source', 'http'))
            return 200, {'session': sid, 'goal': record}
    except GoalError as exc:
        return exc.status, {'error': str(exc)}
    except BlockingIOError:
        return 409, {'error': 'session is in use by another process'}
    except (OSError, ValueError, KeyError, TypeError):
        return 400, {'error': 'cannot update session goal'}


def add_parsers(commands):
    goal = commands.add_parser('goal', help='show, set, replace or clear a session goal')
    goal.add_argument('--session', required=True, help='session id')
    goal.add_argument('action', nargs='?', default='show', choices=('show', 'set', 'replace', 'clear'),
                      help='show (default), set without replacing, replace an existing goal, or clear')
    goal.add_argument('text', nargs='*', help='goal text for set/replace')


def _report(status, payload) -> int:
    if status is None:
        print('ERROR: unsupported command', file=sys.stderr)
        return 1
    if status >= 400:
        print(f'ERROR ({status}): {payload.get("error", "unknown")}', file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def execute_cli(args, deps=None):
    """CLI face over the same dispatch the web uses."""
    store_factory = getattr(deps, 'Store', None) if deps is not None else None
    if store_factory is None:
        from ...core import Store as store_factory
    ctx = {'state_dir': args.state, 'store': store_factory(args.state), 'goal_source': 'cli'}
    parts = ['api', 'sessions', args.session, 'goal']
    method, data = 'GET', {}
    if args.action in ('set', 'replace'):
        text = ' '.join(args.text).strip()
        if not text:
            print(f'ERROR: goal {args.action} requires non-empty text', file=sys.stderr)
            return 1
        method, data = 'POST', {'text': text, 'replace': args.action == 'replace'}
    elif args.action == 'clear':
        method = 'DELETE'
    result = plugin_runtime.entrypoint('planning').dispatch(method, parts, {}, data, ctx)
    if result is None:
        # A malformed id never reaches our route, so dispatch declines it; the CLI
        # still has to say so instead of unpacking nothing.
        print('ERROR: 未知的会话标识，需要 32 位十六进制 session id', file=sys.stderr)
        return 1
    status, payload = result
    return _report(status, payload)
