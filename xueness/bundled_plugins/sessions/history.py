"""Stable append-only revisions of the existing private session snapshot.

The JSON journal remains the compatibility checkpoint. Revisions retain edits
and compaction as ordered facts, with message identities independent of indices.
A lost publication after a checkpoint is repaired by an explicit reset fact;
neither an incomplete tail nor an old display cursor becomes a different event.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import threading
from datetime import datetime, timezone

from ...resources import _is_link, _protect_private_file
from ...session_lease import journal_lock

SCHEMA = 'xueness.session-history.v1'
MAX_LINE_BYTES = 32 * 1024 * 1024
_CACHE = {}
_GUARD = threading.RLock()
_CHANGED = threading.Condition(_GUARD)
META = frozenset({'history_revision', 'history_hash'})


def content(session):
    return {key: value for key, value in session.items() if key not in META}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def difference(before, after, path=()):
    """Produce bounded-path operations, using suffixes for growing text/lists."""
    if before == after:
        return []
    if isinstance(before, dict) and isinstance(after, dict):
        out = [{'op': 'delete', 'path': [*path, key]} for key in before.keys() - after.keys()]
        for key, value in after.items():
            out.extend(difference(before[key], value, (*path, key)) if key in before else
                       [{'op': 'set', 'path': [*path, key], 'value': copy.deepcopy(value)}])
        return out
    if isinstance(before, str) and isinstance(after, str) and after.startswith(before):
        return [{'op': 'append', 'path': list(path), 'value': after[len(before):]}]
    if isinstance(before, list) and isinstance(after, list) and len(after) >= len(before):
        out = []
        for index, value in enumerate(before):
            out.extend(difference(value, after[index], (*path, index)))
        if len(after) > len(before):
            out.append({'op': 'append', 'path': list(path), 'value': copy.deepcopy(after[len(before):])})
        return out
    return [{'op': 'set', 'path': list(path), 'value': copy.deepcopy(after)}]


def apply(state, operations):
    for item in operations:
        path = item['path']
        if not path:
            if item['op'] != 'set':
                raise ValueError('invalid history root operation')
            state = copy.deepcopy(item['value'])
            continue
        parent = state
        for key in path[:-1]:
            parent = parent[key]
        key = path[-1]
        if item['op'] == 'delete':
            del parent[key]
        elif item['op'] == 'set':
            parent[key] = copy.deepcopy(item['value'])
        elif item['op'] == 'append':
            if isinstance(parent[key], list):
                parent[key].extend(copy.deepcopy(item['value']))
            elif isinstance(parent[key], str) and isinstance(item['value'], str):
                parent[key] += item['value']
            else:
                raise ValueError('invalid history append')
        else:
            raise ValueError('invalid history operation')
    return state


def _path(store, sid):
    store._path(sid)
    path = Path(store.directory) / (sid + '.history.jsonl')
    if _is_link(path):
        raise ValueError('session history is a symbolic link or reparse point')
    return path


def _scan(path):
    state, records, size = {}, [], 0
    if not path.exists():
        return state, records, size
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    with os.fdopen(os.open(path, flags), 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('session history is not a regular file')
        for raw in stream:
            if not raw.endswith(b'\n'):
                break  # only a torn final publication may be repaired
            if len(raw) > MAX_LINE_BYTES:
                raise ValueError('session history record is too large')
            row = json.loads(raw.decode('utf-8'))
            previous = records[-1] if records else None
            unsigned = {key: value for key, value in row.items() if key != 'recordHash'}
            if (row.get('schema') != SCHEMA or type(row.get('seq')) is not int
                    or row['seq'] < 1 or row.get('recordHash') != digest(unsigned)
                    or row.get('parentHash') != (previous['recordHash'] if previous else '')
                    or previous and row['seq'] <= previous['seq']):
                raise ValueError('session history chain is invalid')
            state = apply(state, row['operations'])
            if digest(state) != row['stateHash']:
                raise ValueError('session history state is invalid')
            records.append(row)
            size += len(raw)
    return state, records, size


def _current(path):
    key = str(path)
    signature = _signature(path)
    with _GUARD:
        cached = _CACHE.get(key)
        if cached is not None and cached[3] == signature:
            return cached[:3]
    state, records, good_size = _scan(path)
    with _GUARD:
        if len(_CACHE) > 128:
            _CACHE.clear()
        _CACHE[key] = (state, records, good_size, signature)
    return state, records, good_size


def _signature(path):
    if not path.exists():
        return None
    info = path.stat()
    return info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino


def prepare(store, session):
    """Caller holds Store's journal lock; stage metadata before JSON publish."""
    path = _path(store, session['id'])
    previous, records, good_size = _current(path)
    value = content(session)
    state_hash = digest(value)
    last = records[-1] if records else None
    if last and last['stateHash'] == state_hash:
        session.update(history_revision=last['seq'], history_hash=state_hash)
        return None
    claimed = session.get('history_revision', 0)
    claimed = claimed if type(claimed) is int and claimed >= 0 else 0
    seq = max(last['seq'] if last else 0, claimed) + 1
    reset = not records or claimed != (last['seq'] if last else 0)
    operations = ([{'op': 'set', 'path': [], 'value': copy.deepcopy(value)}] if reset else
                  difference(previous, value))
    row = dict(schema=SCHEMA, seq=seq, sessionId=session['id'],
               timestamp=datetime.now(timezone.utc).isoformat(),
               parentHash=last['recordHash'] if last else '', stateHash=state_hash,
               reset=reset, operations=operations)
    row['recordHash'] = digest(row)
    if len(json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) + 1 > MAX_LINE_BYTES:
        raise ValueError('session history record is too large')
    session.update(history_revision=seq, history_hash=state_hash)
    return path, row, value, records, good_size


def commit(token):
    if token is None:
        return
    path, row, value, records, good_size = token
    raw = (json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
    if len(raw) > MAX_LINE_BYTES:
        raise ValueError('session history record is too large')
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    fd = os.open(path, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or _is_link(path):
            raise ValueError('session history is not a regular file')
        _protect_private_file(fd)
        os.ftruncate(fd, good_size)
        os.lseek(fd, good_size, os.SEEK_SET)
        remaining = memoryview(raw)
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0:
                raise OSError('session history write made no progress')
            remaining = remaining[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    with _CHANGED:
        _CACHE[str(path)] = (copy.deepcopy(value), [*records, row], good_size + len(raw), _signature(path))
        _CHANGED.notify_all()


def page(store, sid, cursor=0, limit=100):
    if type(cursor) is not int or cursor < 0 or type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError('invalid history cursor')
    with store._thread_lock(sid), journal_lock(store, sid):
        session = store._read_journal(sid)
        token = prepare(store, session)
        if token is not None:
            store._write_journal(session)
            commit(token)
        _, records, _ = _current(_path(store, sid))
        head = records[-1]['seq'] if records else 0
        selected = [row for row in records if row['seq'] > cursor][:limit]
        return dict(schema=SCHEMA, sessionId=sid, cursor=cursor, head=head,
                    nextCursor=selected[-1]['seq'] if selected else head,
                    resync=cursor > head or bool(selected and cursor and selected[0]['seq'] != cursor + 1),
                    records=copy.deepcopy(selected), hasMore=bool(selected and selected[-1]['seq'] < head))


def wait(timeout=.25):
    with _CHANGED:
        _CHANGED.wait(timeout)


def dispatch(method, parts, query, data, ctx):
    if method != 'GET' or len(parts) != 4 or parts[:2] != ['api', 'sessions'] or parts[3] != 'history':
        return None
    try:
        return 200, page(ctx['store'], parts[2], int((query.get('cursor') or ['0'])[0]),
                         int((query.get('limit') or ['100'])[0]))
    except FileNotFoundError:
        return 404, {'error': 'session not found'}
    except (OSError, ValueError, KeyError):
        return 409, {'error': 'session history unavailable; reload the conversation snapshot'}
