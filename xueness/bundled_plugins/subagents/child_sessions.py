"""Durable, parent-scoped child conversations and safe-boundary inboxes.

Children keep the same read-only execution ceiling as delegation. Persistence
does not grant execution: recovery is explicit, leased and refuses a transcript
with an unfinished tool exchange. The child journal is authoritative; the
parent's task list remains a bounded progress projection.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import time
import uuid

MAX_CHILD_BYTES = 8 * 1024 * 1024
MAX_CHILD_MESSAGES = 2000
MAX_CHILD_SESSIONS = 100
MAX_INBOX_ITEMS = 40
MAX_MESSAGE_CHARS = 24000
_SID = re.compile(r'[0-9a-f]{32}')
_TASK = re.compile(r'task-[A-Za-z0-9_-]{1,160}')


def valid_parent(parent):
    return isinstance(parent, str) and _SID.fullmatch(parent) is not None


def _directory(state_dir, parent):
    from ...resources import _is_link
    if not valid_parent(parent):
        raise ValueError('invalid parent session id')
    base = Path(state_dir)
    if _is_link(base):
        raise ValueError('invalid child session directory')
    base = base.resolve()
    current = base
    for name in ('subagent-sessions', parent):
        current = current / name
        if _is_link(current):
            raise ValueError('invalid child session directory')
        current.mkdir(exist_ok=True, mode=0o700)
    return current


class ChildStore:
    """Reuse the kernel's atomic journal and event durability in a separate jail."""

    def __init__(self, state_dir, parent, *, task_id=None, root=None):
        from ...core import Store
        self.parent = parent
        self.task_id = task_id
        self.root = str(Path(root).resolve()) if root is not None else None
        self._store = Store(_directory(state_dir, parent))
        self.directory = self._store.directory

    def __getattr__(self, name):
        return getattr(self._store, name)

    def validate(self, child):
        if not isinstance(child, dict) or not _SID.fullmatch(str(child.get('id') or '')):
            raise ValueError('invalid child session id')
        lineage = child.get('delegation')
        if not isinstance(lineage, dict) or lineage.get('parentSessionId') != self.parent:
            raise ValueError('child does not belong to parent session')
        if not _TASK.fullmatch(str(lineage.get('taskId') or '')):
            raise ValueError('invalid child task id')
        if self.task_id is not None and lineage.get('taskId') != self.task_id:
            raise ValueError('child does not belong to task')
        root = str(Path(child.get('root') or '').resolve())
        if self.root is not None and root != self.root:
            raise ValueError('child workspace does not match parent')
        if child.get('read_only') is not True or child.get('permission_mode') != 'plan':
            raise ValueError('invalid child permission ceiling')
        messages = child.get('messages')
        if not isinstance(messages, list) or len(messages) > MAX_CHILD_MESSAGES:
            raise ValueError('child transcript limit reached')
        if len(json.dumps(child, ensure_ascii=False).encode('utf-8')) > MAX_CHILD_BYTES:
            raise ValueError('child transcript size limit reached')
        return child

    def load(self, sid):
        path = self._store._path(sid)
        if path.stat().st_size > MAX_CHILD_BYTES:
            raise ValueError('child transcript size limit reached')
        return self.validate(self._store.load(sid))

    def save(self, child):
        self.validate(child)
        path = self._store._path(child['id'])
        if not path.exists() and sum(1 for _ in self.directory.glob('*.json')) >= MAX_CHILD_SESSIONS:
            raise ValueError('child session limit reached for parent')
        self._store.save(child)

    def find_task(self, task_id):
        if not isinstance(task_id, str) or not _TASK.fullmatch(task_id):
            raise ValueError('invalid task id')
        paths = sorted(self.directory.glob('*.json'))
        if len(paths) > MAX_CHILD_SESSIONS:
            raise ValueError('child session limit reached for parent')
        for path in paths:
            if not _SID.fullmatch(path.stem):
                continue
            try:
                child = self.load(path.stem)
            except (OSError, ValueError, TypeError):
                continue
            if child['delegation']['taskId'] == task_id:
                return child
        raise FileNotFoundError('child session not found')

    def children(self):
        """Return the bounded set of valid retained children for this parent."""
        paths = sorted(self.directory.glob('*.json'))
        if len(paths) > MAX_CHILD_SESSIONS:
            raise ValueError('child session limit reached for parent')
        rows = []
        for path in paths:
            if not _SID.fullmatch(path.stem):
                continue
            try:
                rows.append(self.load(path.stem))
            except (OSError, ValueError, TypeError):
                continue
        rows.sort(key=lambda child: (child.get('delegation', {}).get('createdAt') or 0,
                                     child.get('id') or ''))
        return rows


def inherit_context(parent):
    """Copy a closed, bounded context only after an explicit inheritance request."""
    messages = parent.get('messages') if isinstance(parent, dict) else None
    if not isinstance(messages, list):
        raise ValueError('parent context unavailable')
    selected = [deepcopy(row) for row in messages
                if isinstance(row, dict) and row.get('role') != 'system']
    if len(selected) >= MAX_CHILD_MESSAGES or len(json.dumps(selected).encode('utf-8')) > MAX_CHILD_BYTES // 2:
        raise ValueError('parent context exceeds child inheritance limit')
    # A task dispatch itself is still an open tool call. Exclude the entire
    # final open assistant exchange rather than fabricate results for it.
    while selected and selected[-1].get('role') == 'assistant' and selected[-1].get('tool_calls'):
        selected.pop()
    results = parent.get('results') or {}
    for row in selected:
        for call in row.get('tool_calls') or []:
            cid = call.get('id') if isinstance(call, dict) else None
            if cid not in results:
                raise ValueError('parent context contains an unfinished tool exchange')
    return selected


def recovery_info(child):
    """No tool with an uncertain outcome is silently replayed during recovery."""
    status = child.get('status')
    if status in ('cancelled', 'stopped') or child.get('delegation', {}).get('cancelled') is True:
        return {'canResume': False, 'recoveryReason': 'cancelled'}
    if child.get('pending_question'):
        return {'canResume': False, 'recoveryReason': 'waiting_for_user_answer'}
    results = child.get('results') or {}
    result_messages = {row.get('tool_call_id') for row in child.get('messages') or []
                       if isinstance(row, dict) and row.get('role') == 'tool'}
    for row in child.get('messages') or []:
        if not isinstance(row, dict):
            return {'canResume': False, 'recoveryReason': 'invalid_transcript'}
        for call in row.get('tool_calls') or []:
            cid = call.get('id') if isinstance(call, dict) else None
            if not cid or cid not in results or cid not in result_messages:
                return {'canResume': False, 'recoveryReason': 'unfinished_tool_exchange'}
    return {'canResume': True, 'recoveryReason':
            'followup_required' if status in ('completed', 'needs_review') else 'safe_boundary'}


def prepare_resume(child, message=None):
    info = recovery_info(child)
    if not info['canResume']:
        raise ValueError('child recovery refused: ' + info['recoveryReason'])
    if message is not None and (not isinstance(message, str) or not message.strip()
                                or len(message) > MAX_MESSAGE_CHARS):
        raise ValueError('message must contain 1..24000 characters')
    if info['recoveryReason'] == 'followup_required' and message is None:
        raise ValueError('completed child requires a followup message')
    if message is not None:
        child['messages'].append({'role': 'user', 'content': message,
                                  '_message_id': uuid.uuid4().hex,
                                  '_turn_id': uuid.uuid4().hex})
    stream = child.get('streaming')
    if isinstance(stream, dict):
        stream['status'] = 'interrupted'
        stream['interrupted'] = True
    child.update(status='pending', completion=None)
    child.pop('pause_code', None)
    child.pop('pause_reason', None)
    child['delegation']['resumeCount'] = int(child['delegation'].get('resumeCount', 0)) + 1
    return child


def _inbox_store(store):
    from ...core import Store
    from ...resources import _is_link
    directory = store.directory / 'inboxes'
    if _is_link(directory):
        raise ValueError('invalid child inbox directory')
    return Store(directory)


def enqueue_message(store, child, message, request_id):
    """Persist a replayable receipt; never rewrite the running child journal."""
    from ...session_lease import journal_lock
    if (not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE_CHARS
            or not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,160}', request_id)):
        raise ValueError('valid message and requestId are required')
    if (child.get('status') not in ('pending', 'running')
            or child.get('delegation', {}).get('cancelled') is True
            or child.get('status') in ('cancelled', 'stopped')
            or child.get('pending_question')):
        raise ValueError('child cannot accept messages in its current state')
    inbox = _inbox_store(store)
    with journal_lock(inbox, child['id']):
        # The outer short lock serializes admission; the private kernel write
        # primitive keeps atomic replacement without taking the same lock twice.
        try:
            row = inbox._read_journal(child['id'])
        except FileNotFoundError:
            row = {'id': child['id'], 'items': []}
        digest = hashlib.sha256(message.encode('utf-8')).hexdigest()
        for item in row['items']:
            if item['id'] == request_id:
                if item['digest'] != digest:
                    raise ValueError('requestId already names a different message')
                return {key: item[key] for key in ('id', 'status')}
        if len(row['items']) >= MAX_INBOX_ITEMS:
            settled = [i for i, item in enumerate(row['items']) if item['status'] == 'applied']
            if not settled:
                raise ValueError('child message inbox is full')
            del row['items'][settled[0]]
        row['items'].append({'id': request_id, 'message': message, 'digest': digest,
                             'status': 'queued', 'createdAt': time.time()})
        inbox._write_journal(row)
    return {'id': request_id, 'status': 'queued'}


def apply_messages(store, child):
    """Apply admitted messages once, between complete provider/tool exchanges."""
    from ...session_lease import journal_lock
    if not recovery_info(child)['canResume']:
        return []
    inbox = _inbox_store(store)
    with journal_lock(inbox, child['id']):
        try:
            row = inbox._read_journal(child['id'])
        except FileNotFoundError:
            return []
        applied = []
        existing = {message.get('_input_id') for message in child.get('messages') or []
                    if isinstance(message, dict)}
        for item in row['items']:
            if item['status'] != 'queued':
                continue
            if item['id'] not in existing:
                child['messages'].append({'role': 'user', 'content': item['message'],
                                          '_input_id': item['id'], '_message_id': uuid.uuid4().hex,
                                          '_turn_id': uuid.uuid4().hex,
                                          '_input_presentation': 'coordinator_steer'})
                existing.add(item['id'])
            applied.append(item['id'])
        if applied:
            # Child first, receipt second. A crash in between finds _input_id
            # and settles the receipt without reinserting the same message.
            store.save(child)
            for item in row['items']:
                if item['id'] in applied:
                    item.update(status='applied', appliedAt=time.time())
            inbox._write_journal(row)
        return applied


def projection(child):
    lineage = child['delegation']
    status = child.get('status')
    mapped = ('completed' if status == 'completed' else 'cancelled' if status in ('stopped', 'cancelled')
              else 'running' if status == 'running' else 'failed')
    completion = child.get('completion')
    return {'id': lineage['taskId'], 'parent': lineage['parentSessionId'],
            'parentSessionId': lineage['parentSessionId'], 'rootSessionId': lineage['rootSessionId'],
            'childSessionId': child['id'], 'agent': lineage.get('agent'),
            'status': mapped, 'childStatus': status, 'steps': child.get('steps', 0),
            'startedAt': lineage.get('createdAt'), 'endedAt': lineage.get('endedAt'),
            'summary': str((completion or {}).get('summary') or '')[:4000]
            if isinstance(completion, dict) else '',
            'error': str(child.get('pause_reason') or '')[:500],
            **recovery_info(child)}
