"""Desktop-owned backend lifecycle and trusted platform metadata."""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys
import threading
from .bridge import DesktopBridge


def desktop_status(ctx):
    from ... import __version__
    return {'desktop': bool(ctx.get('desktop_token')), 'platform': sys.platform,
            'version': __version__, 'frozen': bool(getattr(sys, 'frozen', False)),
            'dataDirectory': str(Path(ctx['state_dir']).parent),
            'nativeDirectoryPicker': callable(ctx.get('desktop_choose_directory'))}


def main(argv=None):
    from ... import web, plugin_runtime
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--assets', type=Path)
    args = parser.parse_args(argv)
    token = os.environ.pop('XUENESS_DESKTOP_TOKEN', '')
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        raise ValueError('desktop parent authentication is missing')
    data = args.data.expanduser().resolve()
    os.environ['XUENESS_DESKTOP_OWNER_PID'] = str(os.getpid())
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    project = data/'workspace'
    project.mkdir(exist_ok=True)
    ctx = web.build_context(data/'state', data/'runs', project,
                            allow_real=os.environ.get('XUENESS_ALLOW_REAL', '1') == '1')
    ctx['webapp_dir'] = args.assets.resolve() if args.assets else Path(__file__).resolve().parents[3]/'webapp/dist'
    ctx['desktop_token'] = token
    bridge = DesktopBridge(sys.stdout)
    from ..updates.desktop_updates import bind_desktop
    bind_desktop(ctx, bridge)

    def choose(initial_root):
        plugin_runtime.require_enabled(ctx['state_dir'], 'desktop')
        return bridge.choose_directory(initial_root)

    ctx['desktop_choose_directory'] = choose
    server = web.create_server(0, ctx)
    runner = threading.Thread(target=server.serve_forever, daemon=True)
    runner.start()
    bridge.send({'type': 'ready', 'url': f'http://127.0.0.1:{server.server_address[1]}',
                 'instance': secrets.token_hex(16)})
    try:
        for line in sys.stdin:
            if len(line) > 65536:
                break
            try:
                message = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(message, dict):
                continue
            if message.get('type') == 'shutdown':
                break
            bridge.receive(message)
    finally:
        bridge.close()
        from ..workflows.desktop_lifecycle import shutdown
        shutdown()
        server.shutdown()
        server.server_close()
        runner.join(timeout=5)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
