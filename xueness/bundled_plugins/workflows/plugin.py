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
    from .dynamic_runs import DynamicRunError
    try:
        result = execute(args)
    except DynamicRunError as exc:
        # A dwf refusal is an answer, not a crash: reason, detail and status stay
        # machine-readable on stdout while the exit code still says "refused".
        print(json.dumps(exc.payload(), ensure_ascii=False, indent=2))
        return 1
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


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


def dynamic_runs_command(state_dir, store, session, argument):
    """Chat-loop face for ``/dwf``: the host hands over text, this plugin decides.

    One hook for CLI, HTTP and chat means the plugin switch, the session
    attribution and the refusal vocabulary exist exactly once. The chat loop
    already holds the session lease, and managing durable runs never takes it.
    """
    from . import dynamic_runs
    return dynamic_runs.chat(state_dir, store, session, argument)
