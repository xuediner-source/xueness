"""Trusted entrypoint for the planning plugin."""


def tools():
    from .tooling import REGISTRY
    from .delivery import TOOLS
    return REGISTRY + TOOLS


def register_cli(commands):
    from .session_goal import add_parsers
    add_parsers(commands)


def execute_cli(args, deps=None):
    from .session_goal import execute_cli as execute
    return execute(args, deps)


def apply_session_goal(session, text, *, state_dir, replace=False, source='composer'):
    """Validate and stage a goal on an unsaved session; the caller persists it.

    Sessions owns when a session is written, so goal ownership stops at the
    in-memory record instead of duplicating a second save inside this plugin.
    """
    from .session_goal import set_goal
    return set_goal(session, text, state_dir=state_dir, replace=replace, source=source)


def session_goal_view(session):
    """Read-only goal view for the session payload; None when unusable."""
    from .session_goal import public
    return public(session)


def completion_instructions(session):
    from .delivery import GUIDANCE, requests_file_output, seed
    from .session_goal import reminder
    from .work_policy import instructions
    seed(session)
    guidance = (GUIDANCE if session.get('delivery_requirements')
                or requests_file_output(session.get('task', '')) else '')
    return '\n'.join(block for block in (instructions(session), guidance, reminder(session)) if block)


def completion_check(root, gate, session, summary, *, state_dir=None):
    from .delivery import check
    from .session_goal import merge_completion_check, verify
    return merge_completion_check(check(root, gate, session, summary, state_dir=state_dir),
                                 verify(session, summary))


def dispatch(method, parts, query, data, ctx):
    from .session_goal import dispatch as goal_dispatch
    result = goal_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    if len(parts) != 3 or parts[:2] != ['api', 'delivery']:
        return None
    try:
        with ctx['lock']:
            session = ctx['store'].load(parts[2])
            if method == 'GET':
                return 200, {'items': session.get('delivery_requirements', [])}
            if method != 'POST':
                return 405, {'error': 'method not allowed'}
            if session['id'] in ctx['running']:
                return 409, {'error': '请先停止运行，再编辑交付清单。'}
            if set(data) != {'items'}:
                return 400, {'error': 'expected items only'}
            from .delivery import normalize
            items = normalize(data['items']) if data['items'] else []
            session['delivery_requirements'] = items
            session['completion'] = None
            if session.get('status') == 'completed':
                session['status'] = 'paused'
            ctx['store'].save(session)
            return 200, {'items': items}
    except (OSError, ValueError) as exc:
        return 400, {'error': str(exc)}
