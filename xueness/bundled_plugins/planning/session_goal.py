"""Durable session goals, explicit lifecycle controls and completion projection.

The model's wording is never sufficient to complete a goal. goal_driver owns
the independent verifier and bounded continuation at safe run boundaries.
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
STATUSES = ('active', 'paused', 'blocked', 'budget_limited', 'complete', 'achieved', 'cleared')
#: Worst-of order: an unassessed goal must not look like a passed one.
STATUS_RANK = ('passed', 'not_assessed', 'failed')
SESSION_RE = re.compile(r'[0-9a-f]{32}')
ACHIEVED_RE = re.compile(r'目标已(?:完成|达成|实现)|goal\s+(?:achieved|complete|completed)', re.I)
DENIED_RE = re.compile(r'未|没|无法|尚未|not\s|never|still', re.I)
#: Statuses that still occupy the session's single goal slot.
OCCUPIED = tuple(status for status in STATUSES if status != 'cleared')
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
        if not isinstance(entry, dict) or entry.get('action') not in (
                'set', 'replace', 'clear', 'achieved', 'complete', 'pause', 'resume',
                'blocked', 'budget_limited'):
            continue
        item = {'action': entry['action'], 'at': str(entry.get('at', ''))[:40]}
        for key in ('text', 'source'):
            value = entry.get(key)
            if isinstance(value, str) and value:
                item[key] = value[:300] if key == 'text' else value[:20]
        history.append(item)
    result = {'text': text.strip(), 'status': status,
            'setAt': str(raw.get('setAt', ''))[:40], 'updatedAt': str(raw.get('updatedAt', ''))[:40],
            'history': history[-HISTORY_LIMIT:]}
    budget = raw.get('budget')
    if isinstance(budget, dict):
        result['budget'] = {key: value for key, value in budget.items()
                            if key in ('maxRounds', 'maxWallSeconds', 'maxTokens')
                            and type(value) is int and value > 0}
    runtime = raw.get('runtime')
    if isinstance(runtime, dict):
        # Runtime is host-owned inert data. Bound both string arrays and counts
        # when a migrated/user-edited state file is read.
        result['runtime'] = {}
        for key in ('rounds', 'reportedTokens', 'stagnantRounds', 'providerUsageCursor',
                    'checkpointCursor'):
            value = runtime.get(key)
            if type(value) is int and 0 <= value <= 1_000_000_000:
                result['runtime'][key] = value
        elapsed = runtime.get('elapsedSeconds')
        if type(elapsed) in (int, float) and 0 <= elapsed <= 1_000_000_000:
            result['runtime']['elapsedSeconds'] = elapsed
        for key in ('invocationElapsedBase', 'invocationElapsedSeconds'):
            value = runtime.get(key)
            if type(value) in (int, float) and 0 <= value <= 1_000_000_000:
                result['runtime'][key] = value
        for key in ('invocationStartedAt', 'lastFingerprint', 'reason'):
            if isinstance(runtime.get(key), str):
                result['runtime'][key] = runtime[key][:500]
        for key in ('seenUsage', 'seenTurns'):
            if isinstance(runtime.get(key), list):
                result['runtime'][key] = [value[:150] for value in runtime[key][-1024:]
                                          if isinstance(value, str)]
        if isinstance(runtime.get('usageComplete'), bool):
            result['runtime']['usageComplete'] = runtime['usageComplete']
    verification = raw.get('verification')
    if isinstance(verification, dict):
        safe_verification = {key: value for key, value in verification.items()
                             if key in ('passed', 'summaryHash', 'turnId', 'at', 'kind')
                             and (key != 'passed' or isinstance(value, bool))
                             and (key == 'passed' or isinstance(value, str))}
        if isinstance(verification.get('reason'), str):
            safe_verification['reason'] = verification['reason'][:1200]
        if isinstance(verification.get('evidenceIds'), list):
            safe_verification['evidenceIds'] = [value[:150] for value in verification['evidenceIds'][:24]
                                                 if isinstance(value, str)]
        if isinstance(verification.get('remaining'), list):
            safe_verification['remaining'] = [value[:500] for value in verification['remaining'][:24]
                                               if isinstance(value, str)]
        result['verification'] = safe_verification
    return result


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


def set_goal(session, text, *, state_dir, replace: bool = False, source: str = 'cli', budget=None) -> dict:
    """Install ``text`` as the session objective; an occupied slot needs ``replace``."""
    require_enabled(state_dir)
    if not isinstance(text, str) or not text.strip():
        raise GoalError('会话目标需要 1..5000 个字符的非空文本')
    if len(text) > MAX_GOAL_CHARS:
        raise GoalError('会话目标最长 5000 个字符')
    if source not in SOURCES:
        raise GoalError('未知的会话目标设置来源')
    budget = normalize_budget(budget)
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
                                                    'at': now, 'source': source}),
                       'budget': budget,
                       'runtime': {'rounds': 0, 'reportedTokens': 0, 'elapsedSeconds': 0,
                                   'stagnantRounds': 0, 'seenUsage': [], 'seenTurns': []}}
    return session['goal']


def normalize_budget(raw=None):
    if raw is None:
        return {'maxRounds': 8, 'maxWallSeconds': 600}
    if not isinstance(raw, dict) or set(raw) - {'maxRounds', 'maxWallSeconds', 'maxTokens'}:
        raise GoalError('目标预算仅支持 maxRounds、maxWallSeconds 和 maxTokens')
    budget = {'maxRounds': 8, 'maxWallSeconds': 600}
    bounds = {'maxRounds': (1, 64), 'maxWallSeconds': (1, 3600), 'maxTokens': (128, 10000000)}
    for key, value in raw.items():
        low, high = bounds[key]
        if type(value) is not int or not low <= value <= high:
            raise GoalError(f'{key} 必须是 {low}..{high} 的整数')
        budget[key] = value
    return budget


def transition(session, action, *, state_dir, source='http'):
    """Paused, blocked or exhausted goals require an explicit user resume."""
    require_enabled(state_dir)
    goal = current(session)
    if not goal or goal['status'] in ('cleared', 'complete', 'achieved'):
        raise GoalError('该会话没有可暂停或继续的目标', 409)
    if action not in ('pause', 'resume'):
        raise GoalError('目标操作仅支持 pause 或 resume')
    runtime = dict(goal.get('runtime') or {})
    current_status = goal['status']
    if action == 'pause' and current_status != 'active':
        raise GoalError('只有进行中的目标可以暂停', 409)
    if action == 'resume' and current_status not in ('paused', 'blocked', 'budget_limited'):
        raise GoalError('只有暂停、受阻或达到预算的目标可以继续', 409)
    if action == 'resume':
        # A user-authorized new execution allocation starts a fresh bounded
        # interval; prior allocation history remains visible in goal.history.
        runtime.update(rounds=0, elapsedSeconds=0, reportedTokens=0, stagnantRounds=0,
                       seenUsage=[], seenTurns=[], usageComplete=True)
        for key in ('invocationStartedAt', 'lastFingerprint', 'reason'):
            runtime.pop(key, None)
    now = _stamp()
    session['goal'] = {**goal, 'status': 'paused' if action == 'pause' else 'active',
                       'runtime': runtime, 'updatedAt': now,
                       'history': _append(goal['history'], {'action': action, 'at': now,
                                                            'source': source})}
    session['goal'].pop('verification', None)
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
    suffix = ('（持久目标，跨轮有效。完成前对照全部要求与约束，提供实际交付和验证事实；'
              '「目标已完成」等措辞不能替代核验。尚未达成请继续，受阻请说明原因。）')
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
    """Project only a driver-issued verdict anchored to this exact answer."""
    goal = current(session)
    if not goal or goal['status'] != 'active':
        return None
    import hashlib
    digest = hashlib.sha256(str(summary or '').encode('utf-8')).hexdigest()
    verification = goal.get('verification') or {}
    passed = verification.get('passed') is True and verification.get('summaryHash') == digest
    label = '会话目标：' + goal['text'][:300]
    missing = ([] if passed else
               ['会话目标等待独立核验：完成声明不能代替交付与实际验证。'])
    return {'status': 'passed' if passed else 'not_assessed', 'items': [
        {'id': 'session_goal', 'label': label, 'path': None, 'contains': [],
         'min_links': 0, 'passed': passed, 'missing': missing}],
        'reason': '' if passed else missing[0],
        'goal': {'status': 'complete' if passed else 'active', 'text': goal['text'][:300]}}


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
            _data_keys(data, {'text', 'replace', 'action', 'budget'})
            if 'action' in data and (set(data) != {'action'} or data['action'] not in ('pause', 'resume')):
                raise GoalError('pause/resume 仅接受 action 字段')
        if sid in ctx.get('running', ()):
            return 409, {'error': '请先停止运行，再修改会话目标。'}
        with lease(store, sid):
            session = _load(store, sid)
            if method == 'DELETE':
                record = persist_clear(store, session, state_dir=state_dir,
                                       source=ctx.get('goal_source', 'http'))
            elif 'action' in data:
                record = transition(session, data['action'], state_dir=state_dir,
                                    source=ctx.get('goal_source', 'http'))
                store.save(session)
            else:
                record = set_goal(session, data.get('text'), state_dir=state_dir,
                                  replace=data.get('replace', False), budget=data.get('budget'),
                                  source=ctx.get('goal_source', 'http'))
                store.save(session)
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
    goal.add_argument('action', nargs='?', default='show', choices=('show', 'set', 'replace', 'clear', 'pause', 'resume'),
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
    elif args.action in ('pause', 'resume'):
        method, data = 'POST', {'action': args.action}
    result = plugin_runtime.entrypoint('planning').dispatch(method, parts, {}, data, ctx)
    if result is None:
        # A malformed id never reaches our route, so dispatch declines it; the CLI
        # still has to say so instead of unpacking nothing.
        print('ERROR: 未知的会话标识，需要 32 位十六进制 session id', file=sys.stderr)
        return 1
    status, payload = result
    return _report(status, payload)
