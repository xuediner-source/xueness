"""Trusted entrypoint for the workflows plugin."""
def dispatch(method, parts, query, data, ctx):
    from . import operations_api
    return operations_api.dispatch(method, parts, query, data, ctx)

def register_cli(commands):
    from .workflow_cli import add_parsers
    add_parsers(commands)


def execute_cli(args, deps=None):
    import json
    import sys
    from .workflow_cli import execute
    try:
        result = execute(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


def execute_slash(name, argument, ctx):
    """In-chat slash entry contributed through plugin_runtime.dispatch_slash.

    Only ``/expert`` is claimed here; ``/workflow`` and ``/jobs`` keep their
    CLI-only surface and fall through to the chat loop's existing behavior.
    """
    if name != 'expert':
        return None
    from . import expert
    return expert.handle_slash(argument, ctx)


def tools():
    from .tools import REGISTRY
    return REGISTRY
