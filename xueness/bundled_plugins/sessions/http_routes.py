"""Feature-owned HTTP adapters. Host supplies transport and security gates.

Host lookups intentionally remain dynamic for the historical web API/testing
surface; no copied module globals can bypass a patched runner or provider.
"""
from ... import web as host
from ..providers.provider import ProviderCallbackError, ProviderRequestError
from pathlib import Path
from contextlib import contextmanager
import json
import logging
import os
import re
import stat
import threading
import uuid
from ...resources import _is_link, _protect_private_directory, _protect_private_file


_RUN_LOG = logging.getLogger("xueness.sessions.run")
_RUN_FILE_LOG_LOCK = threading.Lock()
_RUN_DIAGNOSTIC_MAX_BYTES = 64 * 1024
_RUN_DIAGNOSTIC_MAX_RECORD_BYTES = 2048
_PROVIDER_ERROR_PRESENTATION = {
    "request_rejected": ("provider_request_rejected", 502,
                          "The model service rejected the request"),
    "authentication_failed": ("provider_authentication_failed", 502,
                               "The model service rejected authentication"),
    "endpoint_not_found": ("provider_endpoint_not_found", 502,
                           "The model service endpoint was not found"),
    "timeout": ("provider_timeout", 504, "The model request timed out"),
    "rate_limited": ("provider_rate_limited", 503,
                     "The model service rate-limited the request"),
    "service_unready": ("provider_service_unready", 503,
                        "The model service is not ready"),
    "upstream_failure": ("provider_upstream_failure", 502,
                         "The model service returned an error"),
    "connection_failed": ("provider_connection_failed", 502,
                          "Could not connect to the model service"),
    "invalid_response": ("provider_invalid_response", 502,
                         "The model service returned an invalid response"),
    "http_error": ("provider_http_error", 502,
                   "The model service returned an HTTP error"),
    "request_failed": ("provider_request_failed", 502,
                       "The model request failed"),
}


def _log_run_failure(trace_id, runstage, error_code, exception_class,
                     upstream_status=None, store_stage=None, state_dir=None):
    """Write correlation metadata only; never log exception messages or inputs."""
    trace_id = trace_id if isinstance(trace_id, str) and re.fullmatch(
        r"[0-9a-f]{16}", trace_id) else uuid.uuid4().hex[:16]
    runstage = runstage if isinstance(runstage, str) and re.fullmatch(
        r"[a-z][a-z0-9_.]{0,63}", runstage) else "run.unknown"
    error_code = error_code if isinstance(error_code, str) and re.fullmatch(
        r"[a-z][a-z0-9_]{0,63}", error_code) else "run_failed"
    exception_class = exception_class if isinstance(exception_class, str) and re.fullmatch(
        r"_?[A-Za-z][A-Za-z0-9_]{0,79}", exception_class) else "Exception"
    record = {
        "event": "session_run_failed",
        "trace_id": trace_id,
        "runstage": runstage,
        "error_code": error_code,
        "exception_class": exception_class,
    }
    if type(upstream_status) is int and 100 <= upstream_status <= 599:
        record["upstream_status"] = upstream_status
    if isinstance(store_stage, str) and store_stage in {
            "session_path", "temp_create", "protect_temp", "serialize", "flush", "replace"}:
        record["store_stage"] = store_stage
    safe_json = json.dumps(record, separators=(",", ":"), sort_keys=True)
    _RUN_LOG.error(safe_json)
    if state_dir is not None:
        _append_run_diagnostic(state_dir, safe_json)


def _append_run_diagnostic(state_dir, safe_json):
    """Persist a bounded private JSONL event without changing the run response."""
    encoded = (safe_json + "\n").encode("utf-8")
    if len(encoded) > _RUN_DIAGNOSTIC_MAX_RECORD_BYTES:
        return
    try:
        state = Path(state_dir)
        if _is_link(state):
            return
        diagnostics = state / "diagnostics"
        if _is_link(diagnostics):
            return
        diagnostics.mkdir(mode=0o700, exist_ok=True)
        if _is_link(diagnostics):
            return
        _protect_private_directory(diagnostics)
        path = diagnostics / "session-run-errors.jsonl"
        if _is_link(path):
            return
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        with _RUN_FILE_LOG_LOCK:
            fd = os.open(os.fspath(path), flags, 0o600)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    return
                _protect_private_file(fd)
                if os.fstat(fd).st_size + len(encoded) > _RUN_DIAGNOSTIC_MAX_BYTES:
                    os.ftruncate(fd, 0)
                offset = 0
                while offset < len(encoded):
                    offset += os.write(fd, encoded[offset:])
                os.fsync(fd)
            finally:
                os.close(fd)
    except Exception:
        # A diagnostic write must never hide the actual run failure.
        return


def _provider_failure_response(error, fallback_trace_id):
    code, http_status, message = _PROVIDER_ERROR_PRESENTATION.get(
        error.category, _PROVIDER_ERROR_PRESENTATION["request_failed"])
    trace_id = error.trace_id or fallback_trace_id
    if error.context_overflow:
        code = "provider_context_limit"
        message = "The model service rejected the request due to a context limit"
    upstream_status = error.status
    if upstream_status is not None:
        message += f" (HTTP {upstream_status})"
    message += f" (reference {trace_id})"
    return http_status, {
        "error": message,
        "error_code": code,
        "trace_id": trace_id,
        **({"upstream_status": upstream_status} if upstream_status is not None else {}),
    }


def _pending_approvals(session, buckets):
    """Expose live one-shot grants, never infer permission from historical audit."""
    pending = []
    for item in host.pending_denials(session):
        kind = item.get('kind') or item.get('name')
        grants = buckets.get(kind, {})
        granted = item['tool_call_id'] in grants and grants[item['tool_call_id']] == item.get('subject')
        pending.append({**item, 'granted': granted})
    return pending


def _public_model_selection(session):
    selection = session.get('model_selection')
    if not isinstance(selection, dict):
        return {}
    public = {key: selection[key] for key in ('provider_id', 'model', 'reasoning_effort')
              if key in selection and isinstance(selection[key], (str, type(None)))}
    if session.get('tool_calling') in ('native', 'json'):
        public['tool_calling'] = session['tool_calling']
    return public


def _public_runtime_budget(session):
    raw = session.get('runtime_budget')
    if not isinstance(raw, dict):
        return None
    result = {key: raw[key] for key in ('contextWindow', 'reservedOutputTokens', 'safetyReserveTokens', 'inputBudgetTokens',
              'estimatedInputTokens', 'previousEstimatedTokens', 'baseEstimatedInputTokens', 'checkpointChars', 'omittedMessages', 'activeTools')
              if type(raw.get(key)) is int and 0 <= raw[key] <= 100000000}
    if raw.get('profile') == 'lightweight':
        result['profile'] = 'lightweight'
    if raw.get('estimateMethod') == 'utf8-bytes/2':
        result['estimateMethod'] = raw['estimateMethod']
    factor = raw.get('calibrationFactor')
    if type(factor) in (int, float) and 1 <= factor <= 8:
        result['calibrationFactor'] = factor
    if type(raw.get('overflowRetry')) is bool:
        result['overflowRetry'] = raw['overflowRetry']
    return result


def _public_runtime_activity(session, key='runtime_activity'):
    from ..providers.activity import public_activity
    return public_activity(session.get(key))


def _public_runtime_activity_history(session):
    from ..providers.activity import public_activity
    history = session.get('runtime_activity_history')
    if not isinstance(history, list):
        return []
    return [safe for raw in history[-24:]
            if (safe := public_activity(raw)) is not None]


def _public_fork_parent(session):
    parent = session.get('fork_parent')
    if not isinstance(parent, dict):
        return None
    source_id = parent.get('sourceId')
    revision = parent.get('sourceRevision')
    turn = parent.get('turn')
    end_index = parent.get('endIndex')
    truncated = parent.get('historyTruncated')
    reason = parent.get('truncationReason')
    if (not isinstance(source_id, str) or not host._valid_sid(source_id)
            or not isinstance(revision, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', revision)
            or type(turn) is not int or turn < 1
            or type(end_index) is not int or end_index < 0
            or type(truncated) is not bool
            or (reason is not None and (not isinstance(reason, str) or len(reason) > 500))):
        return None
    public = {'sourceId': source_id, 'sourceRevision': revision, 'turn': turn,
              'endIndex': end_index, 'historyTruncated': truncated,
              'truncationReason': reason}
    checkpoint_id = parent.get('checkpointId')
    checkpoint_turn = parent.get('checkpointTurn')
    if (isinstance(checkpoint_id, str) and re.fullmatch(r'[0-9a-f]{32}', checkpoint_id)
            and type(checkpoint_turn) is int and checkpoint_turn >= 1):
        # Set only by sessions.fork_from_checkpoint: which workspace snapshot the
        # fork was derived from. git.rewind remains the only thing that touches
        # the shared workspace itself.
        public['checkpointId'] = checkpoint_id
        public['checkpointTurn'] = checkpoint_turn
    return public


def _public_reasoning_history(session):
    """Return bounded display-only reasoning attached to real assistant rows."""
    messages = session.get('messages')
    history = session.get('reasoning_history')
    if not isinstance(messages, list) or not isinstance(history, list):
        return []
    result = []
    for item in history[-20:]:
        if not isinstance(item, dict):
            continue
        index = item.get('message_index')
        text = item.get('text')
        if (type(index) is not int or index < 0 or index >= len(messages)
                or not isinstance(text, str) or not text):
            continue
        message = messages[index]
        if not isinstance(message, dict) or message.get('role') != 'assistant':
            continue
        result.append({'message_index': index, 'text': text[:32000]})
    return result


def _requested_model_selection(data):
    raw = data.get('model_selection')
    if raw is None:
        aliases = {'providerId': 'provider_id', 'reasoningEffort': 'reasoning_effort'}
        raw = {key: data[key] for key in ('provider_id', 'model', 'reasoning_effort',
                                          'providerId', 'reasoningEffort') if key in data}
        raw = {aliases.get(key, key): value for key, value in raw.items()}
    elif isinstance(raw, dict):
        aliases = {'providerId': 'provider_id', 'reasoningEffort': 'reasoning_effort'}
        raw = {aliases.get(key, key): value for key, value in raw.items()}
    if (not isinstance(raw, dict)
            or set(raw) - {'provider_id', 'model', 'reasoning_effort'}
            or any(value is not None and not isinstance(value, str) for value in raw.values())):
        raise ValueError('invalid model selection')
    return dict(raw)


def _bind_prepared_selection(selection, prepared):
    metadata = prepared.get('metadata') if isinstance(prepared, dict) else None
    cached = metadata.get('modelSelection') if isinstance(metadata, dict) else None
    if (not isinstance(cached, dict)
            or not isinstance(cached.get('provider_id'), str)
            or not isinstance(cached.get('model'), str)):
        raise ValueError('prepared model selection is invalid')
    bound = {}
    for field in ('provider_id', 'model', 'reasoning_effort'):
        cached_value = cached.get(field)
        requested_value = selection.get(field)
        if field in selection and requested_value != cached_value:
            raise ValueError('prepared model selection changed; prepare the input again')
        # The prepared model choice is a complete snapshot. Omitted effort
        # means the model default, so it intentionally clears an older value.
        bound[field] = cached_value
    return bound


def _consume_prepared(ctx, token, root):
    from . import composer_api
    prepared = composer_api.consume_prepared(ctx, token, Path(root).resolve())
    if (not isinstance(prepared, dict) or not isinstance(prepared.get('text'), str)
            or not isinstance(prepared.get('metadata'), dict)):
        raise ValueError('prepared input invalid or expired')
    return prepared


def _safe_input_context(session, prepared):
    metadata = prepared['metadata']
    model_selection = metadata.get('modelSelection')
    safe = {}
    for name in ('files', 'attachments', 'sessions', 'skills', 'plugins'):
        values = metadata.get(name)
        if isinstance(values, list):
            safe[name] = [
                {key: value for key, value in item.items()
                 if key in ('id', 'label', 'path', 'bytes', 'size', 'sha256', 'mimeType')}
                for item in values if isinstance(item, dict)
            ][:100]
    if isinstance(model_selection, dict):
        safe['modelSelection'] = {
            key: model_selection[key] for key in
            ('provider_id', 'model', 'protocol', 'capabilities', 'reasoning_effort')
            if key in model_selection and isinstance(model_selection[key], (str, type(None), list))
        }
    remote = metadata.get('remote')
    if isinstance(remote, dict):
        safe_remote = {key: remote[key] for key in ('id', 'digest')
                       if key in remote and isinstance(remote[key], str)}
        if set(safe_remote) == {'id', 'digest'}:
            safe['remote'] = safe_remote
    goal = prepared.get('goal')
    record = {'user_turn': sum(item.get('role') == 'user'
                               for item in session.get('messages', [])),
              'metadata': safe}
    if isinstance(goal, str) and goal.strip():
        record['goal'] = goal[:5000]
    session.setdefault('input_context', []).append(record)
    files = safe.get('files', safe.get('attachments', []))
    if files:
        session.setdefault('input_attachments', []).append({
            'user_turn': record['user_turn'], 'files': files,
        })


def _planning_entrypoint(ctx):
    """planning owns the session goal; this plugin only asks it to record one."""
    runtime = host.plugin_runtime
    if ctx.get('state_dir') is None or not runtime.is_enabled(ctx['state_dir'], 'planning'):
        return None
    return runtime.entrypoint('planning')


def _apply_prepared_goal(ctx, session, prepared, text):
    """Register a composer input flagged as the goal as this session's objective.

    The objective is the caller's own text: the prepared payload carries
    expanded context and attachments, which is not what the user marked.
    """
    if prepared is None or prepared.get('goal') is not True:
        return
    planning = _planning_entrypoint(ctx)
    apply_goal = getattr(planning, 'apply_session_goal', None) if planning else None
    if callable(apply_goal):
        apply_goal(session, text, state_dir=ctx['state_dir'], replace=True, source='composer')


class _GoalRefusal(ValueError):
    """A goal planning refused, carrying the answer its HTTP route must send."""

    def __init__(self, message, status=400, plugin=None):
        super().__init__(message)
        self.status = status
        self.body = {'error': message, **({'plugin': plugin} if plugin else {})}


def _apply_submitted_goal(ctx, session, prepared, text):
    """Apply a flagged submission's goal, or refuse with planning's own status.

    Dropping the goal silently would answer 200 for a turn whose objective was
    never recorded, and letting planning's GoalError escape reaches the generic
    500 or another route's unrelated ``ValueError`` branch. planning signals an
    expected refusal as a ``ValueError`` carrying an HTTP status, so the status
    is read structurally instead of importing another plugin's exception.
    """
    if prepared is None or prepared.get('goal') is not True:
        return
    if _planning_entrypoint(ctx) is None:
        raise _GoalRefusal('plugin disabled or dependency unavailable: planning', 403,
                           plugin='planning')
    try:
        _apply_prepared_goal(ctx, session, prepared, text)
    except ValueError as exc:
        status = getattr(exc, 'status', None)
        if type(status) is not int:
            raise
        raise _GoalRefusal(str(exc), status) from None


def _public_goal(ctx, session):
    planning = _planning_entrypoint(ctx)
    view = getattr(planning, 'session_goal_view', None) if planning else None
    return view(session) if callable(view) else None


def _record_prepared_commands(session, prepared):
    """Persist command invocation audit data from the trusted prepared cache.

    Prepared text is already expanded. Re-expanding the raw slash command in
    append_user_turn would discard that composed text, so the composer records
    the invocation separately and the session route appends only this safe
    audit summary.
    """
    metadata = prepared.get('metadata') if isinstance(prepared, dict) else None
    invocations = metadata.get('commandInvocations') if isinstance(metadata, dict) else None
    if not isinstance(invocations, list):
        return
    log = session.setdefault('command_invocations', [])
    for invocation in invocations:
        if not isinstance(invocation, dict):
            continue
        command, args = invocation.get('command'), invocation.get('args')
        if (isinstance(command, str) and len(command) <= 64
                and isinstance(args, str) and len(args) <= 5000):
            log.append({'command': command, 'args': args})
    if len(log) > 50:
        del log[:-50]


def _message_queue(ctx):
    from .queue import MessageQueue
    return MessageQueue(ctx['store'])


@contextmanager
def _queue_run_lease(ctx, queue, session_id):
    # Close/pause the FIFO before releasing the session's cross-process lease.
    # A rejected competing run must never pause a different worker's queue.
    with host.lease(ctx['store'], session_id):
        try:
            yield
        finally:
            try:
                queue.pause_pending(session_id)
            except (OSError, ValueError):
                pass


def _append_queued_turn(ctx, queue, session, item):
    """Append one claimed FIFO item as an ordinary, independently journaled turn."""
    from ...commands import load as load_commands
    prepared = item.get('prepared')
    commands = (None if prepared is not None else
                load_commands(ctx['state_dir'], session.get('root'))
                if host.plugin_runtime.is_enabled(ctx['state_dir'], 'commands') else [])
    session = host.append_user_turn(
        session, ctx['store'], item['text'], commands,
        queue_message_id=item['id'], persist=prepared is None)
    if prepared is not None:
        session['messages'][-1]['content'] = prepared['text']
        _safe_input_context(session, prepared)
        _record_prepared_commands(session, prepared)
        _apply_submitted_goal(ctx, session, prepared, item['text'])
        ctx['store'].save(session)
    return session


def _queue_completion(session):
    completion = session.get('completion')
    if not isinstance(completion, dict):
        return None
    return {key: completion[key] for key in (
        'status', 'verified', 'tool_execution_status', 'delivery_status') if key in completion}


def _queued_context_matches(ctx, session, item):
    prepared = item.get('prepared')
    if not isinstance(prepared, dict):
        return True
    metadata = prepared.get('metadata') or {}
    cached = metadata.get('modelSelection') or {}
    current = session.get('model_selection') or {}
    if any(cached.get(key) != current.get(key)
           for key in ('provider_id', 'model', 'reasoning_effort')):
        return False
    try:
        return _prepared_remote(ctx, prepared) == session.get('remote_connection')
    except ValueError:
        return False


def _remote_connection(ctx, remote_id, expected_digest=None):
    """Resolve a saved SSH target and bind it to its current configuration digest."""
    if not isinstance(remote_id, str) or not remote_id or len(remote_id) > 64:
        raise ValueError('remote connection selection is invalid')
    if not host.plugin_runtime.is_enabled(ctx['state_dir'], 'remote'):
        raise ValueError('remote plugin disabled or unavailable')
    remote_plugin = host.plugin_runtime.entrypoint('remote')
    result = remote_plugin.dispatch('GET', ['api', 'remote'], {}, {}, ctx)
    rows = result[1].get('connections', []) if isinstance(result, tuple) and result[0] == 200 else []
    row = next((item for item in rows if isinstance(item, dict) and item.get('id') == remote_id), None)
    digest = row.get('digest') if isinstance(row, dict) else None
    if not isinstance(digest, str) or len(digest) != 64:
        raise ValueError('remote connection unavailable; inspect the saved configuration')
    if expected_digest is not None and digest != expected_digest:
        raise ValueError('remote connection changed; inspect the saved configuration and prepare again')
    return {'id': remote_id, 'digest': digest}


def _prepared_remote(ctx, prepared):
    metadata = prepared.get('metadata') if isinstance(prepared, dict) else None
    remote = metadata.get('remote') if isinstance(metadata, dict) else None
    if remote is None:
        return None
    if (not isinstance(remote, dict) or set(remote) != {'id', 'digest'}
            or not isinstance(remote.get('id'), str)
            or not isinstance(remote.get('digest'), str)
            or len(remote['digest']) != 64):
        raise ValueError('prepared remote selection is invalid')
    return _remote_connection(ctx, remote['id'], remote['digest'])


def _bind_remote_session(ctx, session, prepared_remote):
    current = session.get('remote_connection')
    if current is not None:
        if (not isinstance(current, dict) or not isinstance(current.get('id'), str)
                or not isinstance(current.get('digest'), str)):
            raise ValueError('saved remote session selection is invalid; start a new session')
        _remote_connection(ctx, current['id'], current['digest'])
        if prepared_remote != current:
            raise ValueError('remote session selection changed; prepare the next turn for the same connection')
        return current
    if prepared_remote is not None:
        session['remote_connection'] = prepared_remote
    return prepared_remote


def _public_remote_connection(session):
    remote = session.get('remote_connection')
    if not isinstance(remote, dict):
        return None
    if (not isinstance(remote.get('id'), str) or not isinstance(remote.get('digest'), str)
            or len(remote['digest']) != 64):
        return None
    return {'id': remote['id'], 'digest': remote['digest']}


def _resolve_selection(ctx, selection):
    """Validate a model choice before it is stored or a run is dispatched."""
    return host.provider_config.resolve(
        ctx['state_dir'], selection.get('provider_id'), selection.get('model'),
        reasoning_effort=selection.get('reasoning_effort'))


def _selection_record(selection):
    record = {key: selection.get(key) for key in ('provider_id', 'model')}
    if selection.get('reasoning_effort') is not None:
        record['reasoning_effort'] = selection['reasoning_effort']
    return record


def _remember_workspace(ctx, root):
    try:
        from ..settings.workspaces_api import remember_directory
        remember_directory(ctx, root)
    except (ImportError, OSError, TypeError, ValueError):
        # A recency write is auxiliary; it must not turn an already-created
        # session or accepted message into an apparent failure.
        pass

def public_session_payload(ctx, session):
    with ctx['lock']:
        buckets = ctx['approvals'].get(session['id'], {})
        approved = {'write': sorted(buckets.get('write', {}).values()), 'edit': sorted(buckets.get('edit', {}).values()), 'exec': sorted(buckets.get('exec', {}).values()), 'mcp': sorted(buckets.get('mcp', {}).values())}
        pending = _pending_approvals(session, buckets)
    try:
        from .queue import reconcile_inactive
        queue = _message_queue(ctx)
        reconcile_inactive(ctx, queue, session['id'])
        queue_snapshot = queue.snapshot(session['id'])
    except (OSError, ValueError):
        queue_snapshot = {'queued_messages': [], 'queue_history': [],
                          'queue_error': 'cannot read message queue'}
    return {
        'id': session['id'], 'task': session['task'],
        'title': session.get('title') or session['task'], 'root': session['root'],
        'status': session.get('status'), 'steps': session.get('steps', 0),
        'mode': session.get('mode', 'build'), 'mode_history': session.get('mode_history', []),
        'permission_mode': session.get('permission_mode', 'build'),
        'permission_mode_history': session.get('permission_mode_history', []),
        'model_selection': _public_model_selection(session),
        'model_history': session.get('model_history', []),
        'runtime_profile': session.get('runtime_profile'),
        'runtime_budget': _public_runtime_budget(session),
        'runtime_activity': _public_runtime_activity(session),
        'runtime_activity_history': _public_runtime_activity_history(session),
        'pause_reason': session.get('pause_reason'),
        'pause_code': session.get('pause_code'),
        'remote_connection': _public_remote_connection(session),
        'browser_enabled': session.get('browser_enabled'),
        'compactions': session.get('compactions', []), 'streaming': session.get('streaming'),
        'reasoning_history': _public_reasoning_history(session),
        'provider_usage': session.get('provider_usage', []),
        'completion': session.get('completion'), 'todos': session.get('todos', []),
        'delivery_requirements': session.get('delivery_requirements', []),
        'goal': _public_goal(ctx, session),
        'tool_timings': session.get('tool_timings', [])[-200:],
        'pending_question': session.get('pending_question'),
        'pending': pending, 'approved': approved,
        **queue_snapshot,
        'changed_files': host.changed_paths(session),
        'forkParent': _public_fork_parent(session),
    }


def handle_GET(self, parts, path, data):
    ctx = self._ctx
    if path == '/api/sessions':
        try:
            from ..settings.settings_store import load_settings
            settings = load_settings(ctx['state_dir']).get('general', {})
            if not isinstance(settings, dict):
                settings = {}
            enabled = settings.get('taskAutoArchiveEnabled') is True
            days = settings.get('taskAutoArchiveOlderThanDays', 7)
            if (enabled and type(days) is int
                    and days in host.session_management.TASK_AUTO_ARCHIVE_DAY_OPTIONS):
                with ctx['lock']:
                    host.session_management.archive_stale(
                        ctx['store'], days, running_ids=ctx['running'],
                        has_pending=host.pending_denials,
                    )
            self._send(200, {'sessions': host.session_management.list_summaries(ctx['store'])})
        except (OSError, ValueError):
            self._send(500, {'error': 'cannot list sessions'})
        return True
    if path == '/api/sessions/archived':
        try:
            self._send(200, {'sessions': host.session_management.list_archived(ctx['store'])})
        except (OSError, ValueError):
            self._send(500, {'error': 'cannot list archived sessions'})
        return True
    if len(parts) == 3 and parts[0] == 'api' and (parts[1] == 'sessions') and host._valid_sid(parts[2]):
        # An opened detail acknowledges only the exact journal revision whose
        # mtime the session manager records. A concurrent/newer run keeps it
        # unread until the user loads that revision again.
        try:
            host.session_management.mark_viewed(ctx['store'], parts[2])
        except (BlockingIOError, OSError, ValueError):
            pass
        try:
            session = ctx['store'].load(parts[2])
        except (OSError, ValueError):
            self._send(404, {'error': 'session not found'})
            return True
        self._send(200, public_session_payload(ctx, session))
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'events') and host._valid_sid(parts[2]):
        try:
            session = ctx['store'].load(parts[2])
        except (OSError, ValueError):
            self._send(404, {'error': 'session not found'})
            return True
        query = host.urllib.parse.parse_qs(host.urllib.parse.urlparse(self.path).query)
        from . import events_cursor
        try:
            cursor = events_cursor.requested_cursor(query)
        except events_cursor.CursorError as exc:
            self._send(exc.status, {'error': str(exc), 'errorCode': exc.code,
                                   **({'resync_cursor': exc.resync_cursor}
                                      if exc.resync_cursor is not None else {})})
            return True
        if cursor is not None:
            # sessions.events_cursor is experimental and default-off; a cursor
            # request is honoured only while the operator enabled the flag.
            if not events_cursor.enabled(ctx):
                self._send(400, {'error': events_cursor.NOT_ENABLED_ERROR,
                                 'feature': events_cursor.FEATURE_ID})
                return True
            try:
                envelope = events_cursor.page(session, cursor,
                                              events_cursor.requested_limit(query))
            except events_cursor.CursorError as exc:
                self._send(exc.status, {'error': str(exc), 'errorCode': exc.code,
                                       **({'resync_cursor': exc.resync_cursor}
                                          if exc.resync_cursor is not None else {})})
                return True
            if 'text/event-stream' in (self.headers.get('Accept') or ''):
                all_events = events_cursor.numbered_events(session)
                self._send(200, events_cursor.sse_body(session, all_events,
                                                       envelope['events']),
                           'text/event-stream')
                return True
            self._send(200, envelope)
            return True
        try:
            limit = int(query.get('limit', ['200'])[0])
        except (ValueError, TypeError):
            limit = 200
        limit = max(1, min(limit, 500))
        events = host.session_events(session, limit)
        accept = self.headers.get('Accept') or ''
        if 'text/event-stream' in accept:
            lines = []
            for event in events:
                lines.append('event: ' + event.get('type', 'message'))
                lines.append('data: ' + host.json.dumps(event, ensure_ascii=False))
                lines.append('')
            body = ('\n'.join(lines) + '\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)
            return True
        self._send(200, {'id': session['id'], 'status': session.get('status'), 'steps': session.get('steps', 0), 'events': events})
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'events.v1') and host._valid_sid(parts[2]):
        try:
            session = ctx['store'].load(parts[2])
        except (OSError, ValueError):
            self._send(404, {'error': 'session not found'})
            return True
        query = host.urllib.parse.parse_qs(host.urllib.parse.urlparse(self.path).query)
        try:
            cursor = int(query.get('cursor', ['0'])[0])
        except (ValueError, TypeError):
            self._send(400, {'error': 'invalid cursor', 'errorCode': host.events_protocol.ERROR_INVALID_ARGUMENT})
            return True
        try:
            limit = int(query.get('limit', [str(host.events_protocol.DEFAULT_LIMIT)])[0])
        except (ValueError, TypeError):
            self._send(400, {'error': 'invalid limit', 'errorCode': host.events_protocol.ERROR_INVALID_ARGUMENT})
            return True
        cursor = max(0, cursor)
        limit = max(1, min(limit, host.events_protocol.MAX_LIMIT))
        derived = host.events_protocol.derive_events(session)
        envelope = host.events_protocol.page_events(session, derived, cursor, limit)
        accept = self.headers.get('Accept') or ''
        if 'text/event-stream' in accept:
            self._send(200, host.events_protocol.sse_body(envelope['events']), 'text/event-stream')
            return True
        self._send(200, envelope)
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'model') and host._valid_sid(parts[2]):
        from . import model_switch
        status, payload = model_switch.describe_http(ctx, parts[2])
        self._send(status, payload)
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'journal') and host._valid_sid(parts[2]):
        try:
            session = ctx['store'].load(parts[2])
        except (OSError, ValueError):
            self._send(404, {'error': 'session not found'})
            return True
        from .message_actions import revision
        self._send(200, {**session, 'message_revision': revision(session)})
        return True
    return False

def handle_POST(self, parts, path, data):
    ctx = self._ctx
    if path == '/api/sessions':
        task = data.get('task', '')
        if not isinstance(task, str) or not task.strip() or len(task) > host._MAX_TASK:
            self._send(400, {'error': 'task must be 1..5000 characters'})
            return True
        if 'prepared_token' in data and not isinstance(data['prepared_token'], str):
            self._send(400, {'error': 'prepared input invalid or expired'})
            return True
        try:
            requested_selection = _requested_model_selection(data)
        except ValueError as exc:
            self._send(400, {'error': str(exc)})
            return True
        try:
            if data.get('root') is None:
                from ..settings.workspaces_api import get_default_root
                root = get_default_root(ctx)
            else:
                if not isinstance(data['root'], str) or not data['root'].strip():
                    self._send(400, {'error': 'root must be a path string'})
                    return True
                from ..settings.workspaces_api import allowed_roots
                root = host._allowed_root(host.Path(data['root'].strip()), ctx['web_runs'], ctx['project_dir'], allowed_roots(ctx))
        except ValueError as exc:
            self._send(400, {'error': 'workspace root not permitted'})
            return True
        prepared = None
        prepared_remote = None
        try:
            if 'prepared_token' in data:
                try:
                    prepared = _consume_prepared(ctx, data['prepared_token'], root)
                except ValueError:
                    # The UI omits root only for its explicit isolated-workspace
                    # choice. Accept that one server-owned parent as a fallback;
                    # arbitrary prepared roots still require an explicit path.
                    if data.get('root') is None and root != ctx['web_runs'].resolve():
                        isolated_root = ctx['web_runs'].resolve()
                        prepared = _consume_prepared(ctx, data['prepared_token'], isolated_root)
                        root = isolated_root
                    else:
                        raise
                requested_selection = _bind_prepared_selection(requested_selection, prepared)
                prepared_remote = _prepared_remote(ctx, prepared)
            if requested_selection:
                _resolve_selection(ctx, requested_selection)
                requested_selection = _selection_record(requested_selection)
        except ValueError as exc:
            message = str(exc)
            if 'prepared' in message.lower():
                self._send(400, {'error': message})
            else:
                self._send(400, {'error': host.provider_config.configuration_error(exc)})
            return True
        try:
            if prepared is not None:
                # Ask the owning plugin before anything exists on disk: a refused
                # goal must not leave a session with a half-written first turn.
                _apply_submitted_goal(ctx, {}, prepared, task.strip())
            root.mkdir(parents=True, exist_ok=True)
            if data.get('root') is None and root == ctx['web_runs'].resolve():
                session = ctx['store'].new(task.strip(), root)
                root = ctx['web_runs'].resolve() / session['id']
                root.mkdir(parents=True, exist_ok=True)
                session['root'] = str(root)
                ctx['store'].save(session)
            else:
                session = ctx['store'].new(task.strip(), root)
            if requested_selection:
                session['model_selection'] = requested_selection
            if prepared is not None:
                session['messages'][1]['content'] = prepared['text']
                if prepared_remote is not None:
                    session['remote_connection'] = prepared_remote
                _safe_input_context(session, prepared)
                _record_prepared_commands(session, prepared)
                _apply_submitted_goal(ctx, session, prepared, task.strip())
            ctx['store'].save(session)
            _remember_workspace(ctx, session['root'])
        except _GoalRefusal as exc:
            self._send(exc.status, exc.body)
            return True
        except ValueError as exc:
            self._send(400, {'error': str(exc)})
            return True
        except OSError:
            self._send(500, {'error': 'cannot create session'})
            return True
        self._send(200, {'id': session['id'], 'status': session['status'], 'root': session['root']})
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'messages') and host._valid_sid(parts[2]):
        text = data.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > host._MAX_TASK:
            self._send(400, {'error': 'message must be 1..5000 characters'})
            return True
        if 'prepared_token' in data and not isinstance(data['prepared_token'], str):
            self._send(400, {'error': 'prepared input invalid or expired'})
            return True
        try:
            requested_selection = _requested_model_selection(data)
        except ValueError as exc:
            self._send(400, {'error': str(exc)})
            return True
        with ctx['lock']:
            if parts[2] in ctx['running']:
                self._send(409, {'error': 'session run already in progress'})
                return True
            try:
                session = ctx['store'].load(parts[2])
            except (OSError, ValueError):
                self._send(404, {'error': 'session not found'})
                return True
            if host.pending_denials(session):
                self._send(409, {'error': 'resolve pending approvals before a new turn'})
                return True
            try:
                queued = _message_queue(ctx).snapshot(parts[2])['queued_messages']
            except (OSError, ValueError):
                self._send(500, {'error': 'cannot read message queue'})
                return True
            if queued:
                self._send(409, {'error': 'run queued messages before sending a new turn'})
                return True
            try:
                from ...commands import load as load_commands
                with host.lease(ctx['store'], parts[2]):
                    session = ctx['store'].load(parts[2])
                    host.provider_config.reject_legacy_fake_session(session)
                    prepared = None
                    if 'prepared_token' in data:
                        prepared = _consume_prepared(ctx, data['prepared_token'],
                                                     host.Path(session['root']).resolve())
                        selection = _bind_prepared_selection(requested_selection, prepared)
                        if selection:
                            _resolve_selection(ctx, selection)
                            session['model_selection'] = _selection_record(selection)
                        prepared_remote = _prepared_remote(ctx, prepared)
                        _bind_remote_session(ctx, session, prepared_remote)
                    session = host.append_user_turn(
                        session, ctx['store'], text,
                        (None if prepared is not None else
                         load_commands(ctx['state_dir'], session.get('root'))
                         if host.plugin_runtime.is_enabled(ctx['state_dir'], 'commands') else []),
                        persist=prepared is None)
                    if prepared is not None:
                        session['messages'][-1]['content'] = prepared['text']
                        _safe_input_context(session, prepared)
                        _record_prepared_commands(session, prepared)
                        _apply_submitted_goal(ctx, session, prepared, text)
                        ctx['store'].save(session)
            except LookupError:
                self._send(409, {'error': 'session is not ready for a new turn'})
                return True
            except _GoalRefusal as exc:
                self._send(exc.status, exc.body)
                return True
            except ValueError as exc:
                message = str(exc)
                if 'legacy offline demo' in message or 'retired offline demo' in message:
                    self._send(409, {'error': message})
                elif 'prepared' in message.lower():
                    self._send(400, {'error': message})
                else:
                    self._send(400, {'error': host.provider_config.configuration_error(exc)})
                return True
            except BlockingIOError:
                self._send(409, {'error': 'session is in use by another process'})
                return True
            except OSError:
                self._send(500, {'error': 'cannot save message'})
                return True
        _remember_workspace(ctx, session['root'])
        self._send(200, {'id': session['id'], 'status': session['status'], 'steps': session['steps']})
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'model') and host._valid_sid(parts[2]):
        # sessions.runtime_model_switch: validate and store the choice. A running
        # turn applies it to its next model request only; see model_switch.
        from . import model_switch
        status, payload = model_switch.apply_http(ctx, parts[2], data)
        self._send(status, payload)
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'run') and host._valid_sid(parts[2]):
        run_trace_id = uuid.uuid4().hex[:16]
        runstage = 'request.validation'
        continue_queue = data.get('continue_queue', False)
        if type(continue_queue) is not bool:
            self._send(400, {'error': 'continue_queue must be a boolean'})
            return True
        if any((k in data for k in ('allow_write', 'allowWrite', 'allow_exec', 'allowExec',
                                    'allow_edit', 'allowEdit', 'allow_network', 'allowNetwork',
                                    'approve_all', 'approveAll'))):
            self._send(400, {'error': 'blanket approval is never accepted via web; approve single actions instead'})
            return True
        steps_present = 'steps' in data
        steps = data.get('steps') if steps_present else None
        max_chars_present = 'max_chars' in data or 'maxChars' in data
        max_chars = data.get('max_chars', data.get('maxChars')) if max_chars_present else None
        if steps_present and (type(steps) is not int or not 1 <= steps <= 20):
            self._send(400, {'error': 'steps must be 1..20'})
            return True
        if max_chars_present and (type(max_chars) is not int or not 1000 <= max_chars <= 100000):
            self._send(400, {'error': 'max_chars must be 1000..100000'})
            return True
        max_tokens = data.get('max_tokens', data.get('maxTokens'))
        if max_tokens is not None and (not isinstance(max_tokens, int) or max_tokens < 1):
            self._send(400, {'error': 'max_tokens must be a positive integer'})
            return True
        requested_profile = data.get('runtime_profile')
        if requested_profile is not None and requested_profile not in ('standard', 'lightweight'):
            self._send(400, {'error': 'runtime_profile must be standard or lightweight'})
            return True
        wall_time_present = 'max_wall_seconds' in data or 'maxWallSeconds' in data
        max_wall_seconds = data.get('max_wall_seconds', data.get('maxWallSeconds')) if wall_time_present else None
        if wall_time_present and (isinstance(max_wall_seconds, bool) or
                                  not isinstance(max_wall_seconds, (int, float)) or
                                  not 0 < max_wall_seconds <= 3600):
            self._send(400, {'error': 'max_wall_seconds must be greater than zero and at most 3600'})
            return True
        mode = data.get('mode', 'build')
        if mode not in ('plan', 'build'):
            self._send(400, {'error': "mode must be 'plan' or 'build'"})
            return True
        try:
            disallowed = host.parse_disallow_list(data.get('disallow_tools', data.get('disallowTools', data.get('disallow', None))))
        except ValueError as exc:
            self._send(400, {'error': str(exc)})
            return True
        browser = data.get('browser')
        if browser is not None and type(browser) is not bool:
            self._send(400, {'error': 'browser must be a boolean'})
            return True
        if browser is False:
            from ...tool_registry import BUILTIN_TOOL_NAMES
            disallowed = frozenset(disallowed) | frozenset(
                name for name in BUILTIN_TOOL_NAMES if name.startswith('browser_'))
        from .plan_mode import draft_policy, is_permission_mode, permission_mode_error
        permission_mode = data.get('permission_mode', data.get('permissionMode'))
        if permission_mode is not None and not is_permission_mode(permission_mode):
            self._send(400, {'error': permission_mode_error()})
            return True
        acknowledge_yolo = data.get('acknowledge_yolo', False)
        if type(acknowledge_yolo) is not bool:
            self._send(400, {'error': 'acknowledge_yolo must be a boolean'})
            return True
        if acknowledge_yolo and permission_mode != 'yolo':
            self._send(400, {'error': 'acknowledge_yolo requires permission_mode=yolo'})
            return True
        # ``plan`` belongs to this plugin, so its availability is decided by the
        # persisted sessions switch rather than by the request body alone.
        plan_available = host.plugin_runtime.is_enabled(ctx['state_dir'], 'sessions')
        if permission_mode == 'plan' and not plan_available:
            self._send(403, {'error': 'plugin disabled or dependency unavailable: sessions',
                             'plugin': 'sessions'})
            return True
        # Inert unless the run actually uses plan mode; bound to this session id
        # so one session's draft can never be the writable exception for another.
        plan_draft = None
        if plan_available:
            try:
                plan_draft = draft_policy(ctx['state_dir'], parts[2])
            except ValueError as exc:
                self._send(400, {'error': str(exc)})
                return True
        remote_choice = data.get('remote')
        if remote_choice is not None and (not isinstance(remote_choice, str) or not remote_choice):
            self._send(400, {'error': 'remote must be a configured connection id'})
            return True
        try:
            requested_selection = _requested_model_selection(data)
        except ValueError as exc:
            self._send(400, {'error': str(exc)})
            return True
        provider_name = data.get('provider', 'real')
        if provider_name == 'fake':
            self._send(400, {'error': 'the offline fake provider has been removed; configure a model provider'})
            return True
        if provider_name == 'real' and (not host.plugin_runtime.is_enabled(ctx['state_dir'], 'providers')):
            self._send(403, {'error': 'plugin disabled or dependency unavailable: providers', 'plugin': 'providers'})
            return True
        if provider_name == 'real' and (not ctx['allow_real']):
            self._send(403, {'error': 'real provider disabled by the host; set XUENESS_ALLOW_REAL=1 to enable it'})
            return True
        if provider_name != 'real':
            self._send(400, {'error': "provider must be 'real' when specified"})
            return True
        requested_selection = requested_selection or {}
        pid = requested_selection.get('provider_id', data.get('provider_id'))
        model = requested_selection.get('model', data.get('model'))
        reasoning_effort_explicit = 'reasoning_effort' in requested_selection
        reasoning_effort = requested_selection.get('reasoning_effort')
        if ((pid is not None and not isinstance(pid, str))
                or (model is not None and not isinstance(model, str))
                or (reasoning_effort is not None and not isinstance(reasoning_effort, str))):
            self._send(400, {'error': 'invalid model selection'})
            return True
        queue = _message_queue(ctx)
        with ctx['lock']:
            if parts[2] in ctx['running']:
                self._send(409, {'error': 'session run already in progress'})
                return True
            try:
                session = ctx['store'].load(parts[2])
            except (OSError, ValueError):
                self._send(404, {'error': 'session not found'})
                return True
            try:
                host.provider_config.reject_legacy_fake_session(session)
            except ValueError as exc:
                self._send(409, {'error': str(exc)})
                return True
            if permission_mode is None:
                permission_mode = session.get('permission_mode', 'build')
            if (not is_permission_mode(permission_mode)
                    or (permission_mode == 'plan' and not plan_available)):
                self._send(400, {'error': 'saved permission mode is invalid'})
                return True
            previous_permission_mode = session.get('permission_mode', 'build')
            if (permission_mode == 'yolo' and previous_permission_mode != 'yolo'
                    and not acknowledge_yolo):
                self._send(428, {
                    'error': 'confirm full access before escalating this session to yolo',
                    'error_code': 'yolo_confirmation_required',
                })
                return True
            if continue_queue and not session.get('current_queue_item_id'):
                try:
                    queued = queue.snapshot(parts[2])['queued_messages']
                except (OSError, ValueError):
                    self._send(500, {'error': 'cannot read message queue'})
                    return True
                if not queued:
                    self._send(409, {'error': 'no queued messages to continue'})
                    return True
            if session.get('status') == 'needs_review' and not continue_queue:
                try:
                    queued = queue.snapshot(parts[2])['queued_messages']
                except (OSError, ValueError):
                    self._send(500, {'error': 'cannot read message queue'})
                    return True
                if queued:
                    self._send(409, {'error': 'review the previous result and explicitly continue queued messages'})
                    return True
            saved_remote = session.get('remote_connection')
            if saved_remote is not None:
                if (not isinstance(saved_remote, dict) or not isinstance(saved_remote.get('id'), str)
                        or not isinstance(saved_remote.get('digest'), str)):
                    self._send(409, {'error': 'saved remote session selection is invalid; start a new session'})
                    return True
                if remote_choice != saved_remote['id']:
                    self._send(409, {'error': 'select the same remote connection bound to this session'})
                    return True
                try:
                    _remote_connection(ctx, saved_remote['id'], saved_remote['digest'])
                except ValueError as exc:
                    self._send(409, {'error': str(exc)})
                    return True
            elif remote_choice is not None:
                self._send(409, {'error': 'prepare this turn with the selected remote connection before running'})
                return True
            selection = session.get('model_selection') or {}
            pid = pid if pid is not None else selection.get('provider_id')
            model = model if model is not None else selection.get('model')
            if not reasoning_effort_explicit:
                reasoning_effort = selection.get('reasoning_effort')
            ctx.setdefault('running_context', {})[parts[2]] = {
                'model_selection': _selection_record({
                    'provider_id': pid, 'model': model,
                    'reasoning_effort': reasoning_effort,
                }),
                'remote_connection': saved_remote,
            }
            ctx['running'].add(parts[2])
        runstage = 'provider.resolve'
        try:
            provider = host.provider_config.resolve(ctx['state_dir'], pid, model,
                                                   reasoning_effort=reasoning_effort,
                                                   **({'runtime_profile': requested_profile} if requested_profile is not None else {}))
            from ..providers.lightweight import profile_for
            if requested_profile is None and (pid != selection.get('provider_id') or model != selection.get('model')):
                requested_profile = getattr(provider, 'runtime_profile', 'standard')
            requested_profile = profile_for(session, provider, requested_profile)
            session['model_selection'] = _selection_record({
                'provider_id': pid, 'model': model,
                'reasoning_effort': reasoning_effort,
            })
        except ValueError as exc:
            with ctx['lock']:
                ctx['running'].discard(parts[2])
                ctx.setdefault('running_context', {}).pop(parts[2], None)
            _log_run_failure(run_trace_id, runstage, 'provider_configuration_error',
                             type(exc).__name__, state_dir=ctx['state_dir'])
            self._send(400, {
                'error': host.provider_config.configuration_error(exc),
                'error_code': 'provider_configuration_error',
                'trace_id': run_trace_id,
            })
            return True
        try:
            runstage = 'session.lease'
            with _queue_run_lease(ctx, queue, session['id']):
                runstage = 'session.reload'
                selection = session.get('model_selection')
                session = ctx['store'].load(parts[2])
                if selection is not None:
                    session['model_selection'] = selection
                current_queue_id = session.get('current_queue_item_id')
                if (continue_queue and current_queue_id is None
                        and not queue.snapshot(parts[2])['queued_messages']):
                    self._send(409, {'error': 'no queued messages to continue'})
                    return True
                runstage = 'queue.resume'
                queue.resume_pending(parts[2], current_queue_id)
                previous_permission_mode = session.get('permission_mode', 'build')
                if previous_permission_mode != permission_mode:
                    history = session.setdefault('permission_mode_history', [])
                    history.append({'from': previous_permission_mode, 'to': permission_mode,
                                    'at': host.datetime.now(host.timezone.utc).isoformat()})
                    if len(history) > 50:
                        del history[:-50]
                session['permission_mode'] = permission_mode
                if browser is not None:
                    session['browser_enabled'] = browser
                runstage = 'session.persist_before_run'
                ctx['store'].save(session)
                runstage = 'gate.initialize'
                gate = host.WebGate(host.Path(session['root']), parts[2], ctx['approvals'], ctx['lock'], mode=mode, disallow=disallowed, session=session, permission_mode=permission_mode, plan_draft=plan_draft)
                gate.allow_real = ctx['allow_real']
                # /model, /effort and the app-server can retarget this run, but
                # only from its next model request: see sessions/model_switch.py.
                from . import model_switch
                provider = model_switch.register(ctx, parts[2], provider, gate)
                if session.get('remote_connection'):
                    from ...tool_registry import REMOTE_LOCAL_TOOL_NAMES
                    gate.disallow_tool_names = REMOTE_LOCAL_TOOL_NAMES
                names = [name for name, flag in (('skills', True), ('mcp', bool(data.get('allow_mcp')) or bool(data.get('allowMcp'))), ('hooks', bool(data.get('allow_hooks')) or bool(data.get('allowHooks'))), ('subagents', bool(data.get('allow_subagents')) or bool(data.get('allowSubagents')))) if flag]
                if session.get('remote_connection'):
                    names = [name for name in names
                             if name not in ('skills', 'hooks', 'mcp', 'subagents')]
                raw_grants = data.get('grant_plugin_capability', data.get('grantPluginCapability'))
                grants = [g for g in raw_grants if isinstance(g, str)] if isinstance(raw_grants, list) else []
                runstage = 'plugin.plan'
                plugin_plan = host.plugin_sdk.plan(ctx['state_dir'], names, grants=grants)
                names = plugin_plan.load
                session['skill_catalog'] = data.get('skill_catalog') is True
                runstage = 'plugin.activate'
                with host.activate(names, ctx['state_dir'], host.Path(session['root']), session) as ext:
                    from ..memory.catalog import load_run_memory
                    runstage = 'memory.load'
                    run_memory = load_run_memory(ctx, session['root'])
                    out = session
                    queue_warning = None
                    current_queue_id = out.get('current_queue_item_id')

                    # A crash after a completed queue turn but before its sidecar
                    # update must not execute the same user turn twice.
                    if (current_queue_id and out.get('status') in ('completed', 'needs_review')
                            and isinstance(out.get('completion'), dict)):
                        queue.update(parts[2], current_queue_id, out['status'], out['completion'])
                        out.pop('current_queue_item_id', None)
                        ctx['store'].save(out)
                        current_queue_id = None

                    # A completed session with pending queue work starts at the
                    # next queued user message; it never asks the model to repeat
                    # the already completed active turn.
                    if current_queue_id is None and (out.get('status') == 'completed'
                            or (out.get('status') == 'needs_review' and continue_queue)):
                        item = queue.claim_next(parts[2])
                        if item is None and continue_queue:
                            self._send(409, {'error': 'no queued messages to continue'})
                            return True
                        if item is not None:
                            if not _queued_context_matches(ctx, out, item):
                                queue.update(parts[2], item['id'], 'paused')
                                queue.pause_pending(parts[2], 'Prepared model or remote selection changed; prepare this turn again.')
                                queue_warning = 'queued turn context no longer matches the active session selection'
                            else:
                                out = _append_queued_turn(ctx, queue, out, item)
                                gate.session = out
                                current_queue_id = item['id']

                    from .queue import MAX_PENDING_ITEMS
                    drained = 0
                    while queue_warning is None:
                        runstage = 'approved.replay'
                        host.replay_approved(out, ctx['store'], gate, ctx['approvals'], ctx['lock'],
                                             mcp_call=ext.kwargs.get('mcp_call'))
                        runstage = 'core.run'
                        out = host.run(
                            out, ctx['store'], provider, gate, steps, max_chars,
                            memory=run_memory, max_tokens=max_tokens,
                            skills=ext.kwargs.get('skills'), skill_reader=ext.kwargs.get('skill_reader'),
                            hooks=ext.kwargs.get('hooks'), mcp_tools=ext.kwargs.get('mcp_tools'),
                            mcp_call=ext.kwargs.get('mcp_call'), subagents=ext.kwargs.get('subagents'),
                            registry=ctx['task_registry'],
                            should_stop=lambda sid=parts[2]: sid in ctx['stop_requested'],
                            max_wall_seconds=max_wall_seconds, runtime_profile=requested_profile)
                        gate.session = out
                        current_queue_id = out.get('current_queue_item_id')
                        if current_queue_id and out.get('status') in ('completed', 'needs_review'):
                            queue.update(parts[2], current_queue_id, out['status'], out.get('completion'))
                            out.pop('current_queue_item_id', None)
                            ctx['store'].save(out)
                            current_queue_id = None
                        if out.get('status') != 'completed':
                            reason = out.get('pause_reason') or out.get('status') or 'run paused'
                            queue.pause_pending(parts[2], str(reason))
                            break

                        # Finish the current run at approval/question/stop and
                        # plugin-disable boundaries. The queue is resumed only by
                        # a later explicit /run request.
                        if (host.pending_denials(out) or out.get('pending_question')
                                or parts[2] in ctx.get('stop_requested', set())
                                or not host.plugin_runtime.is_enabled(ctx['state_dir'], 'sessions')):
                            queue.pause_pending(parts[2], 'Waiting for user action or sessions plugin availability.')
                            break
                        if drained >= MAX_PENDING_ITEMS:
                            queue.pause_pending(parts[2], 'Run limit reached; continue to process remaining queued messages.')
                            break
                        if not queue.close_if_empty(parts[2]):
                            break
                        item = queue.claim_next(parts[2])
                        if item is None:
                            # A concurrent cancel may have removed the last item
                            # after close_if_empty saw it; repeat the atomic close.
                            if not queue.close_if_empty(parts[2]):
                                break
                            continue
                        if not _queued_context_matches(ctx, out, item):
                            queue.update(parts[2], item['id'], 'paused')
                            queue.pause_pending(parts[2], 'Prepared model or remote selection changed; prepare this turn again.')
                            queue_warning = 'queued turn context no longer matches the active session selection'
                            break
                        out = _append_queued_turn(ctx, queue, out, item)
                        gate.session = out
                        current_queue_id = item['id']
                        drained += 1
        except BlockingIOError:
            self._send(409, {'error': 'session is in use by another process'})
            return True
        except _GoalRefusal as exc:
            # A queued turn whose goal planning refused must not read as the
            # workspace mismatch that the generic ValueError branch reports.
            self._send(exc.status, exc.body)
            return True
        except ValueError as exc:
            # Request/configuration ValueErrors were validated above. A value
            # failure from the execution path is an internal run failure, not
            # a provider request failure or a workspace input error.
            store_stage = getattr(exc, '_xueness_store_stage', None)
            error_code = 'session_persistence_failed' if store_stage else 'run_failed'
            _log_run_failure(run_trace_id, runstage, error_code, type(exc).__name__,
                             store_stage=store_stage, state_dir=ctx['state_dir'])
            message = ('Session state could not be saved locally'
                       if store_stage else 'Run failed')
            self._send(500, {
                'error': f'{message} (reference {run_trace_id})',
                'error_code': error_code, 'trace_id': run_trace_id,
            })
            return True
        except ProviderCallbackError as exc:
            _log_run_failure(exc.trace_id, runstage, 'local_stream_callback_failed',
                             exc.exception_type, state_dir=ctx['state_dir'])
            self._send(500, {
                'error': f'Local stream callback failed (reference {exc.trace_id})',
                'error_code': 'local_stream_callback_failed',
                'trace_id': exc.trace_id,
            })
            return True
        except ProviderRequestError as exc:
            status, payload = _provider_failure_response(exc, run_trace_id)
            _log_run_failure(exc.trace_id or run_trace_id, runstage,
                             payload['error_code'], exc.exception_type or type(exc).__name__,
                             exc.status, state_dir=ctx['state_dir'])
            self._send(status, payload)
            return True
        except Exception as exc:
            store_stage = getattr(exc, '_xueness_store_stage', None)
            error_code = ('session_persistence_failed' if store_stage else
                          'local_io_failure' if isinstance(exc, OSError) else 'run_failed')
            _log_run_failure(run_trace_id, runstage, error_code, type(exc).__name__,
                             store_stage=store_stage, state_dir=ctx['state_dir'])
            message = ('Session state could not be saved locally'
                       if store_stage else
                       'A local file operation failed' if isinstance(exc, OSError) else
                       'Run failed')
            self._send(500, {
                'error': f'{message} (reference {run_trace_id})',
                'error_code': error_code, 'trace_id': run_trace_id,
            })
            return True
        finally:
            from . import model_switch
            model_switch.unregister(ctx, parts[2])
            with ctx['lock']:
                ctx['running'].discard(parts[2])
                ctx['stop_requested'].discard(parts[2])
                ctx.setdefault('running_context', {}).pop(parts[2], None)
        self._send(200, {'id': out['id'], 'status': out['status'], 'steps': out['steps'], 'mode': out.get('mode', mode), 'completion': out['completion'], 'pending': host.pending_denials(out), 'pending_question': out.get('pending_question'), 'todos': out.get('todos', []), 'hook_log': out.get('hook_log', []), 'plugin_refused': plugin_plan.refused, 'tasks': host.task_registry.mirror(ctx['task_registry'], out['id'])})
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'stop') and host._valid_sid(parts[2]):
        try:
            session = ctx['store'].load(parts[2])
        except (OSError, ValueError):
            self._send(404, {'error': 'session not found'})
            return True
        with ctx['lock']:
            busy = parts[2] in ctx['running']
            if busy:
                ctx['stop_requested'].add(parts[2])
        cancelled_tasks = []
        for task in ctx['task_registry'].list(parts[2]):
            if task.get('status') == 'running' and ctx['task_registry'].cancel(task['id']):
                cancelled_tasks.append(task['id'])
        self._send(200, {'id': parts[2], 'stopping': busy, 'status': session.get('status'), 'cancelled_tasks': cancelled_tasks})
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'answer') and host._valid_sid(parts[2]):
        try:
            session = ctx['store'].load(parts[2])
        except (OSError, ValueError):
            self._send(404, {'error': 'session not found'})
            return True
        text = data.get('answer', data.get('text', ''))
        try:
            with host.lease(ctx['store'], parts[2]):
                out = host.answer_session(ctx['store'].load(parts[2]), ctx['store'], text)
        except BlockingIOError:
            self._send(409, {'error': 'session is in use by another process'})
            return True
        except LookupError:
            self._send(409, {'error': 'session is not awaiting a user answer'})
            return True
        except ValueError:
            self._send(400, {'error': 'answer must be 1..5000 characters'})
            return True
        self._send(200, {'id': out['id'], 'status': out['status'], 'pending_question': out.get('pending_question')})
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'approvals') and host._valid_sid(parts[2]):
        try:
            with host.lease(ctx['store'], parts[2]):
                kind = data.get('kind', '')
                try:
                    session = ctx['store'].load(parts[2])
                except (OSError, ValueError):
                    self._send(404, {'error': 'session not found'})
                    return True
                root = host.Path(session['root']).resolve()
                call_id = data.get('tool_call_id')
                generic = next((p for p in host.pending_denials(session) if p.get('kind') == kind and p['tool_call_id'] == call_id), None)
                if generic:
                    owner = host.plugin_runtime.tool_owner(generic['name'])
                    if owner and (not host.plugin_runtime.is_enabled(ctx['state_dir'], owner)):
                        self._send(403, {'error': 'tool plugin disabled', 'plugin': owner})
                        return True
                    with ctx['lock']:
                        ctx['approvals'].setdefault(parts[2], {}).setdefault(kind, {})[call_id] = generic['subject']
                        host.record_approval(session, 'granted', kind, call_id, generic['subject'])
                        host._save_audit(ctx, session)
                    self._send(200, {'approved': {'kind': kind, 'tool_call_id': call_id, 'subject': generic['subject']}})
                    return True
                owner = host.plugin_runtime.tool_owner(kind)
                if owner and (not host.plugin_runtime.is_enabled(ctx['state_dir'], owner)):
                    self._send(403, {'error': 'tool plugin disabled', 'plugin': owner})
                    return True
                if kind in ('write', 'edit'):
                    subject = data.get('subject', '')
                    if not isinstance(subject, str) or not subject.strip() or len(subject) > 1024:
                        self._send(400, {'error': 'subject must be a relative workspace path'})
                        return True
                    try:
                        host.path_in(root, subject.strip())
                    except PermissionError:
                        self._send(400, {'error': 'path outside workspace'})
                        return True
                    pending = {p['tool_call_id']: p for p in host.pending_denials(session) if p['name'] == kind and p['subject'] == subject.strip()}
                    call_id = data.get('tool_call_id')
                    if not isinstance(call_id, str) or call_id not in pending:
                        self._send(400, {'error': 'approval must reference an exact pending denied tool_call_id'})
                        return True
                    with ctx['lock']:
                        ctx['approvals'].setdefault(parts[2], {'write': {}, 'edit': {}, 'exec': {}, 'mcp': {}}).setdefault(kind, {})[call_id] = subject.strip()
                        host.record_approval(session, 'granted', kind, call_id, subject.strip())
                        host._save_audit(ctx, session)
                    self._send(200, {'approved': {'kind': kind, 'tool_call_id': call_id, 'subject': subject.strip()}})
                    return True
                if kind == 'exec':
                    argv = data.get('argv', data.get('subject'))
                    if not isinstance(argv, list) or not argv or len(argv) > 32 or any((not isinstance(x, str) or not x or len(x) > 1024 for x in argv)):
                        self._send(400, {'error': 'argv must be a nonempty array of strings'})
                        return True
                    canonical = host.json.dumps(argv, ensure_ascii=False, separators=(',', ':'))
                    pending = {p['tool_call_id'] for p in host.pending_denials(session) if p['name'] == 'exec' and p['subject'] == canonical}
                    call_id = data.get('tool_call_id')
                    if not isinstance(call_id, str) or call_id not in pending:
                        self._send(400, {'error': 'approval must reference an exact pending denied tool_call_id'})
                        return True
                    with ctx['lock']:
                        ctx['approvals'].setdefault(parts[2], {'write': {}, 'edit': {}, 'exec': {}, 'mcp': {}}).setdefault('exec', {})[call_id] = canonical
                        host.record_approval(session, 'granted', 'exec', call_id, canonical)
                        host._save_audit(ctx, session)
                    self._send(200, {'approved': {'kind': 'exec', 'tool_call_id': call_id, 'argv': argv}})
                    return True
                if kind == 'mcp':
                    pending = {p['tool_call_id']: p for p in host.pending_denials(session) if p['name'].startswith('mcp__')}
                    call_id = data.get('tool_call_id')
                    if not isinstance(call_id, str) or call_id not in pending:
                        self._send(400, {'error': 'approval must reference an exact pending denied tool_call_id'})
                        return True
                    subject = pending[call_id]['subject']
                    with ctx['lock']:
                        ctx['approvals'].setdefault(parts[2], {'write': {}, 'edit': {}, 'exec': {}, 'mcp': {}}).setdefault('mcp', {})[call_id] = subject
                        host.record_approval(session, 'granted', 'mcp', call_id, subject)
                        host._save_audit(ctx, session)
                    self._send(200, {'approved': {'kind': 'mcp', 'tool_call_id': call_id, 'subject': subject}})
                    return True
                self._send(400, {'error': "kind must be 'write', 'edit', 'exec' or 'mcp'"})
                return True
        except BlockingIOError:
            self._send(409, {'error': 'session is in use by another process'})
            return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'pin') and host._valid_sid(parts[2]):
        pinned = data.get('pinned')
        if not isinstance(pinned, bool):
            self._send(400, {'error': 'pinned must be a boolean'})
            return True
        sid = parts[2]
        with ctx['lock']:
            if sid in ctx['running']:
                self._send(409, {'error': 'session run already in progress'})
                return True
            try:
                with host.lease(ctx['store'], sid):
                    session = host.session_management.pin(ctx['store'], sid, pinned)
            except FileNotFoundError:
                self._send(404, {'error': 'session not found'})
                return True
            except ValueError as exc:
                self._send(400, {'error': str(exc)})
                return True
            except BlockingIOError:
                self._send(409, {'error': 'session is in use by another process'})
                return True
            except OSError:
                self._send(500, {'error': 'cannot pin session'})
                return True
        self._send(200, {'ok': True, 'pinned': session['pinned']})
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'restore') and host._valid_sid(parts[2]):
        sid = parts[2]
        with ctx['lock']:
            if sid in ctx['running']:
                self._send(409, {'error': 'session run already in progress'})
                return True
            try:
                with host.lease(ctx['store'], sid):
                    host.session_management.restore(ctx['store'], sid)
            except ValueError as exc:
                self._send(400, {'error': str(exc)})
                return True
            except BlockingIOError:
                self._send(409, {'error': 'session is in use by another process'})
                return True
            except OSError:
                self._send(500, {'error': 'cannot restore session'})
                return True
        self._send(200, {'ok': True, 'id': sid})
        return True
    return False

def handle_DELETE(self, parts, path, data):
    parts = path.split("/")
    ctx = self._ctx
    if len(parts) == 4 and parts[:3] == ['', 'api', 'sessions'] and host._valid_sid(parts[3]):
        ctx = self._ctx
        sid = parts[3]
        with ctx['lock']:
            if sid in ctx['running']:
                self._send(409, {'error': 'session run already in progress'})
                return True
            try:
                with host.lease(ctx['store'], sid):
                    host.session_management.archive(ctx['store'], sid)
            except FileNotFoundError:
                self._send(404, {'error': 'session not found'})
                return True
            except BlockingIOError:
                self._send(409, {'error': 'session is in use by another process'})
                return True
            except (OSError, ValueError):
                self._send(500, {'error': 'cannot delete session'})
                return True
            ctx['approvals'].pop(sid, None)
            ctx['stop_requested'].discard(sid)
        self._send(200, {'id': sid, 'deleted': True})
        return True
    return False

def handle_PATCH(self, parts, path, data):
    parts = path.split("/")
    ctx = self._ctx
    if len(parts) == 4 and parts[:3] == ['', 'api', 'sessions'] and host._valid_sid(parts[3]):
        if set(data) != {'title'}:
            self._send(400, {'error': 'expected title only'})
            return True
        try:
            title = host.session_management.validate_title(data['title'])
        except ValueError as exc:
            self._send(400, {'error': str(exc)})
            return True
        ctx = self._ctx
        sid = parts[3]
        with ctx['lock']:
            if sid in ctx['running']:
                self._send(409, {'error': 'session run already in progress'})
                return True
            try:
                with host.lease(ctx['store'], sid):
                    session = host.session_management.rename(ctx['store'], sid, title)
            except FileNotFoundError:
                self._send(404, {'error': 'session not found'})
                return True
            except BlockingIOError:
                self._send(409, {'error': 'session is in use by another process'})
                return True
            except (OSError, ValueError):
                self._send(500, {'error': 'cannot rename session'})
                return True
        self._send(200, {'id': sid, 'title': session.get('title') or session['task']})
        return True
    return False

def dispatch(method, parts, query, data, ctx):
    handler = ctx.get('handler')
    route = globals().get('handle_' + method)
    if handler is None or route is None:
        return None
    from urllib.parse import urlparse
    if route(handler, parts, urlparse(handler.path).path, data):
        return host.HANDLED_RESPONSE
    return None
