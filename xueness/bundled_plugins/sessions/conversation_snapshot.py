"""One journal read owns every row, outcome and mutation revision in a view.

The legacy endpoint returns a full snapshot. New workbench clients opt into a
bounded ``tail`` or ``before`` message window; original compacted messages and
the live request view share one read-only display order, while mutation
indices continue to refer only to the live ``messages`` list.
"""
from __future__ import annotations

import copy
import hashlib

from ... import events
from .http_routes import public_session_payload
from .message_actions import revision
from .forking import ForkError

DEFAULT_WINDOW = 80
MAX_WINDOW = 120


def _display_messages(session):
    """Return archived originals followed by the active request messages.

    Semantic handoffs keep a system summary in the active prompt; it is not an
    original transcript row, so omit it when the archive exists. Other system
    rows are retained as offsets but never become user-visible timeline rows.
    """
    active = session.get('messages')
    active = active if isinstance(active, list) else []
    archived = session.get('archived_messages')
    archived = archived if isinstance(archived, list) else []
    hidden_value = session.get('history_hidden_message_ids', [])
    if (not isinstance(hidden_value, list)
            or any(not isinstance(identity, str) or not identity for identity in hidden_value)):
        raise ForkError('saved conversation history metadata is invalid', 409)
    hidden = set(hidden_value)
    if not archived:
        return [(message, index) for index, message in enumerate(active)]
    rows = [(message, None) for message in archived
            if not isinstance(message, dict) or message.get('_message_id') not in hidden]
    start = 1 if active and isinstance(active[0], dict) and active[0].get('role') == 'system' else 0
    if (start < len(active) and isinstance(active[start], dict)
            and active[start].get('_semantic_summary') is True):
        start += 1
    rows.extend((message, index) for index, message in enumerate(active[start:], start))
    # Deterministic compaction may archive an original tool output and keep a
    # shortened copy in the request. A second compaction can also archive that
    # same message again. Render each stable identity once, using the original
    # journal text when the active copy carries a truncation marker.
    positions = {}
    unique = []
    for message, active_index in rows:
        identity = message.get('_message_id') if isinstance(message, dict) else None
        if not isinstance(identity, str) or not identity:
            unique.append((message, active_index))
            continue
        existing = positions.get(identity)
        if existing is None:
            positions[identity] = len(unique)
            unique.append((message, active_index))
            continue
        old_message, old_index = unique[existing]
        if active_index is not None and not _truncated_message(message):
            unique[existing] = (message, active_index)
        elif old_index is not None and _truncated_message(old_message) and active_index is None:
            unique[existing] = (message, None)
    return unique


def _truncated_message(message):
    if not isinstance(message, dict):
        return False
    content = message.get('content')
    if not isinstance(content, str):
        return False
    lowered = content.lower()
    return any(marker in lowered for marker in (
        '[old output masked;', '[truncated in context]', '[truncated in journal',
        '[output truncated', '… [truncated]'))


def _message_id(session_id, display_index, message):
    identity = message.get('_message_id') if isinstance(message, dict) else None
    if isinstance(identity, str) and identity:
        return identity
    raw = repr((session_id, display_index, message)).encode('utf-8', errors='replace')
    return 'legacy-' + hashlib.sha256(raw).hexdigest()[:32]


def _page_start(rows, end, limit):
    target = max(0, end - limit)
    if target == 0 or target >= end:
        return target
    # Keep a page boundary on a user turn when that remains reasonably close
    # to the requested size. A single unusually long tool turn stays bounded.
    aligned = next((index for index in range(target, end)
                    if isinstance(rows[index][0], dict)
                    and rows[index][0].get('role') == 'user'), None)
    if aligned is not None and aligned - target <= limit:
        return aligned
    return target


def _window_request(query):
    def one(name):
        value = query.get(name)
        if isinstance(value, (tuple, list)):
            value = value[0] if value else None
        return value

    tail, before, limit = one('tail'), one('before'), one('limit')
    if tail is None and before is None:
        return None
    try:
        size = int(limit) if limit is not None else DEFAULT_WINDOW
        if not 1 <= size <= MAX_WINDOW:
            raise ValueError
        if tail is not None and before is not None:
            raise ValueError
        if tail is not None:
            requested = int(tail)
            if requested < 1 or requested > MAX_WINDOW:
                raise ValueError
            size = requested
            end = 0  # resolved against the single loaded journal below
        else:
            end = int(before)
            if end < 0:
                raise ValueError
    except (ValueError, TypeError, OverflowError):
        raise ValueError('invalid conversation window') from None
    return {'tail': tail is not None, 'before': end, 'limit': size}


def _safe_window(rows, request):
    if request is None:
        return 0, len(rows)
    end = request['before']
    if request['tail']:
        end = len(rows)
    elif end > len(rows):
        raise ValueError('invalid conversation window')
    return _page_start(rows, end, request['limit']), end


def _window_events(session, messages, start, end, total):
    turns = {message.get('_turn_id') for message, _ in messages
             if isinstance(message, dict) and isinstance(message.get('_turn_id'), str)}
    call_ids = set()
    for message, _ in messages:
        if not isinstance(message, dict):
            continue
        call_ids.update(call.get('id') for call in message.get('tool_calls', [])
                        if isinstance(call, dict) and isinstance(call.get('id'), str))
        if isinstance(message.get('tool_call_id'), str):
            call_ids.add(message['tool_call_id'])
    synthetic = {key: session.get(key) for key in (
        'id', 'status', 'steps', 'mode', 'pending_question')}
    synthetic['results'] = {key: value for key, value in (session.get('results') or {}).items()
                            if key in call_ids} if isinstance(session.get('results'), dict) else {}
    synthetic['completion_history'] = [record for record in session.get('completion_history', [])
        if isinstance(record, dict) and record.get('turn_id') in turns]
    completion = session.get('completion')
    synthetic['completion'] = (completion if isinstance(completion, dict)
                               and completion.get('turn_id') in turns else None)
    page_messages = [copy.deepcopy(message) for message, _ in messages]
    if start > 0:
        first = next((message for message in page_messages if isinstance(message, dict)), {})
        first_turn = first.get('_turn_id', 'turn-1')
        if (first.get('role') == 'user' and first.get('_input_kind') != 'guide'
                and isinstance(first_turn, str) and first_turn.startswith('turn-')):
            try:
                first_turn = f'turn-{max(1, int(first_turn[5:]) - 1)}'
            except ValueError:
                first_turn = 'turn-1'
        # derive_events omits the first user message because it is the task.
        # A synthetic predecessor means a page starting later still displays
        # its first real user message as an ordinary turn.
        page_messages.insert(0, {'role': 'user', 'content': '', '_turn_id': first_turn})
    synthetic['messages'] = page_messages
    derived = events.derive_events(synthetic)
    envelope = events.page_events(synthetic, derived, 0, events.MAX_LIMIT)
    envelope.update(events=derived, nextCursor=events.head_seq(derived), hasMore=False)
    return envelope


def _paged_snapshot(ctx, session, rows, start, end):
    sid = session['id']
    display = []
    active_indexes = []
    annotations = {}
    reasoning = []
    source_annotations = session.get('message_annotations')
    source_annotations = source_annotations if isinstance(source_annotations, dict) else {}
    source_reasoning = session.get('reasoning_history')
    source_reasoning = source_reasoning if isinstance(source_reasoning, list) else []
    local_by_active = {}
    for local, (original, active_index) in enumerate(rows[start:end]):
        message = copy.deepcopy(original) if isinstance(original, dict) else original
        if isinstance(message, dict):
            message.setdefault('_message_id', _message_id(sid, start + local, message))
        display.append(message)
        active_indexes.append(active_index)
        if active_index is not None:
            local_by_active[active_index] = local
            annotation = source_annotations.get(str(active_index))
            if annotation is not None:
                annotations[str(local)] = copy.deepcopy(annotation)
    for record in source_reasoning:
        if not isinstance(record, dict) or type(record.get('message_index')) is not int:
            continue
        local = local_by_active.get(record['message_index'])
        if local is not None and isinstance(record.get('text'), str):
            reasoning.append({'message_index': local, 'text': record['text']})
    message_revision = revision(session)
    window = {'start': start, 'end': end, 'total': len(rows), 'hasOlder': start > 0,
              'olderCursor': start if start > 0 else None,
              'messageRevision': message_revision,
              'historyRevision': session.get('history_revision', 0)}
    journal = {
        'id': sid, 'status': session.get('status'), 'task': session.get('task'),
        'messages': display, 'message_revision': message_revision,
        'history_revision': session.get('history_revision', 0),
        'message_window': {**window, 'messageIndices': active_indexes},
        'message_annotations': annotations, 'reasoning_history': reasoning,
        'completion_history': [copy.deepcopy(record) for record in session.get('completion_history', [])
                              if isinstance(record, dict)
                              and any(record.get('turn_id') == message.get('_turn_id')
                                      for message in display if isinstance(message, dict))],
    }
    # Keep full tool values only for exchanges inside this display page.
    page_messages = rows[start:end]
    call_ids = set()
    for message, _ in page_messages:
        if not isinstance(message, dict):
            continue
        call_ids.update(call.get('id') for call in message.get('tool_calls', [])
                        if isinstance(call, dict) and isinstance(call.get('id'), str))
        if isinstance(message.get('tool_call_id'), str):
            call_ids.add(message['tool_call_id'])
    raw_results = session.get('results')
    journal['results'] = ({key: value for key, value in raw_results.items() if key in call_ids}
                          if isinstance(raw_results, dict) else {})
    completion = session.get('completion')
    page_turns = {message.get('_turn_id') for message in display
                  if isinstance(message, dict) and isinstance(message.get('_turn_id'), str)}
    if isinstance(completion, dict) and completion.get('turn_id') in page_turns:
        journal['completion'] = copy.deepcopy(completion)
    timeline = _window_events(session, page_messages, start, end, len(rows))
    return {'session': public_session_payload(ctx, session), 'journal': journal,
            'timeline': timeline, 'window': window}


def snapshot(ctx, sid, *, window=None, revision_guard=None):
    session = ctx['store'].load(sid)
    if not isinstance(session, dict) or session.get('id') != sid or not isinstance(session.get('messages'), list):
        raise ForkError('saved conversation is invalid', 409)
    current_revision = revision(session)
    if revision_guard is not None and revision_guard != current_revision:
        raise ForkError('conversation changed; reload the transcript window', 409)
    if window is not None:
        rows = _display_messages(session)
        start, end = _safe_window(rows, window)
        return _paged_snapshot(ctx, session, rows, start, end)
    derived = events.derive_events(session)
    envelope = events.page_events(session, derived, 0, events.MAX_LIMIT)
    # Unlike cursor polling, a legacy journal snapshot includes the complete
    # retained transcript. New clients use an explicit bounded window.
    envelope.update(events=derived, nextCursor=events.head_seq(derived), hasMore=False)
    return {'session': public_session_payload(ctx, session),
            'journal': {**session, 'message_revision': current_revision}, 'timeline': envelope}


def dispatch(method, parts, query, data, ctx):
    if method != 'GET' or len(parts) != 4 or parts[:2] != ['api', 'sessions'] or parts[3] != 'conversation':
        return None
    try:
        ctx['store']._path(parts[2])
        request = _window_request(query)
        guard = query.get('revision')
        if isinstance(guard, (list, tuple)):
            guard = guard[0] if guard else None
        return 200, snapshot(ctx, parts[2], window=request, revision_guard=guard)
    except ForkError as exc:
        return exc.status, {'error': str(exc)}
    except FileNotFoundError:
        return 404, {'error': 'session not found'}
    except ValueError as exc:
        if str(exc) == 'invalid conversation window':
            return 400, {'error': str(exc)}
        return 500, {'error': 'cannot read conversation snapshot'}
    except (OSError, KeyError):
        return 500, {'error': 'cannot read conversation snapshot'}
