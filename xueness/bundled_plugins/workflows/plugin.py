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


def tools():
    from .tools import REGISTRY
    return REGISTRY
