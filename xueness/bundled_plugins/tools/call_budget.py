"""Default-off, session-turn tool-call budget owned by the tools plugin."""
from __future__ import annotations

import json
import os
import re
import threading
import weakref
from contextlib import contextmanager
from pathlib import Path

FEATURE_ID = 'tools.call_budget_experimental'
SETTINGS_SECTION = 'general'
ENABLED_KEY = 'toolsCallBudgetEnabled'
LIMIT_KEY = 'toolsCallBudgetLimit'
DEFAULT_LIMIT = 100
MIN_LIMIT = 1
MAX_LIMIT = 10000
SESSION_FIELD = 'tool_call_budget'
_SCOPE_NAMESPACE = 'tools.call_budget'
_BUDGET_DIR = '.tools-call-budgets'
_LOCK_DIR = '.tools-call-budget-locks'
_MAX_RECORD_BYTES = 4096
_LOCKS = weakref.WeakValueDictionary()
_LOCKS_GUARD = threading.Lock()
_SCOPE_GUARD = threading.Lock()
_MEMORY_SESSION_LOCK = threading.RLock()


def _configuration(state_dir):
    if state_dir is None:
        return False, DEFAULT_LIMIT
    from ...plugin_runtime import is_enabled
    if not is_enabled(state_dir, 'tools'):
        return False, DEFAULT_LIMIT
    from ..settings.settings_store import load_settings
    general = load_settings(state_dir).get(SETTINGS_SECTION, {})
    if not isinstance(general, dict) or general.get(ENABLED_KEY) is not True:
        return False, DEFAULT_LIMIT
    limit = general.get(LIMIT_KEY, DEFAULT_LIMIT)
    if type(limit) is not int or not MIN_LIMIT <= limit <= MAX_LIMIT:
        limit = DEFAULT_LIMIT
    return True, limit


def enabled(state_dir):
    return _configuration(state_dir)[0]


def _turn_id(session):
    from ...core import _turn_id as current_turn
    return current_turn(session)


def _session_lock(state_dir, session_id):
    key = (str(Path(state_dir).expanduser().resolve()), session_id)
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = _LOCKS[key] = threading.RLock()
        return lock


def _stored_usage(session, turn_id):
    """Read the compatibility/in-memory projection from a session object."""
    record = session.get(SESSION_FIELD)
    if record is None:
        return 0
    if not isinstance(record, dict):
        raise ValueError('invalid tool call budget record')
    saved_turn = record.get('turn_id')
    if not isinstance(saved_turn, str) or not saved_turn:
        raise ValueError('invalid tool call budget turn')
    if saved_turn != turn_id:
        return 0
    used = record.get('used')
    if type(used) is not int or used < 0:
        raise ValueError('invalid current-turn tool call budget')
    return used


def _persistent_session(store, session):
    if not isinstance(session, dict) or store is None:
        return None
    if not callable(getattr(store, 'load', None)):
        # The tools subagent runner deliberately uses an in-memory _NullStore;
        # its child session object is the durable scope for that bounded run.
        return None
    sid = session.get('id')
    if not isinstance(sid, str) or not re.fullmatch(r'[0-9a-f]{32}', sid):
        raise ValueError('invalid persistent session id')
    path_method = getattr(store, '_path', None)
    if callable(path_method):
        path_method(sid)
    return sid


def _memory_session(store, session):
    """Whether a session belongs to the intentionally in-memory child runner."""
    return (isinstance(session, dict) and store is not None
            and not callable(getattr(store, 'load', None)))


def _sidecar_paths(state_dir, sid, *, create=False):
    from ...resources import _is_link
    state = Path(state_dir)
    if _is_link(state):
        raise ValueError('invalid tool budget state directory')
    data_dir = state / _BUDGET_DIR
    lock_dir = state / _LOCK_DIR
    if _is_link(data_dir) or _is_link(lock_dir):
        raise ValueError('invalid tool budget storage directory')
    if create:
        data_dir.mkdir(mode=0o700, exist_ok=True)
        lock_dir.mkdir(mode=0o700, exist_ok=True)
        if _is_link(data_dir) or _is_link(lock_dir):
            raise ValueError('invalid tool budget storage directory')
        from ...resources import _protect_private_directory
        _protect_private_directory(data_dir)
        _protect_private_directory(lock_dir)
    data_path = data_dir / (sid + '.json')
    lock_path = lock_dir / (sid + '.lock')
    if _is_link(data_path) or _is_link(lock_path):
        raise ValueError('invalid tool budget record path')
    return data_path, lock_path


@contextmanager
def _sidecar_lock(state_dir, sid):
    from ... import file_lock
    from ...resources import _is_link, _protect_private_file
    _data_path, lock_path = _sidecar_paths(state_dir, sid, create=True)
    if _is_link(lock_path):
        raise ValueError('invalid tool budget lock')
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR |
                 getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        _protect_private_file(fd)
        file_lock.flock(fd, file_lock.LOCK_EX)
        yield
    finally:
        try:
            file_lock.flock(fd, file_lock.LOCK_UN)
        finally:
            os.close(fd)


def _load_sidecar(state_dir, sid):
    from ...resources import _is_link
    data_path, _lock_path = _sidecar_paths(state_dir, sid)
    if _is_link(data_path):
        raise ValueError('invalid tool budget record')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(data_path, flags)
    except FileNotFoundError:
        return None
    try:
        with os.fdopen(fd, 'rb') as stream:
            raw = stream.read(_MAX_RECORD_BYTES + 1)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    if len(raw) > _MAX_RECORD_BYTES:
        raise ValueError('tool budget record is too large')
    try:
        record = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError('invalid tool budget record') from None
    if (not isinstance(record, dict) or set(record) != {'turn_id', 'used'}
            or not isinstance(record.get('turn_id'), str)
            or not record['turn_id'] or type(record.get('used')) is not int
            or record['used'] < 0):
        raise ValueError('invalid tool budget record')
    return record


def _write_sidecar(state_dir, sid, record):
    from ...resources import _atomic_write_json
    data_path, _lock_path = _sidecar_paths(state_dir, sid, create=True)
    if data_path.is_symlink():
        raise ValueError('invalid tool budget record path')
    _atomic_write_json(data_path, record, private=True)


def _current_session(session, store, sid):
    """Use the saved turn boundary when a direct caller passed a stale snapshot."""
    try:
        current = store.load(sid)
    except FileNotFoundError:
        return session
    if not isinstance(current, dict) or current.get('id') != sid:
        raise ValueError('invalid persisted session')
    return current


def _persistent_usage(state_dir, session, store, sid, *, current_session=None):
    current = current_session or _current_session(session, store, sid)
    turn_id = _turn_id(current)
    record = _load_sidecar(state_dir, sid)
    if record is None:
        # Migrate an in-memory/older session projection once. New reservations
        # are authoritative in the plugin sidecar and never save stale journals.
        used = _stored_usage(current, turn_id)
    else:
        used = record['used'] if record['turn_id'] == turn_id else 0
    return turn_id, used


def _status(state_dir, session, store, execution_scope=None):
    enabled, limit = _configuration(state_dir)
    if not enabled:
        return None
    sid = _persistent_session(store, session)
    if sid is not None:
        current = _current_session(session, store, sid)
        turn_id, used = _persistent_usage(
            state_dir, session, store, sid, current_session=current)
        scope = 'session'
    elif _memory_session(store, session):
        with _MEMORY_SESSION_LOCK:
            turn_id = _turn_id(session)
            used = _stored_usage(session, turn_id)
        scope = 'session'
    else:
        state = (execution_scope.get(_SCOPE_NAMESPACE)
                 if isinstance(execution_scope, dict) else None)
        if state is None:
            used = 0
        elif (not isinstance(state, dict)
              or type(state.get('used')) is not int or state.get('used') < 0
              or not isinstance(state.get('call_ids'), set)
              or not hasattr(state.get('lock'), 'acquire')):
            raise ValueError('invalid execution-scope tool call budget')
        else:
            with state['lock']:
                used = state['used']
        turn_id = None
        scope = 'execution'
    return {'enabled': True, 'scope': scope, 'turn_id': turn_id,
            'used': used, 'limit': limit, 'remaining': max(0, limit - used)}


def status_for_context(*, state_dir=None, session=None, store=None,
                       execution_scope=None):
    """Return enabled usage without consuming quota or persisting a record."""
    try:
        if execution_scope is None:
            from ...tool_contract import execution_context
            execution_scope = execution_context().get('execution_scope')
        return _status(state_dir, session, store, execution_scope)
    except (OSError, TypeError, ValueError):
        return None


def _denial(status):
    return {'ok': False, 'error': 'tool call budget exhausted',
            'error_code': 'tool_call_budget_exhausted', 'retryable': False,
            'user_reason': ('本轮工具调用预算已耗尽（%s/%s）。请开始新一轮或调整工具调用预算。'
                            % (status['used'], status['limit'])),
            'call_budget': status}


def _scope_state():
    from ...tool_contract import execution_context
    try:
        context = execution_context()
    except ValueError:
        return None
    execution_scope = context.get('execution_scope')
    if not isinstance(execution_scope, dict):
        return None
    with _SCOPE_GUARD:
        if _SCOPE_NAMESPACE not in execution_scope:
            execution_scope[_SCOPE_NAMESPACE] = {
                'used': 0, 'turn_id': None, 'lock': threading.RLock(),
                'call_ids': set()}
        state = execution_scope[_SCOPE_NAMESPACE]
        if (not isinstance(state, dict)
                or type(state.get('used')) is not int or state.get('used') < 0
                or not isinstance(state.get('call_ids'), set)
                or not hasattr(state.get('lock'), 'acquire')):
            raise ValueError('invalid execution-scope tool call budget')
    return state


def reserve(state_dir, session, store, tool_call_id=None):
    """Atomically consume one call, or return a permanent budget denial."""
    enabled, limit = _configuration(state_dir)
    if not enabled:
        return None
    from ...tool_contract import execution_context
    try:
        context = execution_context()
    except ValueError:
        context = {}
    if tool_call_id is None:
        candidate = context.get('tool_call_id')
        tool_call_id = candidate if isinstance(candidate, str) else None
    try:
        scope_state = _scope_state()
    except ValueError:
        return {'ok': False, 'error': 'tool call budget unavailable',
                'error_code': 'tool_call_budget_unavailable', 'retryable': False,
                'user_reason': '执行范围的工具预算记录无效，本次调用已阻止。'}
    try:
        sid = _persistent_session(store, session)
    except (OSError, TypeError, ValueError):
        return {'ok': False, 'error': 'tool call budget unavailable',
                'error_code': 'tool_call_budget_unavailable', 'retryable': False,
                'user_reason': '无法确认持久会话轮次，本次工具调用已阻止。'}
    if sid is not None:
        try:
            with _session_lock(state_dir, sid), _sidecar_lock(state_dir, sid):
                current = _current_session(session, store, sid)
                turn_id = _turn_id(current)
                if _turn_id(session) != turn_id:
                    return {'ok': False, 'error': 'session turn changed',
                            'error_code': 'tool_call_budget_unavailable',
                            'retryable': False,
                            'user_reason': '会话轮次已更新，本次旧轮工具调用已阻止。'}
                dedupe_key = ('session', sid, turn_id, tool_call_id)
                if (isinstance(tool_call_id, str) and tool_call_id
                        and scope_state is not None):
                    with scope_state['lock']:
                        if dedupe_key in scope_state['call_ids']:
                            return None
                _turn_id_record, used = _persistent_usage(
                    state_dir, session, store, sid, current_session=current)
                status = {'enabled': True, 'scope': 'session', 'turn_id': turn_id,
                          'used': used, 'limit': limit,
                          'remaining': max(0, limit - used)}
                if used >= limit:
                    return _denial(status)
                _write_sidecar(state_dir, sid,
                               {'turn_id': turn_id, 'used': used + 1})
                session[SESSION_FIELD] = {'turn_id': turn_id, 'used': used + 1}
                if (isinstance(tool_call_id, str) and tool_call_id
                        and scope_state is not None):
                    with scope_state['lock']:
                        scope_state['call_ids'].add(dedupe_key)
                return None
        except (OSError, TypeError, ValueError):
            return {'ok': False, 'error': 'tool call budget unavailable',
                    'error_code': 'tool_call_budget_unavailable',
                    'retryable': False,
                    'user_reason': '本轮工具预算记录或存储不可用，本次调用已阻止。'}

    if _memory_session(store, session):
        with _MEMORY_SESSION_LOCK:
            turn_id = _turn_id(session)
            try:
                used = _stored_usage(session, turn_id)
            except ValueError:
                return {'ok': False, 'error': 'tool call budget unavailable',
                        'error_code': 'tool_call_budget_unavailable',
                        'retryable': False,
                        'user_reason': '本轮工具预算记录无效，本次调用已阻止。'}
            if (isinstance(tool_call_id, str) and tool_call_id
                    and scope_state is not None):
                dedupe_key = ('memory-session', id(session), turn_id,
                              tool_call_id)
                with scope_state['lock']:
                    if dedupe_key in scope_state['call_ids']:
                        return None
            else:
                dedupe_key = None
            status = {'enabled': True, 'scope': 'session', 'turn_id': turn_id,
                      'used': used, 'limit': limit,
                      'remaining': max(0, limit - used)}
            if used >= limit:
                return _denial(status)
            session[SESSION_FIELD] = {'turn_id': turn_id, 'used': used + 1}
            if (isinstance(tool_call_id, str) and tool_call_id
                    and scope_state is not None):
                with scope_state['lock']:
                    scope_state['call_ids'].add(dedupe_key)
            return None

    if scope_state is None:
        return {'ok': False, 'error': 'tool call budget unavailable',
                'error_code': 'tool_call_budget_unavailable', 'retryable': False,
                'user_reason': '执行范围不可用，无法计入工具调用预算。'}
    with scope_state['lock']:
        if (isinstance(tool_call_id, str) and tool_call_id
                and tool_call_id in scope_state['call_ids']):
            return None
        used = scope_state.get('used') if type(scope_state.get('used')) is int else 0
        status = {'enabled': True, 'scope': 'execution', 'turn_id': None,
                  'used': used, 'limit': limit, 'remaining': max(0, limit - used)}
        if used >= limit:
            return _denial(status)
        scope_state['used'] = used + 1
        if isinstance(tool_call_id, str) and tool_call_id:
            scope_state['call_ids'].add(tool_call_id)
    return None


def before_tool_effect(payload):
    """Strict plugin callback for the post-Gate, pre-effect seam."""
    if not isinstance(payload, dict):
        return None
    denial = reserve(payload.get('state_dir'), payload.get('session'),
                     payload.get('store'), payload.get('tool_call_id'))
    return {'decision': 'deny', 'result': denial} if denial is not None else None


def project_session(state_dir, session, store=None):
    """Safe current-turn projection for the tools status endpoint."""
    enabled, limit = _configuration(state_dir)
    if not enabled:
        return {'enabled': False}
    if not isinstance(session, dict):
        return {'enabled': True, 'scope': 'session', 'turn_id': None,
                'used': 0, 'limit': limit, 'remaining': limit}
    sid = _persistent_session(store, session)
    if sid is not None:
        current = _current_session(session, store, sid)
        turn_id, used = _persistent_usage(
            state_dir, session, store, sid, current_session=current)
    elif _memory_session(store, session):
        with _MEMORY_SESSION_LOCK:
            turn_id = _turn_id(session)
            used = _stored_usage(session, turn_id)
    else:
        turn_id = _turn_id(session)
        used = _stored_usage(session, turn_id)
    return {'enabled': True, 'scope': 'session', 'turn_id': turn_id,
            'used': used, 'limit': limit, 'remaining': max(0, limit - used)}


def dispatch_http(method, parts, query, data, ctx):
    """GET /api/tools/call-budget?session=<sid>, bounded to host workspaces."""
    if parts != ['api', 'tools', 'call-budget']:
        return None
    if method != 'GET':
        return 405, {'error': 'method not allowed'}
    values = query.get('session') if isinstance(query, dict) else None
    if isinstance(values, list):
        if len(values) != 1:
            return 400, {'error': 'expected one session id'}
        sid = values[0]
    else:
        sid = values
    store = ctx.get('store')
    if not isinstance(sid, str) or store is None:
        return 400, {'error': 'session id is required'}
    try:
        store._path(sid)
        session = store.load(sid)
    except (OSError, ValueError, KeyError):
        return 404, {'error': 'session not found'}
    try:
        root = Path(session.get('root')).resolve(strict=True)
        from ..settings.workspaces_api import allowed_roots
        permitted = any(root == allowed or root.is_relative_to(allowed)
                        for allowed in allowed_roots(ctx))
    except (OSError, RuntimeError, TypeError, ValueError):
        permitted = False
    if not permitted:
        return 404, {'error': 'session not found'}
    try:
        return 200, project_session(ctx['state_dir'], session, store)
    except (OSError, TypeError, ValueError):
        return 503, {'error': 'tool call budget status unavailable'}
