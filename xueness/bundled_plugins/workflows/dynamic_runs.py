"""Session-scoped control for dynamic workflow runs (``/dwf``).

A *dynamic run* is a workflow or background job an agent started while working in
a session. The model-facing tools stamp the durable ``WorkflowStore`` record with
the owning session, so listing, cancelling and resuming reuse the very same
records, the same detached worker and the same ``launch``/``control`` paths the
CLI and panel already use — there is no second runtime here.

Status and resumability are decided server side from the stored record plus
whether a live owner still holds the run's runner lock, and every refusal comes
back as ``{reason, detail}`` so CLI, HTTP and the chat slash command tell the
same story. Enabling the plugin never authorizes execution: resuming a plan with
command nodes still needs an explicit approval, and actor nodes still need the
host's real-model switch.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import re

from ... import plugin_runtime
from .workflows import ACTIVE, WorkflowStore

PLUGIN = 'workflows'
SESSION = re.compile(r'[0-9a-f]{32}')
SUBCOMMANDS = ('list', 'cancel', 'resume')
USAGE = 'dwf [list|cancel [runId]|resume <runId>] --session <id>'
CANDIDATE_LIMIT = 8


class DynamicRunError(ValueError):
    """A refused dwf request: stable reason, human detail, HTTP status."""

    def __init__(self, reason, detail, status=400, **extra):
        super().__init__(f'{reason}: {detail}')
        self.reason, self.detail, self.status, self.extra = reason, detail, status, extra

    def payload(self) -> dict:
        return {'ok': False, 'status': self.status,
                'refusal': {'reason': self.reason, 'detail': self.detail}, **self.extra}


def require_enabled(state_dir) -> None:
    if state_dir is None or not plugin_runtime.is_enabled(state_dir, PLUGIN):
        raise DynamicRunError('plugin_disabled',
                              f'plugin disabled or dependency unavailable: {PLUGIN}', 403)


def owner_session_id(session) -> str | None:
    """The session id a tool call may stamp on a new run, or ``None``."""
    if not isinstance(session, dict):
        return None
    sid = session.get('id')
    return sid if isinstance(sid, str) and SESSION.fullmatch(sid) else None


def _store(state_dir) -> WorkflowStore:
    return WorkflowStore(Path(state_dir))


def _session(store, sid) -> dict:
    """dwf only ever manages the workspace of the session it was asked about."""
    if not isinstance(sid, str) or not SESSION.fullmatch(sid):
        raise DynamicRunError('invalid_session', '需要 32 位十六进制的会话 id', 400)
    try:
        session = store.load(sid)
    except (OSError, ValueError, KeyError):
        raise DynamicRunError('session_not_found', f'未知会话: {sid}', 404) from None
    if not isinstance(session, dict) or not isinstance(session.get('root'), str):
        raise DynamicRunError('session_not_found', f'未知会话: {sid}', 404)
    return session


def _workspace(session) -> Path:
    try:
        return Path(session['root']).resolve()
    except OSError:
        raise DynamicRunError('invalid_session', '会话工作区不可用', 400) from None


def _scope(state_dir, sessions, sid):
    """One dwf request's boundary: the workflow store plus the session's workspace."""
    require_enabled(state_dir)
    session = _session(sessions, sid)
    return _store(state_dir), _workspace(session)


def _attribution(record, sid, workspace):
    """``(matched, how)`` — a tagged run belongs to one session, an untagged run
    (plain ``workflow create``/``jobs start``) only to its own workspace."""
    owner = record.get('owner_session')
    if isinstance(owner, str) and owner:
        return (owner == sid, 'session') if owner == sid else (False, None)
    try:
        same = Path(record.get('root', '')).resolve() == workspace
    except OSError:
        same = False
    return (same, 'workspace') if same else (False, None)


def _records(store, sid, workspace):
    found = []
    for item in store.list():
        try:
            record = store.load(item['id'])
        except (OSError, ValueError, KeyError):
            continue
        matched, how = _attribution(record, sid, workspace)
        if matched:
            found.append((record, how))
    return found


def _live_owner(store, wid) -> bool:
    """True while a detached worker still holds this run's runner lock."""
    try:
        with store.lock(wid, '.runner', blocking=False):
            return False
    except BlockingIOError:
        return True
    except (OSError, ValueError):
        return False


def _stamp(value):
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat(timespec='seconds')
    except (TypeError, ValueError, OSError):
        return None


def _node_kinds(record):
    nodes = (record.get('plan') or {}).get('nodes') or []
    return (any(node.get('kind', 'command') == 'command' for node in nodes),
            any(node.get('kind') == 'agent' for node in nodes))


def _view(store, record, attribution) -> dict:
    """Server-decided status plus whether ``resume`` could succeed right now."""
    status = record.get('status')
    live = _live_owner(store, record['id'])
    in_flight = status in ACTIVE
    blocked = None
    if in_flight and live:
        blocked = {'reason': 'already_running',
                   'detail': '运行仍有存活的 owner 进程；如需停止请先取消。'}
    elif status == 'awaiting_user':
        blocked = {'reason': 'awaiting_actor_answer',
                   'detail': 'actor 正在等待回答，回答后运行会自行继续。'}
    elif status == 'completed':
        blocked = {'reason': 'already_completed',
                   'detail': '运行已全部完成；想复用结果请新建运行并指定 reuse。'}
    elif status == 'created':
        blocked = {'reason': 'not_started',
                   'detail': '运行尚未启动过，请使用 workflow start 或在面板批准计划后启动。'}
    commands, agents = _node_kinds(record)
    started = next((event.get('at') for event in (record.get('events') or [])
                    if isinstance(event, dict) and event.get('type') == 'started'), None)
    return {'id': record['id'], 'name': (record.get('plan') or {}).get('name', 'Workflow'),
            'status': status, 'attribution': attribution,
            'inFlight': bool(in_flight and live), 'stale': bool(in_flight and not live),
            'requiresApproval': commands, 'requiresRealModel': agents,
            'startedAt': _stamp(started if started is not None else record.get('created_at')),
            'updatedAt': _stamp(record.get('updated_at')),
            'resumable': blocked is None, 'resumeRefusal': blocked}


def _find(found, run_id, store):
    if not isinstance(run_id, str) or not SESSION.fullmatch(run_id):
        raise DynamicRunError('invalid_run', 'runId 需要 32 位十六进制的工作流 id', 400)
    for record, attribution in found:
        if record['id'] == run_id:
            return record, attribution
    raise DynamicRunError('not_found', f'该会话的工作区里没有 id 为 {run_id} 的工作流运行', 404)


def list_runs(state_dir, sessions, sid) -> dict:
    store, workspace = _scope(state_dir, sessions, sid)
    views = [_view(store, record, how) for record, how in _records(store, sid, workspace)]
    return {'session': sid, 'workspace': str(workspace), 'runs': views,
            'inFlight': sum(1 for view in views if view['inFlight']),
            'resumable': sum(1 for view in views if view['resumable'])}


def cancel(state_dir, sessions, sid, run_id=None) -> dict:
    store, workspace = _scope(state_dir, sessions, sid)
    found = _records(store, sid, workspace)
    if run_id is None:
        flight = [(record, how) for record, how in found if record.get('status') in ACTIVE]
        if not flight:
            raise DynamicRunError('none_in_flight', '该会话当前没有进行中的工作流运行。', 409,
                                  runs=[_view(store, record, how) for record, how in found][:CANDIDATE_LIMIT])
        if len(flight) > 1:
            raise DynamicRunError('ambiguous',
                                  '存在多个进行中的运行，请带上 runId 再取消。', 409,
                                  candidates=[_view(store, record, how) for record, how in flight][:CANDIDATE_LIMIT])
        run_id = flight[0][0]['id']
    record, attribution = _find(found, run_id, store)
    status = record.get('status')
    if status == 'cancelled':
        # Idempotent: an already cancelled run is reported, never rewritten.
        return {'ok': True, 'action': 'cancel', 'alreadyCancelled': True,
                'run': _view(store, record, attribution)}
    if status not in ACTIVE:
        raise DynamicRunError('not_active', f'运行已结束（{status}），无法取消；记录保持不变。', 409)
    try:
        settled = store.control(record['id'], 'cancel')
    except ValueError as exc:
        raise DynamicRunError('not_active', str(exc), 409) from None
    return {'ok': True, 'action': 'cancel', 'alreadyCancelled': False,
            'run': _view(store, settled, attribution)}


def resume(state_dir, sessions, sid, run_id, *, approved=False, allow_real=False) -> dict:
    store, workspace = _scope(state_dir, sessions, sid)
    record, attribution = _find(_records(store, sid, workspace), run_id, store)
    view = _view(store, record, attribution)
    if view['resumeRefusal'] is not None:
        refusal = view['resumeRefusal']
        raise DynamicRunError(refusal['reason'], refusal['detail'], 409)
    commands, agents = _node_kinds(record)
    if commands and approved is not True:
        raise DynamicRunError('approval_required',
                              '恢复会执行计划中的命令节点，需要显式批准：CLI 加 --approve，HTTP 传 approve=true。',
                              403)
    if agents and allow_real is not True:
        raise DynamicRunError('model_execution_disabled',
                              '计划包含 actor 节点，需要宿主允许真实模型调用：CLI 加 --allow-real。', 403)
    try:
        if record.get('status') in ACTIVE:
            # Same recovery the standalone `workflow recover` does: a stale active
            # run has no live owner, so its interrupted nodes can be re-driven.
            store.control(record['id'], 'recover')
        launched = store.launch(record['id'], approved=approved, allow_real=allow_real)
    except BlockingIOError:
        raise DynamicRunError('already_running', '另一个进程正在驱动该运行。', 409) from None
    except ValueError as exc:
        if isinstance(exc, DynamicRunError):
            raise
        raise DynamicRunError('not_resumable', str(exc), 409) from None
    return {'ok': True, 'action': 'resume', 'run': _view(store, launched, attribution)}


def invoke(state_dir, sessions, action, sid, run_id=None, *, approved=False, allow_real=False) -> dict:
    if action == 'list':
        return list_runs(state_dir, sessions, sid)
    if action == 'cancel':
        return cancel(state_dir, sessions, sid, run_id)
    if action == 'resume':
        return resume(state_dir, sessions, sid, run_id, approved=approved, allow_real=allow_real)
    raise DynamicRunError('invalid_arguments', f'未知的 dwf 子命令: {action}；用法 {USAGE}', 400)


def parse_invocation(argument) -> tuple[str, str | None]:
    """``/dwf ...`` text → ``(action, runId)``, refusing anything unsupported."""
    tokens = (argument or '').split()
    if not tokens:
        return 'list', None
    action = tokens[0].casefold()
    if action not in SUBCOMMANDS:
        raise DynamicRunError('invalid_arguments', f'未知的 dwf 子命令: {tokens[0]}；用法 /{USAGE}', 400)
    if action == 'list' and len(tokens) > 1 or len(tokens) > 2:
        raise DynamicRunError('invalid_arguments', f'用法 /{USAGE}', 400)
    if action == 'resume' and len(tokens) != 2:
        raise DynamicRunError('invalid_arguments', f'resume 必须指定一个 runId；用法 /{USAGE}', 400)
    return action, (tokens[1] if len(tokens) > 1 else None)


def chat(state_dir, sessions, session, argument) -> dict:
    """Chat-loop face over the same implementation as the CLI and HTTP."""
    action, run_id = parse_invocation(argument)
    if not isinstance(session, dict) or not isinstance(session.get('id'), str):
        raise DynamicRunError('session_not_found', '当前还没有会话，无法管理动态工作流运行。', 404)
    return invoke(state_dir, sessions, action, session['id'], run_id)


def execute_cli(args, deps=None) -> dict:
    """CLI face: ``xueness workflow dwf …`` over the same implementation."""
    from ...core import Store
    state_dir = Path(args.state)
    return invoke(state_dir, Store(state_dir), args.dwf_action, args.session,
                  getattr(args, 'run', None), approved=bool(getattr(args, 'approve', False)),
                  allow_real=bool(getattr(args, 'allow_real', False)))


def _web_root_allowed(ctx, sessions, sid) -> None:
    """A web request may only manage runs inside a workspace the server permits."""
    if ctx.get('web_runs') is None:
        return
    session = _session(sessions, sid)
    from ...web import _allowed_root
    from ..settings.workspaces_api import allowed_roots
    try:
        _allowed_root(Path(session['root']), ctx['web_runs'], ctx['project_dir'], allowed_roots(ctx))
    except (ValueError, OSError, KeyError):
        raise DynamicRunError('workspace_not_allowed', '会话工作区不在服务器允许的范围内。', 403) from None


def dispatch(method, parts, query, data, ctx):
    """``GET /api/workflows/dwf`` plus ``POST /api/workflows/dwf/cancel|resume``."""
    if not isinstance(parts, list) or parts[:3] != ['api', 'workflows', 'dwf']:
        return None
    action = 'list' if len(parts) == 3 else parts[3]
    if len(parts) > 4 or action not in SUBCOMMANDS:
        return 404, {'error': 'operation not found'}
    if (method == 'GET') != (action == 'list'):
        return 405, {'error': 'method not allowed'}
    sessions = ctx.get('store')
    if sessions is None:
        return 500, {'error': 'session store unavailable'}
    try:
        approved = False
        if method == 'GET':
            sid, run_id = (query or {}).get('session', [''])[0], None
        else:
            if not isinstance(data, dict) or set(data) - {'session', 'runId', 'approve'}:
                return 400, {'error': 'expected session, optional runId and approve'}
            sid, run_id = data.get('session'), data.get('runId')
            approved = data.get('approve') is True
            if run_id is not None and not isinstance(run_id, str):
                return 400, {'error': 'runId must be a string'}
            if action == 'resume' and not isinstance(run_id, str):
                return 400, {'error': 'resume requires runId'}
        _web_root_allowed(ctx, sessions, sid)
        result = invoke(ctx.get('state_dir'), sessions, action, sid, run_id,
                        approved=approved, allow_real=ctx.get('allow_real') is True)
    except DynamicRunError as exc:
        return exc.status, exc.payload()
    except (TypeError, KeyError):
        return 400, {'error': 'invalid dwf request'}
    return 200, result
