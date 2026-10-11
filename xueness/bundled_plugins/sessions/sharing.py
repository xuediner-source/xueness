"""Selected-turn, read-only sharing on the configured Xueness web host.

Published records contain only reviewed transcript text. Import creates a
paused conversation with fresh identity and no execution/approval metadata.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import stat
import uuid
from datetime import datetime, timezone

from ...resources import _is_link, _atomic_write_json, _protect_private_directory
from .message_actions import revision
from .session_management import validate_title

SCHEMA = 'xueness.conversation-share.v1'


def dispatch_page(parts, ctx):
    if len(parts) != 2 or parts[0] != 'share' or not re.fullmatch(r'[0-9a-f]{32}', parts[1]):
        return None
    from ...http_contract import HANDLED_RESPONSE
    try:
        body = (Path(ctx['webapp_dir']) / 'index.html').read_bytes()
    except OSError:
        return 503, {'error': 'ui asset missing'}
    ctx['handler']._send(200, body, 'text/html; charset=utf-8')
    return HANDLED_RESPONSE
MAX_BYTES = 4 * 1024 * 1024


def _path(ctx, share_id):
    if not isinstance(share_id, str) or not re.fullmatch(r'[0-9a-f]{32}', share_id):
        raise ValueError('invalid conversation share id')
    directory = Path(ctx['state_dir']) / 'conversation_shares'
    if _is_link(Path(ctx['state_dir'])) or _is_link(directory):
        raise ValueError('invalid conversation share directory')
    path = directory / (share_id + '.json')
    if _is_link(path):
        raise ValueError('invalid conversation share file')
    return path


def _read(ctx, share_id):
    path = _path(ctx, share_id)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            raise ValueError('invalid conversation share file')
        record = json.loads(stream.read(MAX_BYTES + 1).decode('utf-8'))
    if (not isinstance(record, dict) or record.get('schema') != SCHEMA or record.get('id') != share_id
            or not isinstance(record.get('rows'), list)):
        raise ValueError('invalid conversation share')
    return record


def _text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(part['text'] for part in value if isinstance(part, dict)
                         and part.get('type') == 'text' and isinstance(part.get('text'), str))
    return ''


def _rows(session):
    from .conversation_snapshot import _display_messages
    rows, turn = [], 0
    for index, (message, _) in enumerate(_display_messages(session)):
        if not isinstance(message, dict) or message.get('role') not in ('user', 'assistant'):
            continue
        identity = message.get('_message_id')
        if message['role'] == 'user' and message.get('_input_kind') != 'guide':
            turn += 1
        turn_id = message.get('_turn_id') or f'turn-{max(1, turn)}'
        text = _text(message.get('content'))
        if text:
            rows.append({'id': identity or f'message-{index}', 'turnId': turn_id,
                         'role': message['role'], 'text': text})
    return rows


def publish(ctx, sid, data):
    if set(data) - {'title', 'turn_ids', 'expected_revision'}:
        raise ValueError('unsupported conversation share field')
    session = ctx['store'].load(sid)
    if data.get('expected_revision') != revision(session):
        return 409, {'error': 'conversation changed; review the selected messages again'}
    rows = _rows(session)
    turns = data.get('turn_ids')
    if turns is not None:
        if (not isinstance(turns, list) or not turns or len(turns) > 500
                or any(not isinstance(t, str) or not re.fullmatch(r'turn-[1-9][0-9]*', t) for t in turns)
                or not set(turns).issubset({row['turnId'] for row in rows})):
            raise ValueError('invalid selected conversation turns')
        rows = [row for row in rows if row['turnId'] in set(turns)]
    if not rows or len(rows) > 2000:
        raise ValueError('select 1..2000 conversation messages')
    title = validate_title(data.get('title') or session.get('title') or session['task'][:120])
    share_id = uuid.uuid4().hex
    record = {'schema': SCHEMA, 'id': share_id, 'title': title, 'rows': rows,
              'createdAt': datetime.now(timezone.utc).isoformat()}
    if len(json.dumps(record, ensure_ascii=False).encode('utf-8')) > MAX_BYTES:
        raise ValueError('selected conversation is too large to share')
    path = _path(ctx, share_id)
    path.parent.mkdir(mode=0o700, exist_ok=True)
    _protect_private_directory(path.parent)
    _atomic_write_json(path, record)
    return 201, {'id': share_id, 'url': '/share/' + share_id, 'title': title}


def import_share(ctx, share_id, data):
    from . import http_routes
    from ..settings.workspaces_api import get_default_root, allowed_roots
    from ...core import SYSTEM
    if set(data) - {'root', 'title'}:
        raise ValueError('unsupported conversation import field')
    record = _read(ctx, share_id)
    if 'root' in data:
        if not isinstance(data['root'], str) or not data['root'].strip():
            raise ValueError('workspace root must be a path')
        root = http_routes.host._allowed_root(Path(data['root']), ctx['web_runs'], ctx['project_dir'], allowed_roots(ctx))
    else:
        root = get_default_root(ctx)
    title = validate_title(data.get('title') or record['title'])
    session = ctx['store'].new(title, root)
    if root == Path(ctx['web_runs']).resolve():
        root = root / session['id']
        root.mkdir(parents=True, exist_ok=True)
        session['root'] = str(root)
    messages = [{'role': row['role'], 'content': row['text']} for row in record['rows']
                if isinstance(row, dict) and row.get('role') in ('user', 'assistant') and isinstance(row.get('text'), str)]
    if not messages or messages[0]['role'] != 'user':
        messages.insert(0, {'role': 'user', 'content': title})
    session.update(messages=[{'role': 'system', 'content': SYSTEM}, *messages], status='paused',
                   title=title, task=messages[0]['content'], imported_share={'id': share_id, 'title': title})
    ctx['store'].save(session)
    return 201, {'id': session['id']}


def dispatch(method, parts, query, data, ctx):
    try:
        if method == 'GET' and len(parts) == 4 and parts[:2] == ['api', 'sessions'] and parts[3] == 'share':
            session = ctx['store'].load(parts[2])
            rows = _rows(session)
            if len(rows) > 2000 or len(json.dumps(rows, ensure_ascii=False).encode('utf-8')) > MAX_BYTES:
                return 400, {'error': 'conversation is too large to share'}
            return 200, {'title': session.get('title') or session['task'], 'rows': rows,
                         'message_revision': revision(session)}
        if method == 'POST' and len(parts) == 4 and parts[:2] == ['api', 'sessions'] and parts[3] == 'share':
            return publish(ctx, parts[2], data)
        if parts[:2] != ['api', 'conversation_shares'] or len(parts) not in (3, 4):
            return None
        if len(parts) == 3 and method == 'GET':
            return 200, _read(ctx, parts[2])
        if len(parts) == 3 and method == 'DELETE':
            with ctx['lock']:
                path = _path(ctx, parts[2])
                _read(ctx, parts[2])
                path.unlink()
            return 200, {'id': parts[2], 'revoked': True}
        if len(parts) == 4 and parts[3] == 'import' and method == 'POST':
            return import_share(ctx, parts[2], data)
        return 405, {'error': 'method not allowed'}
    except FileNotFoundError:
        return 404, {'error': 'conversation share not found or revoked'}
    except (OSError, ValueError, KeyError):
        return 400, {'error': 'invalid conversation share request'}
