"""One journal read owns every row, outcome and mutation revision in a view."""
from ... import events
from .http_routes import public_session_payload
from .message_actions import revision
from .forking import ForkError


def snapshot(ctx, sid):
    session = ctx['store'].load(sid)
    if not isinstance(session, dict) or session.get('id') != sid or not isinstance(session.get('messages'), list):
        raise ForkError('saved conversation is invalid', 409)
    derived = events.derive_events(session)
    envelope = events.page_events(session, derived, 0, events.MAX_LIMIT)
    # Unlike cursor polling, this journal snapshot includes the complete
    # retained transcript. It never joins pages from later journal revisions.
    envelope.update(events=derived, nextCursor=events.head_seq(derived), hasMore=False)
    return {'session': public_session_payload(ctx, session),
            'journal': {**session, 'message_revision': revision(session)}, 'timeline': envelope}


def dispatch(method, parts, query, data, ctx):
    if method != 'GET' or len(parts) != 4 or parts[:2] != ['api', 'sessions'] or parts[3] != 'conversation':
        return None
    try:
        ctx['store']._path(parts[2])
        return 200, snapshot(ctx, parts[2])
    except ForkError as exc:
        return exc.status, {'error': str(exc)}
    except FileNotFoundError:
        return 404, {'error': 'session not found'}
    except (OSError, ValueError):
        return 500, {'error': 'cannot read conversation snapshot'}
