"""Parent-scoped result collection, contributed by the subagents plugin."""
from ...tool_contract import BuiltinTool, execution_context


def collect(root, gate, args, session, call_id):
    gate.check('planning', '')
    coordinator = execution_context().get('subagent_coordinator')
    if coordinator is None or coordinator.session is not session:
        return {'ok': False, 'error': 'task_collect requires an active parent delegation run'}
    return coordinator.collect(args)


def resume(root, gate, args, session, call_id):
    gate.check('planning', '')
    context = execution_context()
    coordinator = context.get('subagent_coordinator')
    if coordinator is None or coordinator.session is not session:
        return {'ok': False, 'error': 'task_resume requires an active parent run'}
    from ...tool_contract import authorize_tool_effect
    return coordinator.resume(call_id, args, before_start=lambda: authorize_tool_effect(
        context.get('state_dir'), session, context.get('store'), 'task_resume',
        'planning', args.get('task_id'), call_id))


def send_message(root, gate, args, session, call_id):
    gate.check('planning', '')
    context = execution_context()
    coordinator = context.get('subagent_coordinator')
    if coordinator is None or coordinator.session is not session:
        return {'ok': False, 'error': 'task_send_message requires an active parent run'}
    from ...tool_contract import authorize_tool_effect
    denial = authorize_tool_effect(context.get('state_dir'), session,
                                   context.get('store'), 'task_send_message',
                                   'planning', args.get('task_id'), call_id)
    if denial is not None:
        return denial
    return coordinator.send_message(args, request_id=call_id)


REGISTRY = (BuiltinTool(
    'task_collect',
    'Collect this parent turn\'s subagent results. Keep working independently after task dispatch. '
    'Default wait_seconds=0. Wait only for a dependency or when no independent work remains; '
    'provide reason and detail. Every child result must be collected before finalizing.',
    {'task_ids': {'type': 'array', 'items': {'type': 'string'}, 'maxItems': 8},
     'wait_seconds': {'type': 'number', 'minimum': 0, 'maximum': 30},
     'reason': {'type': 'string', 'enum': ['dependency', 'no_independent_work']},
     'detail': {'type': 'string', 'maxLength': 500}},
    (), 'planning', False, collect),
    BuiltinTool('task_resume',
                'Explicitly continue this parent\'s retained read-only child session. '
                'A completed child requires a followup message; cancelled children cannot resume. '
                'Returns a background receipt; collect its result with task_collect.',
                {'task_id': {'type': 'string'}, 'message': {'type': 'string', 'minLength': 1, 'maxLength': 24000}},
                ('task_id',), 'planning', False, resume),
    BuiltinTool('task_send_message',
                'Guide this parent\'s active child at its next safe provider/tool boundary. '
                'The child keeps its retained history and read-only permissions.',
                {'task_id': {'type': 'string'}, 'message': {'type': 'string', 'maxLength': 24000}},
                ('task_id', 'message'), 'planning', False, send_message))
