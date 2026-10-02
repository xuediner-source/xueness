"""Application update controls over the authenticated parent pipe, never arbitrary installers."""
from ... import plugin_runtime

ACTIONS = frozenset({'status', 'check', 'download', 'install', 'cancel'})


def settings(ctx):
    from pathlib import Path
    import json
    path = Path(ctx['state_dir']) / 'updates-settings.json'
    if path.is_symlink():
        return {'autoDownload': False}
    try:
        with path.open('rb') as stream:
            data = json.loads(stream.read(4097))
        return {'autoDownload': data.get('autoDownload') is True} if isinstance(data, dict) else {'autoDownload': False}
    except FileNotFoundError:
        return {'autoDownload': True}
    except (OSError, ValueError):
        return {'autoDownload': False}


def bind_desktop(ctx, bridge):
    ctx['update_bridge'] = bridge
    def policy_sync():
        enabled = (plugin_runtime.is_enabled(ctx['state_dir'], 'updates') and
                   plugin_runtime.is_enabled(ctx['state_dir'], 'desktop'))
        auto = settings(ctx)['autoDownload']
        if ctx.get('update_policy') != (enabled, auto):
            ctx['update_policy'] = (enabled, auto)
            bridge.send({'type': 'update-policy', 'enabled': enabled, 'autoDownload': auto})
    ctx['native_policy_sync'] = policy_sync
    policy_sync()


def prepare_install(ctx, *, check_only=False):
    """Admission closes before the host drains its owned backend/process tree."""
    from ..workflows.workflows import WorkflowStore
    with ctx['lock']:
        if any(path not in ('/api/updates/install', '/api/updates/prepare-install') for path in ctx.get('active_mutations', {}).values()):
            return 409, {'ok': False, 'reason': '还有正在处理的操作，请稍后重启更新。'}
        if ctx.get('running'):
            return 409, {'ok': False, 'reason': '请先结束正在运行的会话，再重启更新。'}
        if any(row.get('status') == 'running' for row in WorkflowStore(ctx['state_dir']).list()):
            return 409, {'ok': False, 'reason': '请先结束后台工作流，再重启更新。'}
        broker = ctx.get('terminals')
        if broker is not None:
            with broker.lock:
                if any(not term.closed for term in broker.items.values()):
                    return 409, {'ok': False, 'reason': '请先关闭交互式终端，再重启更新。'}
        registry = ctx.get('task_registry')
        if registry is not None and any(row.get('status') in ('running', 'pending') for row in registry.list()):
            return 409, {'ok': False, 'reason': '请先结束子任务，再重启更新。'}
        if check_only:
            return 200, {'ok': True}
        ctx['admission_closed'] = True
        scheduler = ctx.get('automation_service')
        ctx['automation_service'] = None
    if scheduler is not None:
        scheduler.close()
        if scheduler.thread.is_alive() or any(row.get('status') == 'running' for row in WorkflowStore(ctx['state_dir']).list()):
            with ctx['lock']:
                ctx['admission_closed'] = False
            return 409, {'ok': False, 'reason': '定时任务尚在运行，请稍后更新。'}
    return 200, {'ok': True}


def dispatch(method, parts, query, data, ctx):
    if ctx.get('handler') is not None:
        ctx = ctx['handler']._ctx
    if len(parts) != 3 or parts[:2] != ['api', 'updates']:
        return None
    if not ctx.get('desktop_token') or not ctx.get('update_bridge'):
        return 200 if method == 'GET' else 409, {'phase': 'unsupported', 'reason': '应用内更新需使用桌面安装版。', 'canInstall': False, 'canDownload': False, 'installMode': 'unsupported'}
    if not plugin_runtime.is_enabled(ctx['state_dir'], 'desktop'):
        return 403, {'error': 'desktop plugin disabled'}
    action = parts[2]
    if action == 'settings':
        if method == 'GET':
            return 200, settings(ctx)
        if method == 'POST' and set(data) == {'autoDownload'} and type(data['autoDownload']) is bool:
            from pathlib import Path
            from ...resources import _atomic_write_json
            _atomic_write_json(Path(ctx['state_dir']) / 'updates-settings.json', data)
            ctx['native_policy_sync']()
            return 200, settings(ctx)
        return 400, {'error': 'expected autoDownload boolean'}
    if action == 'policy' and method == 'GET':
        return 200, {'enabled': True}
    if action == 'prepare-install' and method == 'POST':
        if not (data == {} or set(data) == {'checkOnly'} and data['checkOnly'] is True):
            return 400, {'error': 'expected empty body'}
        return prepare_install(ctx, check_only=data.get('checkOnly') is True)
    if action not in ACTIONS or (method == 'GET') != (action == 'status') or method not in ('GET', 'POST'):
        return 405, {'error': 'method not allowed'}
    if set(data or {}) - {'version'}:
        return 400, {'error': 'expected version only'}
    version = (data or {}).get('version')
    if action in ('download', 'install'):
        import re
        if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
            return 400, {'error': 'invalid update version'}
    elif version is not None:
        return 400, {'error': 'unexpected version'}
    try:
        result = ctx['update_bridge'].request({'type': 'update', 'action': action, **({'version': version} if version else {})}, timeout=35)
        state = result.get('state')
        if not isinstance(state, dict):
            raise RuntimeError('invalid response')
        return 200, state
    except RuntimeError:
        return 503, {'error': '桌面更新服务暂不可用，请稍后重试。'}
