"""Trusted runtime profile and JSONL protocol entrypoint."""

from ... import plugin_runtime

from .runtime import (PROTOCOL_NAME, PROTOCOL_VERSION, load_selection,
                      normalize_selection, profile_rows, save_selection)


def register_cli(commands):
    import argparse
    commands.add_parser('pi-lite-worker', help=argparse.SUPPRESS)


def execute_cli(args):
    """The bundled worker entry also works in a frozen backend executable."""
    import os
    from pathlib import Path
    from .pi_sidecar_process import main
    os.environ['XUENESS_PI_LITE_STATE_DIR'] = str(Path(args.state).absolute())
    return main()


def dispatch(method, parts, query, data, ctx):
    del query
    if parts == ['api', 'runtimes', 'v4']:
        if ctx.get('state_dir') is None:
            return 500, {'error': 'runtime state directory is unavailable'}
        if not plugin_runtime.is_enabled(ctx['state_dir'], 'sessions'):
            return 403, {'error': 'plugin disabled or dependency unavailable: sessions', 'plugin': 'sessions'}
        from .zcode_v4 import create_adapter
        adapter = create_adapter(ctx)
        try:
            if method == 'POST' and isinstance(data, dict) and data.get('kind') == 'clientHello':
                return 200, adapter.hello(data)
            if method == 'POST' and isinstance(data, dict) and data.get('kind') == 'subscribe':
                ack, frame = adapter.subscribe(data.get('params', {}), wait_ms=data.get('waitMs', 0))
                return 200, {'ack': ack, 'frame': frame}
            if method == 'POST' and isinstance(data, dict) and data.get('kind') == 'conversationPage':
                return 200, adapter.conversation_page(data.get('params', {}))
            if method == 'POST' and isinstance(data, dict) and data.get('kind') == 'command':
                return 200, adapter.command(data.get('envelope', {}))
            if method == 'POST' and isinstance(data, dict) and data.get('kind') == 'commandsQuery':
                return 200, {'results': adapter.query_commands(data.get('keys', []))}
        except plugin_runtime.PluginDisabled as exc:
            return 403, {'error': str(exc), 'code': 'plugin_disabled'}
        except KeyError as exc:
            return 404, {'error': str(exc).strip("'")}
        except (OSError, TimeoutError, ValueError) as exc:
            return 400, {'error': str(exc)}
        return 405, {'error': 'method not allowed'}
    if parts not in (['api', 'runtimes'], ['api', 'runtimes', 'select']):
        return None
    state_dir = ctx.get('state_dir')
    if state_dir is None:
        return 500, {'error': 'runtime state directory is unavailable'}
    if method == 'GET' and parts == ['api', 'runtimes']:
        try:
            active = load_selection(state_dir)
        except (OSError, ValueError) as exc:
            return 500, {'error': str(exc)}
        selection = next(row for row in profile_rows(active) if row['id'] == active)
        return 200, {'protocolName': PROTOCOL_NAME,
                      'protocolVersion': PROTOCOL_VERSION, 'active': active,
                      'profile': selection, 'profiles': profile_rows(active)}
    if method == 'POST' and parts == ['api', 'runtimes', 'select']:
        if not isinstance(data, dict) or set(data) != {'profile'}:
            return 400, {'error': 'expected profile string only'}
        try:
            selection = save_selection(state_dir, data['profile'])
        except (OSError, TypeError, ValueError) as exc:
            return 400, {'error': str(exc)}
        active = selection['profile']
        # A profile switch revokes the optional local child boundary before
        # returning success; no pi-lite process may survive in zcode-full.
        if active != 'pi-lite':
            supervisor = ctx.get('pi_lite_sidecar')
            if supervisor is not None:
                supervisor.close_all()
        selected = next(row for row in profile_rows(active) if row['id'] == active)
        return 200, {'protocolName': PROTOCOL_NAME,
                      'protocolVersion': PROTOCOL_VERSION, 'active': active,
                      'profile': selected, 'profiles': profile_rows(active)}
    return 405, {'error': 'method not allowed'}


def activate(scope, ctx):
    """Own optional pi-lite child processes for the plugin lifetime.

    The supervisor is deliberately not exposed as an HTTP command surface:
    launching an argv is a trusted local integration decision, while the
    public runtime API only selects a profile and speaks the v4 adapter.
    """
    from .pi_sidecar import create_pi_lite_sidecar

    def acquire():
        supervisor = ctx.get('pi_lite_sidecar')
        if supervisor is None:
            supervisor = create_pi_lite_sidecar(ctx)
            ctx['pi_lite_sidecar'] = supervisor
        return supervisor

    def release(supervisor):
        supervisor.close_all()
        if ctx.get('pi_lite_sidecar') is supervisor:
            ctx['pi_lite_sidecar'] = None

    scope.ensure('runtimes.pi_lite_sidecar', acquire, release,
                 live=lambda service: ctx.get('pi_lite_sidecar') is service)
