"""Parent-scoped result collection, contributed by the subagents plugin."""
from ...tool_contract import BuiltinTool, execution_context


def collect(root, gate, args, session, call_id):
    gate.check('planning', '')
    coordinator = execution_context().get('subagent_coordinator')
    if coordinator is None or coordinator.session is not session:
        return {'ok': False, 'error': 'task_collect requires an active parent delegation run'}
    return coordinator.collect(args)


REGISTRY = (BuiltinTool(
    'task_collect',
    'Collect this parent turn\'s subagent results. Keep working independently after task dispatch. '
    'Default wait_seconds=0. Wait only for a dependency or when no independent work remains; '
    'provide reason and detail. Every child result must be collected before finalizing.',
    {'task_ids': {'type': 'array', 'items': {'type': 'string'}, 'maxItems': 8},
     'wait_seconds': {'type': 'number', 'minimum': 0, 'maximum': 30},
     'reason': {'type': 'string', 'enum': ['dependency', 'no_independent_work']},
     'detail': {'type': 'string', 'maxLength': 500}},
    (), 'planning', False, collect),)
