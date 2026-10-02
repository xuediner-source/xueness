"""Trusted entrypoint for the planning plugin."""


def tools():
    from .tooling import REGISTRY
    from .delivery import TOOLS
    return REGISTRY + TOOLS


def completion_instructions(session):
    from .delivery import GUIDANCE, seed
    seed(session)
    import re
    return GUIDANCE if session.get('delivery_requirements') or re.search(r'报告|资料|research|report', session.get('task', ''), re.I) else ''


def completion_check(root, gate, session, summary, *, state_dir=None):
    from .delivery import check
    return check(root, gate, session, summary, state_dir=state_dir)


def dispatch(method, parts, query, data, ctx):
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
