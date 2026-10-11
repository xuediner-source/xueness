"""Parent-scoped HTTP views and explicit child resume/steering actions."""
from __future__ import annotations

from pathlib import Path
import re
import uuid

from .child_sessions import ChildStore, projection, valid_parent

_TASK = re.compile(r'task-[A-Za-z0-9_-]{1,160}')
_REQUEST = re.compile(r'[A-Za-z0-9._:-]{1,160}')


def _session(ctx, session_id):
    """Load only sessions whose root is still visible to this HTTP host."""
    if not valid_parent(session_id):
        raise ValueError('invalid session id')
    session = ctx['store'].load(session_id)
    from ...web import _allowed_root
    from ..settings.workspaces_api import allowed_roots
    root = _allowed_root(Path(session['root']), Path(ctx['web_runs']),
                         Path(ctx['project_dir']), allowed_roots(ctx))
    return session, root


def _task_rows(session, root, ctx):
    parent_id = session['id']
    raw_runs = session.get('task_runs')
    runs = raw_runs if isinstance(raw_runs, list) else []
    registry = ctx['task_registry']
    live = registry.list(parent_id)
    by_id = {row['id']: dict(row) for row in runs
             if isinstance(row, dict) and isinstance(row.get('id'), str)}
    by_id.update({row['id']: dict(row) for row in live
                  if isinstance(row, dict) and isinstance(row.get('id'), str)})

    children = ChildStore(ctx['state_dir'], parent_id, root=root).children()
    child_by_task = {}
    for child in children:
        task_id = child['delegation']['taskId']
        child_by_task[task_id] = child
        durable = projection(child)
        current = registry.get(task_id)
        if current is None:
            record = dict(by_id.get(task_id) or {})
            record.update(durable)
            registry.restore(task_id, parent_session=parent_id, root=root, record=record)
            current = registry.get(task_id) or record
        elif task_id not in by_id:
            by_id[task_id] = current
        # The child journal is authoritative for recovery safety. Keep worker
        # activity and other live-only fields from the service projection.
        current = dict(current)
        current.update({key: durable[key] for key in (
            'childSessionId', 'parentSessionId', 'rootSessionId', 'childStatus',
            'canResume', 'recoveryReason', 'summary', 'error', 'steps',
            'startedAt', 'endedAt') if key in durable})
        current['root'] = str(root)
        by_id[task_id] = current

    parent = registry.parent_for(parent_id)
    can_resume_now = bool(parent is not None and parent.can_resume_now())
    for task_id, row in by_id.items():
        row['canResumeNow'] = can_resume_now and row.get('canResume') is True
        row['canGuide'] = bool(row.get('status') == 'running'
                               and row.get('workerActive') is True
                               and can_resume_now
                               and task_id in child_by_task)
        row.pop('lastResumeRequestId', None)
        row.pop('lastResumeRequestDigest', None)
    rows = list(by_id.values())
    rows.sort(key=lambda row: (row.get('startedAt') or 0, row.get('id') or ''))
    return rows[-100:]


def _resume(method, parts, data, ctx, session, root):
    if method != 'POST':
        return 405, {'error': 'method not allowed'}
    if not isinstance(data, dict) or set(data) - {'message', 'requestId'}:
        return 400, {'error': 'request body must contain only message and requestId'}
    task_id = parts[4]
    if not _TASK.fullmatch(task_id):
        return 404, {'error': 'subtask not found'}
    message = data.get('message')
    if message is not None and (not isinstance(message, str) or not message.strip()
                                or len(message) > 24000):
        return 400, {'error': 'message must contain 1..24000 characters'}
    request_id = data.get('requestId') or uuid.uuid4().hex
    if not isinstance(request_id, str) or not _REQUEST.fullmatch(request_id):
        return 400, {'error': 'requestId must contain 1..160 safe characters'}
    registry = ctx['task_registry']
    coordinator = registry.parent_for(session['id'])
    if (coordinator is None or coordinator.session.get('id') != session['id']
            or not coordinator.can_resume_now()):
        return 409, {'error': 'start a parent turn before resuming this child'}
    try:
        ChildStore(ctx['state_dir'], session['id'], task_id=task_id, root=root).find_task(task_id)
    except (OSError, TypeError, ValueError):
        return 404, {'error': 'subtask not found'}

    from ...tool_contract import authorize_tool_effect
    policy_session = coordinator.session
    denial = authorize_tool_effect(ctx['state_dir'], policy_session, ctx['store'],
                                   'task_resume', 'planning', task_id, request_id)
    if denial is not None:
        status = 403 if denial.get('error_code') != 'approval_required' else 409
        return status, denial
    from ...plugin_runtime import after_tool_authorization
    after_tool_authorization(ctx['state_dir'], policy_session, ctx['store'],
                             'task_resume', 'planning', task_id, request_id)
    result = coordinator.resume(request_id, {'task_id': task_id, 'message': message})
    if result.get('ok') is not True:
        return 409, {'error': result.get('error') or 'child could not be resumed'}
    return 202, {key: result[key] for key in
                 ('task_id', 'childSessionId', 'status', 'background', 'evidence_eligible')
                 if key in result}


def _message(method, parts, data, ctx, session, root):
    if method != 'POST':
        return 405, {'error': 'method not allowed'}
    if not isinstance(data, dict) or set(data) - {'message', 'requestId'}:
        return 400, {'error': 'request body must contain only message and requestId'}
    task_id = parts[4]
    if not _TASK.fullmatch(task_id):
        return 404, {'error': 'subtask not found'}
    request_id, message = data.get('requestId'), data.get('message')
    if not isinstance(request_id, str) or not _REQUEST.fullmatch(request_id):
        return 400, {'error': 'requestId must contain 1..160 safe characters'}
    if not isinstance(message, str) or not message.strip() or len(message) > 24000:
        return 400, {'error': 'message must contain 1..24000 characters'}
    registry = ctx['task_registry']
    task = registry.get(task_id)
    if (not isinstance(task, dict) or task.get('parent') != session['id']
            or task.get('status') != 'running' or task.get('workerActive') is not True):
        return 409, {'error': 'messages require this parent’s active child'}
    try:
        store = ChildStore(ctx['state_dir'], session['id'], task_id=task_id, root=root)
        child = store.find_task(task_id)
    except (OSError, TypeError, ValueError):
        return 409, {'error': 'child could not accept this message'}
    coordinator = registry.parent_for(session['id'])
    if (coordinator is None or coordinator.session.get('id') != session['id']
            or not coordinator.can_resume_now()):
        return 409, {'error': 'messages require this parent’s active child'}
    policy_session = coordinator.session
    from ...tool_contract import authorize_tool_effect
    denial = authorize_tool_effect(ctx['state_dir'], policy_session, ctx['store'],
                                   'task_send_message', 'planning', task_id, request_id)
    if denial is not None:
        status = 403 if denial.get('error_code') != 'approval_required' else 409
        return status, denial
    from ...plugin_runtime import after_tool_authorization
    after_tool_authorization(ctx['state_dir'], policy_session, ctx['store'],
                             'task_send_message', 'planning', task_id, request_id)
    result = coordinator.send_message({'task_id': task_id, 'message': message}, request_id=request_id)
    if result.get('ok') is not True:
        return 409, {'error': result.get('error') or 'child could not accept this message'}
    return 202, {'task_id': task_id, 'childSessionId': child['id'],
                 'receipt': result['receipt'], 'delivery': result['delivery']}


def _transcript(method, parts, data, ctx, session, root):
    """Read a bounded, event-only child conversation for its parent UI."""
    if method != 'GET':
        return 405, {'error': 'method not allowed'}
    if data:
        return 400, {'error': 'request body must be empty'}
    task_id = parts[4]
    if not _TASK.fullmatch(task_id):
        return 404, {'error': 'subtask not found'}
    try:
        child = ChildStore(ctx['state_dir'], session['id'], task_id=task_id,
                           root=root).find_task(task_id)
    except (FileNotFoundError, OSError, TypeError, ValueError):
        return 404, {'error': 'subtask not found'}

    from ... import events
    timeline = events.derive_events(child)
    messages = [row for row in child.get('messages') or [] if isinstance(row, dict)]

    def visible_text(value):
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return '\n'.join(item['text'] for item in value
                             if isinstance(item, dict) and item.get('type') == 'text'
                             and isinstance(item.get('text'), str))
        return ''

    first_user_seen = False
    user_texts, assistant_texts = [], []
    for message in messages:
        role = message.get('role')
        if role == 'user':
            if not first_user_seen:
                first_user_seen = True
            elif message.get('_input_kind') != 'guide':
                user_texts.append(visible_text(message.get('content', '')))
        elif role == 'assistant' and message.get('content'):
            # Do not expose hidden reasoning, tool arguments, provider metadata,
            # or raw tool results. Only the same visible assistant text shown
            # in the parent conversation is included here.
            assistant_texts.append(visible_text(message.get('content', '')))

    user_index = assistant_index = 0
    for event in timeline:
        if event.get('type') == 'turn.user' and user_index < len(user_texts):
            event['preview'] = user_texts[user_index]
            user_index += 1
        elif event.get('type') == 'assistant.text' and assistant_index < len(assistant_texts):
            event['preview'] = assistant_texts[assistant_index]
            assistant_index += 1
    head = events.head_seq(timeline)
    # This intentionally is a complete read-only projection. ChildStore caps
    # the journal at 2,000 messages and 8 MiB; visible text is included, while
    # system prompts, hidden reasoning, provider metadata and raw tool outputs
    # are omitted.
    envelope = {
        'schema': 'xueness.events.v1', 'protocolVersion': 1,
        'sessionId': child['id'], 'status': str(child.get('status') or ''),
        'steps': child.get('steps', 0) if type(child.get('steps')) is int else 0,
        'mode': str(child.get('mode') or 'plan'), 'events': timeline,
        'cursor': 0, 'nextCursor': head, 'head': head, 'hasMore': False,
    }
    initial_prompt = ''
    for message in child.get('messages') or []:
        if not isinstance(message, dict) or message.get('role') != 'user':
            continue
        initial_prompt = visible_text(message.get('content', ''))
        break
    return 200, {'childSessionId': child['id'], 'status': envelope['status'],
                 'initialPrompt': initial_prompt, 'timeline': envelope}


def handle(method, parts, data, ctx):
    """Own GET task listing plus explicit resume and in-run steering actions."""
    if (len(parts) < 4 or parts[:2] != ['api', 'sessions']
            or parts[3] != 'tasks'):
        return None
    if len(parts) not in (4, 6):
        return None
    if len(parts) == 6 and parts[5] not in ('resume', 'message', 'messages', 'transcript'):
        # Sibling actions on the tasks sub-resource (cancel_one) own their flag
        # and state checks; resolving the session here would preempt the
        # disabled answer and turn id validation into the wrong status code.
        return None
    try:
        session, root = _session(ctx, parts[2])
    except FileNotFoundError:
        return 404, {'error': 'session not found'}
    except (OSError, KeyError, TypeError, ValueError, RuntimeError):
        return 403, {'error': 'workspace root not permitted'}

    if len(parts) == 4:
        if method != 'GET':
            return 405, {'error': 'method not allowed'}
        if data:
            return 400, {'error': 'request body must be empty'}
        try:
            return 200, {'tasks': _task_rows(session, root, ctx)}
        except (OSError, TypeError, ValueError):
            return 200, {'tasks': []}

    action = parts[5]
    if action == 'resume':
        return _resume(method, parts, data, ctx, session, root)
    if action in ('message', 'messages'):
        return _message(method, parts, data, ctx, session, root)
    if action == 'transcript':
        return _transcript(method, parts, data, ctx, session, root)
    return None
