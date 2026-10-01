"""Trusted entrypoint for the providers plugin."""
def tools():
    from .tooling import REGISTRY
    return REGISTRY

def dispatch(method, parts, query, data, ctx):
    from . import providers_api
    return providers_api.dispatch(method, parts, query, data, ctx)


def register_cli(commands):
    from .operator_cli import add_parsers
    add_parsers(commands)


def execute_cli(args):
    import json
    import sys
    from .operator_cli import execute
    try:
        result = execute(args)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0
