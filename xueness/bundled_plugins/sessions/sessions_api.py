"""Bounded local portable-session API; transcripts carry no execution state."""
from pathlib import Path

from .operator_cli import (
    _import_payload, _portable_payload, _validate_portable,
)


def dispatch(method, parts, query, data, ctx):
    if not isinstance(parts, list) or len(parts) < 3 or parts[:2] != ['api', 'sessions']:
        return None
    store = ctx['store']
    if len(parts) == 4 and parts[3] == 'fork-boundaries' and method == 'GET':
        from .forking import ForkError, get_boundaries
        try:
            store._path(parts[2])
        except ValueError:
            return 404, {'error': 'session not found'}
        try:
            return 200, get_boundaries(ctx, parts[2])
        except ForkError as exc:
            return exc.status, {'error': str(exc)}
        except (OSError, ValueError):
            return 500, {'error': 'cannot read fork boundaries'}
    if len(parts) == 4 and parts[3] == 'fork' and method == 'POST':
        from .forking import ForkError, fork_at
        try:
            store._path(parts[2])
        except ValueError:
            return 404, {'error': 'session not found'}
        if (not isinstance(data, dict)
                or set(data) - {'boundary', 'revision', 'title'}
                or not {'boundary', 'revision'} <= set(data)
                or ('title' in data and not isinstance(data['title'], str))):
            return 400, {'error': 'expected boundary, revision, and optional title'}
        try:
            return 201, fork_at(ctx, parts[2], revision=data['revision'],
                                boundary_token=data['boundary'], title=data.get('title'))
        except ForkError as exc:
            return exc.status, {'error': str(exc)}
        except (OSError, ValueError):
            return 500, {'error': 'cannot fork session'}
    if len(parts) == 4 and parts[3] == 'fork-from-checkpoint' and method == 'POST':
        from .forking import ForkError, fork_at_checkpoint
        try:
            store._path(parts[2])
        except ValueError:
            return 404, {'error': 'session not found'}
        if (not isinstance(data, dict)
                or set(data) - {'checkpoint', 'latest', 'turn', 'title'}
                or ('title' in data and not isinstance(data['title'], str))):
            return 400, {'error': 'expected checkpoint or latest, and optional title'}
        try:
            return 201, fork_at_checkpoint(ctx, parts[2], checkpoint=data.get('checkpoint'),
                                           latest=bool(data.get('latest', False)),
                                           turn=data.get('turn'), title=data.get('title'))
        except ForkError as exc:
            return exc.status, {'error': str(exc)}
        except (OSError, ValueError):
            return 500, {'error': 'cannot fork session from checkpoint'}
    if method == 'GET' and len(parts) == 4 and parts[3] == 'export':
        try:
            payload = _portable_payload(store, parts[2])
            return 200, {'portableSession': payload}
        except (OSError, ValueError) as exc:
            return 404, {'error': str(exc)}
    if method == 'POST' and len(parts) == 3 and parts[2] == 'import':
        if not isinstance(data, dict) or set(data) != {'portableSession', 'root'}:
            return 400, {'error': 'expected portableSession and root'}
        try:
            if not isinstance(data['root'], str) or len(data['root']) > 4096:
                raise ValueError('invalid import workspace')
            from ...web import _allowed_root
            from ..settings.workspaces_api import allowed_roots
            root = _allowed_root(Path(data['root']), ctx['web_runs'], ctx['project_dir'],
                                 allowed_roots(ctx))
            task, title, messages = _validate_portable(data['portableSession'])
            result = _import_payload(store, task, title, messages, root)
            return 201, {'session': result}
        except (OSError, ValueError) as exc:
            return 400, {'error': str(exc)}
    return None
