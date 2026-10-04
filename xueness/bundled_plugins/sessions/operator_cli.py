"""CLI session management and provider profiles using the shared stores."""
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from ... import session_management as sessions
from ...session_lease import lease
from ...resources import _is_link, _protect_private_file

EXPORT_FORMAT = "xueness-session-portable"
EXPORT_VERSION = 1
MAX_PORTABLE_BYTES = 4 * 1024 * 1024
MAX_PORTABLE_MESSAGES = 1000
MAX_PORTABLE_CHARS = 500_000
_SECRET_VALUE = re.compile(
    r"(?i)(?:(?:sk|rk)-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]{12,}|"
    r"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)\s*[:=]\s*['\"]?[^\s,;\"']{8,})"
)


def add_parsers(commands):
    add_session_parsers(commands)


def add_session_parsers(commands):
    session = commands.add_parser('sessions', help='search, rename, pin, archive and restore sessions')
    sub = session.add_subparsers(dest='action', required=True)
    listing = sub.add_parser('list')
    listing.add_argument('--archived', action='store_true')
    listing.add_argument('--root', type=Path)
    listing.add_argument('--search', default='')
    for action in ('rename', 'pin', 'unpin', 'archive', 'restore'):
        p = sub.add_parser(action)
        p.add_argument('id')
        if action == 'rename':
            p.add_argument('title')
    export = sub.add_parser('export', help='write a bounded redacted transcript into the local exports folder')
    export.add_argument('id')
    export.add_argument('--output', help='filename under <state>/exports (defaults to session id)')
    imported = sub.add_parser('import', help='import a safe transcript as a new session')
    imported.add_argument('file', type=Path)
    imported.add_argument('--root', type=Path, required=True, help='existing workspace for the new session')
    fork = sub.add_parser('fork', help='fork a session at a complete, safe user turn')
    fork.add_argument('id')
    fork.add_argument('--turn', type=int, help='closed turn ordinal (defaults to latest safe turn)')
    fork.add_argument('--title', help='title for the forked session')
    fork_checkpoint = sub.add_parser(
        'fork-checkpoint', help='fork the turns before an automatic workspace checkpoint')
    fork_checkpoint.add_argument('id')
    fork_checkpoint.add_argument('--checkpoint', help='turn checkpoint id (git turn-checkpoints list)')
    fork_checkpoint.add_argument('--latest', action='store_true', help='use the newest turn checkpoint')
    fork_checkpoint.add_argument('--turn', type=int, help='fork before this turn\'s checkpoint')
    fork_checkpoint.add_argument('--title', help='title for the forked session')


def add_provider_parsers(commands):
    """Compatibility forwarder; the providers plugin owns these commands."""
    from ..providers.operator_cli import add_parsers
    add_parsers(commands)


def list_sessions(store, *, root=None, search='', archived=False):
    items = sessions.list_archived(store) if archived else sessions.list_summaries(store)
    result = []
    for item in items:
        source = store.directory / 'deleted-sessions' if archived else store.directory
        try:
            session = json.loads((source / (item['id'] + '.json')).read_text())
            if root and Path(session['root']).resolve() != Path(root).resolve():
                continue
            item['root'] = session['root']
            if search.casefold() not in (item.get('title', '') + ' ' + item['id']).casefold():
                continue
            item['updatedAt'] = (source / (item['id'] + '.json')).stat().st_mtime
            result.append(item)
        except (OSError, ValueError, KeyError):
            continue
    return sorted(result, key=lambda x: (not x.get('pinned', False), -x['updatedAt']))


def _redact_text(value):
    from .cli_input import MULTIMODAL_MARKER
    text = value.split(MULTIMODAL_MARKER, 1)[0]
    return _SECRET_VALUE.sub('[REDACTED]', text)


def _portable_payload(store, sid):
    path = store._path(sid)
    if _is_link(path) or not path.is_file():
        raise ValueError('session not found or unsafe')
    if path.stat().st_size > MAX_PORTABLE_BYTES:
        raise ValueError('session is too large to export')
    session = store.load(sid)
    messages = []
    size = 0
    for message in session.get('messages', []):
        if not isinstance(message, dict) or message.get('role') not in ('user', 'assistant'):
            continue
        content = message.get('content')
        if not isinstance(content, str) or not content:
            continue
        safe = _redact_text(content)
        if len(safe) > 20_000:
            raise ValueError('session transcript contains a message over 20000 characters')
        size += len(safe)
        if len(messages) >= MAX_PORTABLE_MESSAGES or size > MAX_PORTABLE_CHARS:
            raise ValueError('session transcript exceeds export limits')
        messages.append({'role': message['role'], 'content': safe})
    return {'format': EXPORT_FORMAT, 'version': EXPORT_VERSION,
            'task': _redact_text(str(session.get('task', ''))),
            'title': _redact_text(str(session.get('title') or '')),
            'messages': messages}


def _write_new(path, content):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    if _is_link(path) or path.exists():
        raise ValueError('export destination already exists or is unsafe')
    fd, temporary = tempfile.mkstemp(prefix='.xueness-export-', dir=path.parent)
    try:
        try:
            _protect_private_file(fd)
        except BaseException:
            os.close(fd)
            raise
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        # Hard-link publishes atomically without replacing a file created in
        # the meantime; the temporary is removed in the finally block.
        os.link(temporary, path)
    except FileExistsError:
        raise ValueError('export destination already exists') from None
    finally:
        try:
            os.unlink(temporary)
        except OSError:
            pass


def export_session(store, sid, state_dir, filename=None):
    """Export only a bounded, redacted text transcript to a jailed folder."""
    name = filename or (sid + '.xueness.json')
    if (not isinstance(name, str) or not name or Path(name).name != name
            or name in ('.', '..') or len(name) > 160):
        raise ValueError('export filename must be a single safe filename')
    payload = _portable_payload(store, sid)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(encoded) > MAX_PORTABLE_BYTES:
        raise ValueError('redacted export exceeds size limit')
    directory = Path(state_dir).resolve() / 'exports'
    if _is_link(directory):
        raise ValueError('exports directory must not be a symlink')
    destination = directory / name
    _write_new(destination, encoded)
    return {'file': str(destination), 'bytes': len(encoded), 'messages': len(payload['messages'])}


def _read_portable(path):
    path = Path(path)
    if _is_link(path):
        raise ValueError('import file must not be a symlink')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        raise ValueError('import file is not readable') from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('import file must be a regular file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(MAX_PORTABLE_BYTES + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_PORTABLE_BYTES:
        raise ValueError('import file exceeds size limit')
    try:
        data = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise ValueError('import file is not valid UTF-8 JSON') from None
    return _validate_portable(data)


def _validate_portable(data):
    if (not isinstance(data, dict) or set(data) != {'format', 'version', 'task', 'title', 'messages'}
            or data.get('format') != EXPORT_FORMAT or data.get('version') != EXPORT_VERSION):
        raise ValueError('unsupported portable session format')
    task, title, messages = data['task'], data['title'], data['messages']
    if not isinstance(task, str) or not task.strip() or len(task) > 5000:
        raise ValueError('portable session task must be 1..5000 characters')
    if not isinstance(title, str) or len(title) > 120:
        raise ValueError('portable session title is invalid')
    if not isinstance(messages, list) or len(messages) > MAX_PORTABLE_MESSAGES:
        raise ValueError('portable session message count exceeds limit')
    clean, total = [], 0
    for item in messages:
        if (not isinstance(item, dict) or set(item) != {'role', 'content'}
                or item.get('role') not in ('user', 'assistant')
                or not isinstance(item.get('content'), str)):
            raise ValueError('portable session contains an invalid message')
        content = item['content']
        total += len(content)
        if len(content) > 20_000 or total > MAX_PORTABLE_CHARS:
            raise ValueError('portable session transcript exceeds limits')
        clean.append({'role': item['role'], 'content': _redact_text(content)})
    return _redact_text(task), _redact_text(title), clean


def import_session(store, path, root):
    """Import transcript-only data into a new, pending local session."""
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError('import workspace must be an existing directory')
    task, title, messages = _read_portable(path)
    return _import_payload(store, task, title, messages, root)


def _import_payload(store, task, title, messages, root):
    from ...core import SYSTEM
    session = store.new(task, root)
    session['messages'] = [{'role': 'system', 'content': SYSTEM}] + messages
    if title:
        session['title'] = title
    session['status'] = 'pending'
    session['steps'] = 0
    session['results'] = {}
    session['pending_question'] = None
    store.save(session)
    return {'id': session['id'], 'status': session['status'], 'messages': len(messages)}


def execute(args, store):
    if args.action == 'export':
        return export_session(store, args.id, args.state, args.output)
    if args.action == 'import':
        return import_session(store, args.file, args.root)
    if args.action == 'fork':
        from .forking import fork_turn
        return fork_turn({'store': store, 'lock': None, 'running': set()}, args.id,
                         turn=args.turn, title=args.title)
    if args.action == 'fork-checkpoint':
        from .forking import fork_at_checkpoint
        return fork_at_checkpoint({'store': store, 'lock': None, 'running': set()}, args.id,
                                  checkpoint=args.checkpoint, latest=args.latest,
                                  turn=args.turn, title=args.title)
    if args.action == 'list':
        return {'sessions': list_sessions(store, root=args.root, search=args.search, archived=args.archived)}
    with lease(store, args.id):
        if args.action == 'rename':
            s = sessions.rename(store, args.id, sessions.validate_title(args.title))
        elif args.action in ('pin', 'unpin'):
            s = sessions.pin(store, args.id, args.action == 'pin')
        elif args.action == 'archive':
            s = sessions.archive(store, args.id)
        else:
            s = sessions.restore(store, args.id)
    return {'id': s['id'], 'action': args.action}
