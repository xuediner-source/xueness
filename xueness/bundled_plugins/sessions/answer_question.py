"""Experimental, idempotent answer API for a pending ``ask_user`` question.

The API only records the operator's answer in the current session. Continuing
the conversation is a separate, explicit run action owned by the sessions
plugin's existing controls.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from ... import plugin_runtime
from ... import web as host
from ..settings.settings_store import load_settings

FEATURE_ID = 'sessions.answer_question_experimental'
SETTINGS_KEY = 'sessionsAnswerQuestionEnabled'
_QUESTION_ID = re.compile(r'q-[0-9a-f]{64}\Z')
_HASH = re.compile(r'[0-9a-f]{64}\Z')
_MAX_ANSWER_CHARS = 5000


def enabled(ctx) -> bool:
    """Read the opt-in from this request's bound state directory."""
    state_dir = ctx.get('state_dir')
    if state_dir is None or not plugin_runtime.is_enabled(state_dir, 'sessions'):
        return False
    general = load_settings(state_dir).get('general', {})
    return isinstance(general, dict) and general.get(SETTINGS_KEY) is True


def _question_id(session: dict, question: str) -> str:
    """Bind the visible text to its actual ask occurrence, not text alone."""
    sid = session.get('id') if isinstance(session.get('id'), str) else ''
    messages = session.get('messages')
    results = session.get('results')
    if isinstance(messages, list) and isinstance(results, dict):
        for message_index in range(len(messages) - 1, -1, -1):
            message = messages[message_index]
            calls = message.get('tool_calls') if isinstance(message, dict) else None
            if not isinstance(calls, list):
                continue
            for call in reversed(calls):
                if not isinstance(call, dict):
                    continue
                function = call.get('function')
                call_id = call.get('id')
                result = results.get(call_id) if isinstance(call_id, str) else None
                if (isinstance(function, dict) and function.get('name') == 'ask_user'
                        and isinstance(result, dict) and result.get('awaiting_user') is True
                        and result.get('question') == question):
                    anchor = ['ask_user', message_index, call_id, question]
                    break
            else:
                continue
            break
        else:
            anchor = None
    else:
        anchor = None

    if anchor is None:
        # Imported/legacy journals may lack the call result. Include the
        # current occurrence context so asking the same text in a later turn
        # cannot reuse a prior answer's idempotency key.
        message_list = messages if isinstance(messages, list) else []
        user_indices = [index for index, message in enumerate(message_list)
                        if isinstance(message, dict) and message.get('role') == 'user']
        anchor = ['legacy_pending_question', len(message_list),
                  user_indices[-1] if user_indices else -1,
                  session.get('steps', 0), question]
    source = json.dumps([sid, anchor], ensure_ascii=True, separators=(',', ':'))
    return 'q-' + hashlib.sha256(source.encode('utf-8')).hexdigest()


def _validate_workspace(ctx, session):
    root = session.get('root')
    if not isinstance(root, str) or not root:
        raise ValueError('workspace root not permitted')
    from ..settings.workspaces_api import allowed_roots
    return host._allowed_root(Path(root), ctx['web_runs'], ctx['project_dir'],
                              allowed_roots(ctx))


def _error(status: int, message: str, code: str):
    return status, {'error': message, 'errorCode': code}


def _load(ctx, sid):
    try:
        return ctx['store'].load(sid)
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def _question_payload(session: dict, is_enabled: bool):
    text = session.get('pending_question')
    pending = None
    if (is_enabled and session.get('status') == 'awaiting_user'
            and isinstance(text, str) and text.strip()):
        pending = {'id': _question_id(session, text), 'text': text}
    return {'id': session['id'], 'enabled': is_enabled, 'question': pending}


def _post_answer(ctx, sid: str, data):
    if not isinstance(data, dict) or set(data) != {'questionId', 'answer'}:
        return _error(400, 'expected questionId and answer', 'sessions.answer_question.invalid_request')
    question_id, answer = data.get('questionId'), data.get('answer')
    if not isinstance(question_id, str) or not _QUESTION_ID.fullmatch(question_id):
        return _error(400, 'invalid questionId', 'sessions.answer_question.invalid_request')
    if not isinstance(answer, str):
        return _error(400, 'answer must be 1..5000 characters',
                      'sessions.answer_question.invalid_answer')
    try:
        normalized = answer.strip()
        if not 1 <= len(normalized) <= _MAX_ANSWER_CHARS:
            return _error(400, 'answer must be 1..5000 characters',
                          'sessions.answer_question.invalid_answer')
        answer_digest = hashlib.sha256(normalized.encode('utf-8')).hexdigest()
    except UnicodeEncodeError:
        return _error(400, 'answer must be valid UTF-8',
                      'sessions.answer_question.invalid_answer')

    if not enabled(ctx):
        return 403, {'error': FEATURE_ID + ' not enabled', 'feature': FEATURE_ID}
    with ctx['lock']:
        if sid in ctx.get('running', {}):
            return _error(409, 'session run already in progress',
                          'sessions.answer_question.session_busy')
    try:
        with host.lease(ctx['store'], sid):
            # Re-check both switches and the journal while holding the same
            # cross-process lease used by the run and legacy answer route.
            if not enabled(ctx):
                return 403, {'error': FEATURE_ID + ' not enabled', 'feature': FEATURE_ID}
            session = ctx['store'].load(sid)
            try:
                _validate_workspace(ctx, session)
            except (OSError, ValueError):
                return _error(400, 'workspace root not permitted',
                              'sessions.answer_question.workspace_not_permitted')
            raw_records = session.get('question_answer_records', {})
            if not isinstance(raw_records, dict):
                return _error(409, 'answer history is invalid',
                              'sessions.answer_question.state_invalid')
            previous = raw_records.get(question_id)
            if previous is not None:
                if not isinstance(previous, str) or not _HASH.fullmatch(previous):
                    return _error(409, 'answer history is invalid',
                                  'sessions.answer_question.state_invalid')
                if previous != answer_digest:
                    return _error(409, 'question already has a different answer',
                                  'sessions.answer_question.answer_conflict')
                return 200, {'id': sid, 'status': session.get('status'),
                             'questionId': question_id, 'accepted': True,
                             'alreadyAnswered': True}

            text = session.get('pending_question')
            current_id = (_question_id(session, text)
                          if session.get('status') == 'awaiting_user'
                          and isinstance(text, str) and text.strip() else None)
            if current_id != question_id:
                return _error(409, 'question is stale',
                              'sessions.answer_question.question_stale')

            session.setdefault('question_answer_records', {})[question_id] = answer_digest
            result = host.answer_session(session, ctx['store'], normalized)
            return 200, {'id': sid, 'status': result.get('status'),
                         'questionId': question_id, 'accepted': True,
                         'alreadyAnswered': False}
    except BlockingIOError:
        return _error(409, 'session is in use by another process',
                      'sessions.answer_question.session_busy')
    except FileNotFoundError:
        return 404, {'error': 'session not found'}
    except OSError:
        return _error(503, 'could not save the answer',
                      'sessions.answer_question.storage_unavailable')
    except ValueError:
        return _error(409, 'session state changed; refresh the question',
                      'sessions.answer_question.question_stale')


def dispatch(method, parts, query, data, ctx):
    if (not isinstance(parts, list) or len(parts) != 4
            or parts[:2] != ['api', 'sessions'] or not host._valid_sid(parts[2])):
        return None
    sid = parts[2]
    if parts[3] == 'answer-question' and method == 'POST':
        return _post_answer(ctx, sid, data)
    if parts[3] != 'question' or method != 'GET':
        return None
    session = _load(ctx, sid)
    if session is None:
        return 404, {'error': 'session not found'}
    try:
        _validate_workspace(ctx, session)
    except (OSError, ValueError):
        return _error(400, 'workspace root not permitted',
                      'sessions.answer_question.workspace_not_permitted')
    active = enabled(ctx)
    return 200, _question_payload(session, active)
