"""Bounded, paged transcript search. No index duplicates private journals.

Reads happen on the HTTP worker, never on the renderer. Each page advances a
file cursor, limits bytes and time, and searches only visible conversation
roles. Changing a query cancels the frontend's remaining pages.
"""
from __future__ import annotations

from datetime import datetime, timezone
import os
import re
import time

from ... import plugin_runtime
from .answer_question import _validate_workspace
from .composer_api import _read_session

_SID = re.compile(r'[0-9a-f]{32}\Z')
_MAX_PAGE_FILES = 32
_MAX_PAGE_BYTES = 16 * 1024 * 1024
_PAGE_SECONDS = .2
_MAX_MATCHES = 20


def _text(message):
    if not isinstance(message, dict) or message.get('role') not in ('user', 'assistant'):
        return ''
    content = message.get('content')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(part['text'] for part in content if isinstance(part, dict)
                         and part.get('type') == 'text' and isinstance(part.get('text'), str))
    return ''


def _snippet(text, needle):
    # Casefold can expand Unicode; use the original string's position whenever
    # possible, keeping both the query and the preview bounded.
    match = re.search(re.escape(needle), text, re.IGNORECASE)
    offset = match.start() if match else 0
    start = max(0, offset - 70)
    end = min(len(text), max(start + 220, offset + len(needle)))
    return ('…' if start else '') + ' '.join(text[start:end].split()) + ('…' if end < len(text) else '')


def _match(session, needle):
    # Compacted history remains searchable; tools, system instructions and
    # internal reasoning are not exposed as conversation search results.
    sources = [('messages', False), ('archived_messages', True)]
    for key, archived in sources:
        messages = session.get(key, [])
        if not isinstance(messages, list):
            continue
        for index in range(len(messages) - 1, -1, -1):
            text = _text(messages[index])
            if text and needle.casefold() in text.casefold():
                return {'snippet': _snippet(text, needle), 'messageIndex': index,
                        'role': messages[index]['role'], 'compacted': archived}
    return None


def search_page(ctx, needle, after=''):
    store = ctx['store']
    # _path checks the session directory's reparse boundary as well as IDs.
    store._path('0' * 32)
    paths = sorted(path for path in store.directory.glob('*.json')
                   if _SID.fullmatch(path.stem) and path.stem > after)
    deadline = time.monotonic() + _PAGE_SECONDS
    matches = []
    scanned = skipped = size = 0
    cursor = None
    for index, path in enumerate(paths):
        if scanned and (scanned >= _MAX_PAGE_FILES or size >= _MAX_PAGE_BYTES
                        or len(matches) >= _MAX_MATCHES or time.monotonic() >= deadline):
            cursor = paths[index - 1].stem
            break
        scanned += 1
        try:
            info = path.lstat()
            # The composer reader also validates the opened file and read cap.
            size += min(info.st_size, _MAX_PAGE_BYTES)
            session = _read_session(ctx, path.stem)
            if session is None:
                skipped += 1
                continue
            if session.get('archived') is True:
                continue
            _validate_workspace(ctx, session)
        except (OSError, ValueError):
            skipped += 1
            continue
        hit = _match(session, needle)
        if hit is None:
            continue
        updated = session.get('updated_at') or datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat()
        summary = {'id': path.stem, 'task': str(session.get('task', ''))[:5000],
                   'title': str(session.get('title', ''))[:500],
                   'root': session['root'], 'status': str(session.get('status', 'pending')),
                   'updatedAt': updated if isinstance(updated, str) else ''}
        matches.append({'session': summary, **hit})
    return {'query': needle, 'matches': matches, 'nextCursor': cursor,
            'scanned': scanned, 'skipped': skipped}


def dispatch(method, parts, query, data, ctx):
    if parts != ['api', 'sessions', 'search']:
        return None
    if not plugin_runtime.is_enabled(ctx.get('state_dir'), 'sessions'):
        return 403, {'error': 'plugin disabled or dependency unavailable: sessions', 'plugin': 'sessions'}
    if method != 'GET':
        return 405, {'error': 'method not allowed'}
    if not isinstance(query, dict) or set(query) - {'q', 'after'}:
        return 400, {'error': 'expected q and optional after'}
    def one(key, default=''):
        value = query.get(key, [default])
        if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], str):
            raise ValueError('invalid search parameters')
        return value[0]
    try:
        needle, after = one('q').strip(), one('after')
        if not 1 <= len(needle) <= 200 or any(ord(char) < 32 for char in needle):
            raise ValueError('query must be 1..200 characters')
        if after and not _SID.fullmatch(after):
            raise ValueError('invalid search cursor')
        return 200, search_page(ctx, needle, after)
    except ValueError as error:
        return 400, {'error': str(error)}
    except OSError:
        return 503, {'error': 'conversation search is temporarily unavailable'}
