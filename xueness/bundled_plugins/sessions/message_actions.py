"""Revision-bound message edits and local assistant feedback.

Editing replaces a user turn and discards its later transcript. Workspace
effects are never rewound implicitly. The journal remains the authoritative
source; callbacks cannot identify messages by a changing display sequence.
"""
from contextlib import contextmanager
import copy
import hashlib
import json
import re

from ...session_lease import lease
from .forking import ForkError, _read_snapshot, _has_pending_approvals
from .queue import MessageQueue


def revision(session):
    return 'sha256:' + hashlib.sha256(json.dumps(
        session, sort_keys=True, ensure_ascii=True, separators=(',', ':')
    ).encode('ascii')).hexdigest()


@contextmanager
def _locked_journal(ctx, sid):
    # Same ordering as archive and queue recovery: context, lease, queue.
    with ctx['lock']:
        if sid in ctx.get('running', ()):
            raise ForkError('session run already in progress', 409)
        try:
            with lease(ctx['store'], sid):
                session, _ = _read_snapshot(ctx['store'], sid)
                stream = session.get('streaming')
                if stream is not None and not isinstance(stream, dict):
                    raise ForkError('saved streaming state is invalid', 409)
                if session.get('status') == 'running' or (stream or {}).get('status') == 'streaming':
                    raise ForkError('session run already in progress', 409)
                queue = MessageQueue(ctx['store'])
                with queue.session_lock(sid):
                    yield session, queue._snapshot_locked(sid)
        except BlockingIOError:
            raise ForkError('session is in use by another process', 409) from None


def update(ctx, sid, data):
    if (not isinstance(data, dict) or not {'revision', 'messageIndex', 'action'} <= set(data)
            or set(data) - {'revision', 'messageIndex', 'action', 'text', 'feedback'}):
        raise ForkError('invalid message action')
    expected = data['revision']
    index = data['messageIndex']
    action = data['action']
    if not isinstance(expected, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', expected):
        raise ForkError('invalid message revision')
    if type(index) is not int or index < 0 or action not in ('edit', 'feedback'):
        raise ForkError('invalid message target')
    if action == 'edit':
        text = data.get('text')
        if ('feedback' in data or not isinstance(text, str) or not text.strip()
                or len(text) > 50_000 or '\x00' in text):
            raise ForkError('invalid edited message')
    elif 'text' in data or data.get('feedback') not in (None, 'like', 'dislike') or 'feedback' not in data:
        raise ForkError('invalid message feedback')
    with _locked_journal(ctx, sid) as (session, queue):
        if revision(session) != expected:
            raise ForkError('conversation changed; refresh before editing this message', 409)
        messages = session['messages']
        if index >= len(messages) or not isinstance(messages[index], dict):
            raise ForkError('message not found', 404)
        message = messages[index]
        role = 'user' if action == 'edit' else 'assistant'
        if message.get('role') != role:
            raise ForkError('message role does not support this action')
        if action == 'feedback':
            if not message.get('content'):
                raise ForkError('message has no answer to rate')
            annotations = session.setdefault('message_annotations', {})
            if not isinstance(annotations, dict):
                raise ForkError('invalid saved feedback', 409)
            annotation = annotations.setdefault(str(index), {})
            if not isinstance(annotation, dict):
                raise ForkError('invalid saved message annotation', 409)
            if data['feedback'] is None:
                annotation.pop('feedback', None)
            else:
                annotation['feedback'] = data['feedback']
        else:
            if queue['queued_messages']:
                raise ForkError('cancel queued messages before editing history', 409)
            if (any(not isinstance(session.get(key, []), list) for key in ('reasoning_history', 'completion_history'))
                    or not isinstance(session.get('message_annotations', {}), dict)):
                raise ForkError('saved conversation metadata is invalid', 409)
            prefix = messages[:index]
            if any(not isinstance(item, dict) or not isinstance(item.get('tool_calls', []), list) for item in prefix):
                raise ForkError('earlier history is malformed', 409)
            if _has_pending_approvals(prefix, session.get('results') or {}):
                raise ForkError('earlier history has unresolved tool approvals', 409)
            turn = 1 + sum(1 for item in prefix if item.get('role') == 'user')
            if turn == 1 and len(text) > 5000:
                raise ForkError('initial task exceeds 5000 characters')
            edited = copy.deepcopy(message)
            if isinstance(message.get('content'), list):
                # Preserve images and other attachment parts on text-only edits.
                edited['content'] = [{'type': 'text', 'text': text}] + [
                    part for part in edited['content'] if not isinstance(part, dict) or part.get('type') != 'text']
            else:
                edited['content'] = text
            session['messages'] = prefix + [edited]
            if turn == 1:
                session['task'] = text
            calls = {call.get('id') for item in prefix for call in item.get('tool_calls', []) if isinstance(call, dict)}
            session['results'] = {key: value for key, value in (session.get('results') or {}).items() if key in calls}
            session['reasoning_history'] = [item for item in session.get('reasoning_history', [])
                if isinstance(item, dict) and type(item.get('message_index')) is int and item['message_index'] < index]
            session['message_annotations'] = {key: value for key, value in (session.get('message_annotations') or {}).items()
                if isinstance(key, str) and key.isdecimal() and int(key) < index}
            session['completion_history'] = [item for item in session.get('completion_history', [])
                if isinstance(item, dict) and re.fullmatch(r'turn-[1-9][0-9]*', str(item.get('turn_id', '')))
                and int(item['turn_id'][5:]) < turn]
            session.update(status='pending', steps=0, completion=None, todos=[], pending_question=None,
                pause_code=None, pause_reason=None, streaming=None, runtime_activity=None, runtime_activity_history=[])
            for key in ('current_queue_item_id', 'runtime_budget'):
                session.pop(key, None)
            ctx.get('approvals', {}).pop(sid, None)
        ctx['store'].save(session)
        return {'id': sid, 'messageIndex': index, 'revision': revision(session), 'action': action}


def dispatch(method, parts, query, data, ctx):
    if method != 'PATCH' or len(parts) != 4 or parts[:2] != ['api', 'sessions'] or parts[3] != 'message-actions':
        return None
    try:
        ctx['store']._path(parts[2])
        return 200, update(ctx, parts[2], data)
    except ForkError as exc:
        return exc.status, {'error': str(exc), 'error_code': 'message_action_conflict' if exc.status == 409 else 'invalid_message_action'}
    except (OSError, ValueError):
        return 500, {'error': 'cannot update conversation message'}
