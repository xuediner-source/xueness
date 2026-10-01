"""Project memory metadata and the shared Web run injection preference."""
from pathlib import Path

from .memory_api import memory_root, track_entries
from .memory import load


def workspace_roots(ctx):
    roots = {str(Path(ctx.get('memory_cwd') or ctx['project_dir']).resolve())}
    roots.update(str(Path(path).resolve()) for path in ctx.get('workspace_roots', ()))
    from ..settings.workspaces_api import selected_roots
    roots.update(str(path) for path in selected_roots(ctx))
    store = ctx.get('store')
    if store:
        for summary in store.list():
            try:
                root = store.load(summary['id']).get('root')
            except (FileNotFoundError, ValueError):
                continue
            if isinstance(root, str):
                roots.add(str(Path(root).resolve()))
    return sorted(roots)


def scoped_context(ctx, query):
    root = query.get('root')
    if isinstance(root, list):
        if len(root) != 1:
            raise ValueError('invalid memory workspace')
        root = root[0]
    if root is None:
        return ctx
    if not isinstance(root, str) or len(root) > 4096 or '\0' in root:
        raise ValueError('invalid memory workspace')
    canonical = str(Path(root).resolve())
    if canonical not in workspace_roots(ctx):
        raise ValueError('unknown memory workspace')
    return {**ctx, 'memory_cwd': canonical}


def load_run_memory(ctx, root):
    """Only the configured memory store is read; no memory is journaled here."""
    from ...plugin_runtime import is_enabled
    from ..settings.settings_store import load_settings
    if not is_enabled(ctx['state_dir'], 'memory'):
        return None
    if load_settings(ctx['state_dir']).get('general', {}).get('memoryEnabled') is False:
        return None
    memory = memory_root()
    return (load(memory, str(Path(root).resolve())) or None) if memory else None


def dispatch(method, parts, query, data, ctx):
    if method != 'GET' or parts != ['api', 'memory', 'workspaces']:
        return None
    if memory_root() is None:
        return 200, {'workspaces': [], 'configured': False}
    workspaces = []
    for root in workspace_roots(ctx):
        files = []
        for track in track_entries({**ctx, 'memory_cwd': root}):
            if not track['present']:
                continue
            path = Path(track['path'])
            try:
                if path.is_symlink() or not path.resolve().is_relative_to(memory_root().resolve()):
                    continue
                updated = path.stat().st_mtime_ns // 1_000_000
            except OSError:
                continue
            files.append({**track, 'fileName': path.name, 'updatedAt': updated})
        if files:
            workspaces.append({'id': root, 'label': Path(root).name or root, 'files': files})
    return 200, {'workspaces': workspaces, 'configured': True}
