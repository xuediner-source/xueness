"""Trusted entrypoint for the sessions plugin."""


def register_cli(commands):
    from .cli import add_parsers
    from .operator_cli import add_session_parsers
    add_parsers(commands)
    add_session_parsers(commands)


def execute_cli(args, deps=None):
    from .cli import execute_cli as execute
    return execute(args, deps)


def dispatch(method, parts, query, data, ctx):
    from .sharing import dispatch as sharing_dispatch
    result = sharing_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .history import dispatch as history_dispatch
    result = history_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .live_updates import dispatch as live_dispatch
    result = live_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .steering import dispatch as steering_dispatch
    result = steering_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .search import dispatch as search_dispatch
    result = search_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .conversation_snapshot import dispatch as conversation_snapshot_dispatch
    result = conversation_snapshot_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .message_actions import dispatch as message_actions_dispatch
    result = message_actions_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .queue import dispatch as queue_dispatch
    result = queue_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .answer_question import dispatch as answer_question_dispatch
    result = answer_question_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .composer_api import dispatch as composer_dispatch
    result = composer_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .deltas import dispatch as delta_dispatch
    result = delta_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .event_resume import dispatch as event_resume_dispatch
    result = event_resume_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .sessions_api import dispatch as session_dispatch
    result = session_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .manual_compact import dispatch as compact_dispatch
    result = compact_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .http_routes import dispatch as http_dispatch
    return http_dispatch(method, parts, query, data, ctx)


def dispatch_page(parts, ctx):
    from .sharing import dispatch_page as share_page
    return share_page(parts, ctx)


def tools():
    from .tooling import REGISTRY
    return REGISTRY


def completion_requires_evidence(session, call_ids=()):
    from .completion_policy import requires_evidence
    return requires_evidence(session, call_ids)


def composer_capabilities():
    from .composer_capabilities import CAPABILITIES
    return CAPABILITIES


def prepare_session_save(store, session):
    from .history import prepare
    return prepare(store, session)


def commit_session_save(token):
    from .history import commit
    commit(token)


def before_model_request(session, store, state_dir=None, **kwargs):
    from .steering import before_model_request as splice
    return splice(session, store, state_dir, **kwargs)


def settle_turn(session, store, turn_id=None, **run_context):
    from .steering import settle_turn as settle
    settled = settle(session, store, turn_id)
    from .auto_title import settle_auto_title
    settle_auto_title(
        session, store, turn_id,
        provider=run_context.get('provider'),
        allow_model_requests=run_context.get('allow_model_requests') is True,
    )
    return settled
