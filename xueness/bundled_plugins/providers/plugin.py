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


def before_model_request(session, provider=None, *, store=None, gate=None,
                         state_dir=None, **kwargs):
    """Providers owns semantic history preparation; the host owns persistence.

    ``gate`` belongs to the host callback contract. History summarization is a
    read-only provider request, so it deliberately receives no tool gate and
    cannot dispatch tools.
    """
    from .semantic_compaction import before_model_request as prepare
    return prepare(session, provider, store=store, state_dir=state_dir, **kwargs)
