"""Durable current-turn input and reserved next-turn promotion.

Only the run owning the session lease may splice a guide into its journal, at
a model-request boundary. HTTP admission writes a separate bounded inbox and
never modifies the model's in-flight history or replays a tool operation.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import uuid

from ... import plugin_runtime
from .queue import (MessageQueue, QueueConflict, SCHEMA, ACTIVE_STATUSES,
                    MAX_PENDING_ITEMS, MAX_PENDING_BYTES, MAX_ITEM_BYTES,
                    _REQUEST_ID, _SESSION_ID)


FEATURE_ID = 'sessions.current_turn_guidance'


def _fingerprint(body):
    return hashlib.sha256(json.dumps(body, ensure_ascii=True, sort_keys=True,
                                    separators=(',', ':')).encode('utf-8')).hexdigest()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _history_messages(session):
    messages = session.get('messages')
    archived = session.get('archived_messages')
    return [row for rows in (messages, archived) if isinstance(rows, list)
            for row in rows if isinstance(row, dict)]


def _seen_inputs(session):
    return {row['_input_id'] for row in _history_messages(session)
            if isinstance(row.get('_input_id'), str)}


class SteeringInbox(MessageQueue):
    """Use the queue's private-file, size-limit and cross-process lock protocol."""

    def __init__(self, store):
        super().__init__(store)
        self.directory = Path(store.directory) / 'session-turn-inputs'

    def _read(self, session_id):
        record = super()._read(session_id)
        for item in record['items']:
            turn_id = item.get('target_turn_id')
            if turn_id is not None and (not isinstance(turn_id, str)
                                        or not turn_id or len(turn_id) > 128
                                        or '\x00' in turn_id):
                raise ValueError('current-turn input target is invalid')
            if item.get('status') in ACTIVE_STATUSES and turn_id is None:
                raise ValueError('current-turn input target is missing')
        return record

    @staticmethod
    def _public_item(item, position=None):
        public = MessageQueue._public_item(item, position)
        public.update({'delivery': 'guide', 'targetTurnId': item.get('target_turn_id'),
                       'editable': False})
        return public

    def admit_locked(self, sid, text, turn_id, request_id, fingerprint, prepared=None):
        replay = self._replay_submission_locked(sid, request_id, fingerprint)
        if replay is not None:
            return replay, True
        record = self._read(sid)
        items = self._trim_history(record['items'])
        pending = [row for row in items if row['status'] in ACTIVE_STATUSES]
        if len(pending) >= MAX_PENDING_ITEMS:
            raise ValueError('current-turn input inbox is full')
        encoded_size = len(text.encode('utf-8')) + len((prepared or {}).get('text', '').encode('utf-8'))
        existing_size = sum(len(row['text'].encode('utf-8')) + len((row.get('prepared') or {}).get('text', '').encode('utf-8')) for row in pending)
        if encoded_size > MAX_ITEM_BYTES or existing_size + encoded_size > MAX_PENDING_BYTES:
            raise ValueError('current-turn input is too large')
        item = {'id': uuid.uuid4().hex, 'text': text, 'status': 'queued',
                'target_turn_id': turn_id, 'created_at': _now()}
        if prepared is not None:
            item['prepared'] = prepared
        receipt = self._public_item(item, len(pending) + 1)
        item['submission'] = {'id': request_id, 'fingerprint': fingerprint, 'receipt': receipt}
        items.insert(len(pending), item)
        self._atomic_save(sid, {'schema': SCHEMA, 'accepting': True, 'items': items})
        return receipt, False


def before_model_request(session, store, state_dir=None, **kwargs):
    """Splice admitted guides once, before deriving/compacting provider history.

    The session append is persisted before the receipt is settled. If either
    process stops in between, the stable input ID in retained or archived
    history is the recovery fence; the same input cannot become another turn.
    Guides retain the current human turn ID and do not reset its tool evidence.
    """
    if not plugin_runtime.is_enabled(state_dir, 'sessions'):
        return 0
    sid, turn_id = session.get('id'), session.get('active_turn_id')
    # Subagent runs use an ephemeral _NullStore and older internal callers can
    # carry noncanonical journal IDs. Neither owns a durable inbox sidecar.
    if (not isinstance(turn_id, str) or not turn_id
            or not isinstance(sid, str) or not _SESSION_ID.fullmatch(sid)
            or not isinstance(getattr(store, 'directory', None), (str, Path))):
        return 0
    inbox = SteeringInbox(store)
    if not inbox._path(sid).exists():
        return 0
    with inbox.session_lock(sid):
        record = inbox._read(sid)
        messages = session.setdefault('messages', [])
        if not isinstance(messages, list):
            raise ValueError('session messages are invalid')
        seen = _seen_inputs(session)
        count = 0
        changed = False
        for item in record['items']:
            if item['status'] not in ('queued', 'running'):
                continue
            if item['id'] in seen:
                item['status'] = 'completed'
                item.pop('prepared', None)
                item['updated_at'] = _now()
                changed = True
                continue
            if item.get('target_turn_id') != turn_id:
                item['status'] = 'paused'
                item['pause_reason'] = 'The target turn has ended; withdraw this input before submitting it again.'
                item['updated_at'] = _now()
                changed = True
                continue
            prepared = item.get('prepared') or {}
            content = prepared.get('text', item['text'])
            message = {'role': 'user', 'content': content,
                       '_message_id': item['id'], '_input_id': item['id'],
                       '_input_kind': 'guide', '_turn_id': turn_id,
                       '_request_id': item['submission']['id']}
            if isinstance(prepared.get('metadata'), dict):
                message['_composer_metadata'] = prepared['metadata']
            messages.append(message)
            # Saving a failed splice leaves the admission pending; the worker
            # exits on the persistence error instead of requesting a provider.
            # Roll back the in-memory append too, so settle_turn cannot mistake
            # an undurable message for one that reached the journal.
            try:
                store.save(session)
            except BaseException:
                messages.pop()
                raise
            seen.add(item['id'])
            item['status'] = 'completed'
            item['updated_at'] = _now()
            item.pop('prepared', None)
            changed = True
            count += 1
        if changed:
            inbox._atomic_save(sid, {'schema': SCHEMA, 'accepting': True,
                                     'items': inbox._trim_history(record['items'])})
        return count


def pending_snapshot(store, session):
    sid = session.get('id')
    if (not isinstance(sid, str) or not _SESSION_ID.fullmatch(sid)
            or not isinstance(getattr(store, 'directory', None), (str, Path))):
        return {'pending_guidance': [], 'guidance_history': []}
    inbox = SteeringInbox(store)
    if not inbox._path(sid).exists():
        return {'pending_guidance': [], 'guidance_history': []}
    # If a process died between core settling the run and the inbox journal
    # update, or sessions was disabled while the callback was unavailable,
    # retain those inputs as paused rows. A new active turn never inherits an
    # older turn's guidance.
    if session.get('status') == 'running' and isinstance(session.get('active_turn_id'), str):
        _pause_orphaned_guidance(inbox, sid, session['active_turn_id'])
    else:
        settle_turn(session, store)
    with inbox.session_lock(sid):
        snapshot = inbox._snapshot_locked(sid)
    return {'pending_guidance': snapshot['queued_messages'],
            'guidance_history': snapshot['queue_history']}


def settle_turn(session, store, turn_id=None):
    """An accepted guide that missed the last request remains visible, paused.

    A stop/restart never silently promotes current-turn guidance to a human
    follow-up. The operator can withdraw it and choose a new delivery.
    """
    sid = session.get('id')
    if (not isinstance(sid, str) or not _SESSION_ID.fullmatch(sid)
            or not isinstance(getattr(store, 'directory', None), (str, Path))):
        return
    inbox = SteeringInbox(store)
    if not inbox._path(sid).exists():
        return
    with inbox.session_lock(sid):
        record = inbox._read(sid)
        seen = _seen_inputs(session)
        changed = False
        for item in record['items']:
            if item['status'] not in ('queued', 'running') or turn_id and item.get('target_turn_id') != turn_id:
                continue
            item['status'] = 'completed' if item['id'] in seen else 'paused'
            if item['status'] == 'paused':
                item['pause_reason'] = 'The target turn ended before delivery; withdraw this input to send it again.'
            else:
                item.pop('prepared', None)
            item['updated_at'] = _now()
            changed = True
        if changed:
            inbox._atomic_save(sid, {'schema': SCHEMA, 'accepting': False, 'items': inbox._trim_history(record['items'])})


def _pause_orphaned_guidance(inbox, sid, active_turn_id):
    """Pause guides attached to earlier turns while preserving the live turn."""
    with inbox.session_lock(sid):
        record = inbox._read(sid)
        changed = False
        for item in record['items']:
            if (item['status'] not in ('queued', 'running')
                    or item.get('target_turn_id') == active_turn_id):
                continue
            item['status'] = 'paused'
            item['pause_reason'] = 'The target turn has ended; withdraw this input before submitting it again.'
            item['updated_at'] = _now()
            changed = True
        if changed:
            inbox._atomic_save(sid, {'schema': SCHEMA, 'accepting': True,
                                     'items': inbox._trim_history(record['items'])})


def reserve_promotion(queue, sid, queue_id, request_id, fingerprint, expected_turn_id=None):
    """Caller holds queue.session_lock; reserve the complete immutable record.

    Only the stopped worker/next explicit run can claim the promoted input.
    Failure before that claim releases it without losing attachments/receipts.
    """
    record = queue._read(sid)
    item = next((row for row in record['items'] if row['id'] == queue_id), None)
    if item is None:
        raise FileNotFoundError('queued message not found')
    for row in record['items']:
        promotion = row.get('promotion')
        if not isinstance(promotion, dict):
            continue
        if promotion.get('id') == request_id:
            if promotion.get('fingerprint') != fingerprint:
                raise QueueConflict('request_id already used for different promotion')
            if promotion.get('state') == 'released':
                raise QueueConflict('previous send-now reservation was released; try again')
            return promotion['receipt'], True
        if promotion.get('state') in ('reserved', 'claimed'):
            raise QueueConflict('a queued message is already being sent now')
    if item['status'] not in ('queued', 'paused'):
        raise QueueConflict('queued message is already claimed')
    receipt = {'id': queue_id, 'request_id': request_id, 'delivery': 'startNow',
               'state': 'reserved', 'targetTurnId': expected_turn_id}
    pending_ids = [row['id'] for row in record['items'] if row['status'] in ('queued', 'paused')]
    item['promotion'] = {'id': request_id, 'fingerprint': fingerprint,
                         'state': 'reserved', 'receipt': receipt,
                         'previous_ids': pending_ids}
    item['updated_at'] = _now()
    pending = [row for row in record['items'] if row['status'] in ('queued', 'paused')]
    ordered = iter([item] + [row for row in pending if row['id'] != queue_id])
    pending_set = set(pending_ids)
    record['items'] = [next(ordered) if row['id'] in pending_set else row for row in record['items']]
    queue._atomic_save(sid, record)
    return receipt, False


def release_promotion(queue, sid, request_id):
    """Return a failed reservation to its previous order before turn admission."""
    with queue.session_lock(sid):
        record = queue._read(sid)
        item = next((row for row in record['items'] if isinstance(row.get('promotion'), dict)
                     and row['promotion'].get('id') == request_id), None)
        if (item is None or item['promotion'].get('state') not in ('reserved', 'claimed')
                or item.get('status') not in ('queued', 'paused')):
            return False
        item['promotion']['state'] = 'released'
        ids = item['promotion']['previous_ids']
        pending = [row for row in record['items'] if row['status'] in ('queued', 'paused')]
        by_id = {row['id']: row for row in pending}
        ordered = iter([by_id[value] for value in ids if value in by_id]
                       + [row for row in pending if row['id'] not in ids])
        record['items'] = [next(ordered) if row['id'] in by_id else row for row in record['items']]
        queue._atomic_save(sid, record)
        return True


def _prepared_input(ctx, session, token):
    if token is None:
        return None
    from . import http_routes
    prepared = http_routes._consume_prepared(ctx, token, session['root'])
    running_context = ctx.get('running_context', {}).get(session['id'], {})
    current = running_context.get('model_selection') or session.get('model_selection') or {}
    selected = (prepared.get('metadata') or {}).get('modelSelection') or {}
    if any(selected.get(key) != current.get(key) for key in ('provider_id', 'model', 'reasoning_effort')):
        raise QueueConflict('current-turn input must use the active model selection')
    remote = running_context.get('remote_connection', session.get('remote_connection'))
    if http_routes._prepared_remote(ctx, prepared) != remote:
        raise QueueConflict('current-turn input must use the active remote connection')
    if prepared.get('goal'):
        raise QueueConflict('goal changes must start a new turn')
    return {'text': prepared['text'], 'metadata': prepared['metadata']}


def dispatch(method, parts, query, data, ctx):
    is_guide = len(parts) in (4, 5) and parts[:2] == ['api', 'sessions'] and parts[3] == 'steer'
    is_promotion = len(parts) == 6 and parts[:2] == ['api', 'sessions'] and parts[3] == 'queue' and parts[5] == 'send-now'
    if not is_guide and not is_promotion:
        return None
    if not plugin_runtime.is_enabled(ctx.get('state_dir'), 'sessions'):
        return 403, {'error': 'plugin disabled or dependency unavailable: sessions', 'plugin': 'sessions'}
    sid = parts[2]
    if not isinstance(sid, str) or not _SESSION_ID.fullmatch(sid):
        return 404, {'error': 'session not found'}
    body = data if isinstance(data, dict) else {}
    store = ctx['store']
    inbox = SteeringInbox(store) if is_guide else MessageQueue(store)
    try:
        with ctx['lock']:
            with inbox.session_lock(sid):
                session = store.load(sid)
                from .answer_question import _validate_workspace
                _validate_workspace(ctx, session)
                if is_guide and method == 'GET' and len(parts) == 4:
                    snapshot = inbox._snapshot_locked(sid)
                    return 200, {'pending_guidance': snapshot['queued_messages'], 'guidance_history': snapshot['queue_history']}
                if is_guide and method == 'DELETE' and len(parts) == 5:
                    result = inbox._cancel_locked(sid, parts[4])
                    if result == 'not_found':
                        return 404, {'error': 'current-turn input not found'}
                    if result == 'claimed':
                        return 409, {'error': 'current-turn input is already delivered'}
                    return 200, result
                if method != 'POST' or is_guide and len(parts) != 4:
                    return 405, {'error': 'method not allowed'}
                allowed = {'request_id', 'expected_turn_id'} | ({'text', 'prepared_token'} if is_guide else set())
                if set(body) - allowed or not isinstance(body.get('request_id'), str) or not _REQUEST_ID.fullmatch(body['request_id']):
                    return 400, {'error': 'expected request_id and expected_turn_id'}
                turn_id = body.get('expected_turn_id')
                if not isinstance(turn_id, str) or not turn_id or len(turn_id) > 128:
                    return 400, {'error': 'expected_turn_id is required'}
                fingerprint = _fingerprint({**body, **({'queue_id': parts[4]} if is_promotion else {})})
                if is_guide:
                    replay = inbox._replay_submission_locked(sid, body['request_id'], fingerprint)
                    if replay is not None:
                        return 202, {'id': replay['id'], 'item': replay, 'replayed': True}
                else:
                    # Receipt replay remains valid after old turn settles.
                    for row in inbox._read(sid)['items']:
                        promotion = row.get('promotion')
                        if isinstance(promotion, dict) and promotion.get('id') == body['request_id']:
                            if promotion.get('fingerprint') != fingerprint:
                                raise QueueConflict('request_id already used for different promotion')
                            if promotion.get('state') == 'released':
                                raise QueueConflict('previous send-now reservation was released; try again')
                            return 202, {**promotion['receipt'], 'replayed': True}
                if sid not in ctx.get('running', set()) or session.get('active_turn_id') != turn_id:
                    raise QueueConflict('active turn changed; refresh before submitting input')
                if session.get('pending_question') or session.get('status') == 'awaiting_user':
                    raise QueueConflict('answer the pending question before submitting input')
                if is_promotion:
                    receipt, replayed = reserve_promotion(inbox, sid, parts[4], body['request_id'], fingerprint, turn_id)
                    ctx.setdefault('stop_requested', set()).add(sid)
                    return 202, {**receipt, 'replayed': replayed}
                text = body.get('text')
                if not isinstance(text, str) or not 1 <= len(text.strip()) <= 5000 or '\x00' in text:
                    return 400, {'error': 'message must be 1..5000 characters'}
                token = body.get('prepared_token')
                if token is not None and (not isinstance(token, str) or not token or len(token) > 128):
                    return 400, {'error': 'prepared input invalid or expired'}
                prepared = _prepared_input(ctx, session, token)
                receipt, replayed = inbox.admit_locked(sid, text, turn_id, body['request_id'], fingerprint, prepared)
                return 202, {'id': receipt['id'], 'item': receipt, 'replayed': replayed}
    except FileNotFoundError:
        return 404, {'error': 'session or queued message not found'}
    except QueueConflict as error:
        return 409, {'error': str(error)}
    except (KeyError, TypeError, ValueError) as error:
        return 400, {'error': str(error)}
    except OSError:
        return 503, {'error': 'cannot persist current-turn input'}
