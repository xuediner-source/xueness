"""Durable local DAGs and background jobs, shared by CLI and Web.

Each workflow has one owner process and atomically persisted node outcomes.
Command nodes hold a workspace lease; their argv is explicitly approved when
starting the immutable plan. This is process control, not an OS sandbox.
"""
from __future__ import annotations
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from ... import file_lock as fcntl
from .desktop_lifecycle import owner_gone, register as register_desktop_worker
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ID = re.compile(r'^[a-f0-9]{32}$')
NODE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
ACTIVE = {'queued', 'running', 'stopping', 'pausing'}
_FINGERPRINT_FILE_LIMIT = 10000
_FINGERPRINT_BYTE_LIMIT = 256 * 1024 * 1024


def _replace_state_file(temporary, destination):
    """Keep atomic writes despite brief Windows read/scan handles.

    A normal Windows file reader can deny deletion while it is open, making
    replace fail even though the complete new record is ready. Retry only
    those sharing/access errors, for at most half a second; do not truncate
    the previous record or conceal persistent write failures.
    """
    deadline = time.monotonic() + .5
    while True:
        try:
            os.replace(temporary, destination)
            return
        except OSError as error:
            remaining = deadline - time.monotonic()
            if (os.name != 'nt' or getattr(error, 'winerror', None) not in (5, 32, 33)
                    or remaining <= 0):
                raise
            time.sleep(min(.01, remaining))


def workspace_fingerprint(root, state_dir=None):
    """Hash workspace files for conservative cross-run result reuse.

    The snapshot is intentionally all-files rather than a guessed command
    read-set: arbitrary approved argv may read any path. If a workspace is too
    large or changes while being read, return ``None`` and disable reuse.
    """
    root = Path(root).resolve()
    ignored = Path(state_dir).resolve() if state_dir is not None else None
    digest = hashlib.sha256()
    count = total = 0
    try:
        for current, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d != '.git' and
                             (ignored is None or (Path(current) / d).resolve() != ignored))
            for name in sorted(dirs + files):
                path = Path(current) / name
                if ignored is not None and path.resolve() == ignored:
                    continue
                rel = path.relative_to(root).as_posix()
                info = path.lstat()
                digest.update(rel.encode('utf-8', 'surrogateescape') + b'\0')
                if path.is_symlink():
                    digest.update(b'L' + os.readlink(path).encode('utf-8', 'surrogateescape'))
                    continue
                if not path.is_file():
                    digest.update(b'D')
                    continue
                count += 1
                total += info.st_size
                if count > _FINGERPRINT_FILE_LIMIT or total > _FINGERPRINT_BYTE_LIMIT:
                    return None
                digest.update(f'F:{info.st_size}:{info.st_mtime_ns}:{info.st_mode & 0o777}\0'.encode())
                with path.open('rb') as stream:
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
                if path.stat().st_mtime_ns != info.st_mtime_ns:
                    return None
        return digest.hexdigest()
    except OSError:
        return None


def workflow_plan_digest(record):
    body = json.dumps({'root': record['root'], 'plan': record['plan']},
                      sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(body.encode('utf-8')).hexdigest()


class ProviderGovernor:
    """Cross-process AIMD slots with round-robin fairness between workflows."""
    def __init__(self, state, default_limit=2):
        self.state = Path(state).resolve()
        self.path = self.state / '.workflow-provider-governor.json'
        self.lock_path = self.state / '.workflow-provider-governor.lock'
        self.default_limit = default_limit

    @contextmanager
    def _locked(self):
        self.state.mkdir(parents=True, exist_ok=True)
        if self.path.is_symlink() or self.lock_path.is_symlink():
            raise ValueError('provider governor state cannot be a symlink')
        fd = os.open(self.lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'a+b') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            try:
                if self.path.exists():
                    raw = self.path.read_bytes()
                    if len(raw) > 1_000_000:
                        raise ValueError('provider governor state too large')
                    data = json.loads(raw)
                    if not isinstance(data, dict) or not isinstance(data.get('buckets'), dict):
                        raise ValueError('invalid provider governor state')
                else:
                    data = {'buckets': {}}
                yield data
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def _bucket(self, data, key):
        bucket = data['buckets'].setdefault(key, {'limit': self.default_limit, 'active': {},
            'queue': [], 'last_owner': None, 'failures': 0, 'cooldown_until': 0.0})
        if (type(bucket.get('limit')) is not int or not isinstance(bucket.get('active'), dict)
                or not isinstance(bucket.get('queue'), list)):
            raise ValueError('invalid provider governor bucket')
        now = time.time()
        bucket['active'] = {tid: lease for tid, lease in bucket['active'].items()
                            if isinstance(lease, dict) and now - lease.get('at', now) < 7200}
        bucket['queue'] = [item for item in bucket['queue'] if isinstance(item, dict)
                           and now - item.get('at', now) < 3600]
        return bucket

    def _save(self, data):
        fd, temporary = tempfile.mkstemp(dir=self.state, prefix='.provider-governor-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(data, stream, ensure_ascii=False)
                stream.flush(); os.fsync(stream.fileno())
            _replace_state_file(temporary, self.path)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)

    def enqueue(self, key, owner, ticket):
        with self._locked() as data:
            bucket = self._bucket(data, key)
            if not any(item.get('id') == ticket for item in bucket['queue']) and ticket not in bucket['active']:
                bucket['queue'].append({'id': ticket, 'owner': owner, 'at': time.time()})
                if len(bucket['queue']) > 10000:
                    bucket['queue'] = bucket['queue'][-10000:]
            self._save(data)

    def try_acquire(self, key, ticket):
        with self._locked() as data:
            bucket = self._bucket(data, key)
            now = time.time()
            if now < bucket.get('cooldown_until', 0) or len(bucket['active']) >= bucket['limit']:
                self._save(data); return False
            owners = list(dict.fromkeys(item['owner'] for item in bucket['queue']))
            if not owners:
                self._save(data); return False
            last = bucket.get('last_owner')
            if last in owners and len(owners) > 1:
                owner = owners[(owners.index(last) + 1) % len(owners)]
            else:
                owner = owners[0]
            winner = next(item for item in bucket['queue'] if item['owner'] == owner)
            if winner['id'] != ticket:
                self._save(data); return False
            bucket['queue'].remove(winner)
            bucket['active'][ticket] = {'owner': owner, 'at': now}
            bucket['last_owner'] = owner
            self._save(data)
            return True

    def finish(self, key, ticket, success=None, *, congestion=False, retry_after=None):
        with self._locked() as data:
            bucket = self._bucket(data, key)
            bucket['active'].pop(ticket, None)
            if success is True:
                bucket['limit'] = min(8, bucket['limit'] + 1)
                bucket['failures'] = 0
                bucket['cooldown_until'] = 0.0
            elif congestion or success is False:
                bucket['limit'] = max(1, bucket['limit'] // 2)
                bucket['failures'] = min(10, bucket.get('failures', 0) + 1)
                fallback = min(30.0, 0.5 * (2 ** (bucket['failures'] - 1)))
                delay = max(0.0, min(120.0, float(retry_after))) if retry_after is not None else fallback
                bucket['cooldown_until'] = time.time() + delay
            self._save(data)

    def cancel(self, key, ticket):
        with self._locked() as data:
            bucket = self._bucket(data, key)
            bucket['queue'] = [item for item in bucket['queue'] if item.get('id') != ticket]
            bucket['active'].pop(ticket, None)
            self._save(data)


def validate_plan(value, root):
    root = Path(root).resolve()
    if not isinstance(value, dict) or set(value) - {'name', 'nodes', 'concurrency'}:
        raise ValueError('plan fields: name, nodes, concurrency')
    nodes = value.get('nodes')
    concurrency = value.get('concurrency', 2)
    if type(concurrency) is not int or not 1 <= concurrency <= 8:
        raise ValueError('concurrency must be 1..8')
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= 64:
        raise ValueError('nodes must contain 1..64 entries')
    clean, ids = [], set()
    for node in nodes:
        if not isinstance(node, dict) or set(node) - {'id', 'needs', 'kind', 'argv', 'prompt', 'cwd', 'timeout', 'provider_id', 'model', 'writable', 'phase'}:
            raise ValueError('invalid node fields')
        name = node.get('id')
        if not isinstance(name, str) or not NODE.fullmatch(name) or name in ids:
            raise ValueError('node ids must be unique names')
        ids.add(name)
        kind = node.get('kind', 'command')
        if kind not in ('command', 'agent'):
            raise ValueError('kind must be command or agent')
        needs = node.get('needs', [])
        if not isinstance(needs, list) or any(not isinstance(n, str) for n in needs) or len(needs) != len(set(needs)):
            raise ValueError('needs must be unique node ids')
        if not isinstance(node.get('cwd', '.'), str):
            raise ValueError('node cwd must be a string')
        cwd = (root / node.get('cwd', '.')).resolve()
        if not cwd.is_relative_to(root) or not cwd.is_dir():
            raise ValueError('node cwd must be an existing directory inside root')
        timeout = node.get('timeout', 300)
        if type(timeout) not in (int, float) or not 0 < timeout <= 3600:
            raise ValueError('node timeout must be 0..3600 seconds')
        out = dict(node, kind=kind, needs=needs, cwd=str(cwd.relative_to(root)), timeout=timeout)
        if kind == 'command':
            argv = node.get('argv')
            if not isinstance(argv, list) or not argv or len(argv) > 128 or any(not isinstance(x, str) or '\0' in x or len(x) > 16000 for x in argv) or not argv[0]:
                raise ValueError('command argv must be a nonempty string array')
        elif not isinstance(node.get('prompt'), str) or not 1 <= len(node['prompt']) <= 5000:
            raise ValueError('agent prompt must be 1..5000 characters')
        if 'writable' in node and (type(node['writable']) is not bool or kind != 'agent'):
            raise ValueError('writable is an explicit boolean opt-in for agent nodes only')
        if 'phase' in node and (not isinstance(node['phase'], str) or not node['phase'].strip() or len(node['phase']) > 120):
            raise ValueError('phase must be a nonempty title up to 120 characters')
        for key in ('provider_id', 'model'):
            if key in node and (not isinstance(node[key], str) or not node[key] or len(node[key]) > 200):
                raise ValueError('invalid model selection')
        clean.append(out)
    done = set()
    while len(done) < len(ids):
        ready = [n['id'] for n in clean if n['id'] not in done and set(n['needs']) <= done]
        if not ready:
            raise ValueError('dependency cycle or unknown dependency')
        done.update(ready)
    return {'name': str(value.get('name', 'Workflow'))[:120], 'nodes': clean, 'concurrency': concurrency}


class WorkflowStore:
    def __init__(self, state):
        self.state = Path(state).resolve()
        self.directory = self.state / 'workflows'
        if self.directory.is_symlink():
            raise ValueError('workflow directory cannot be a symlink')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def path(self, wid, suffix='.json'):
        if not isinstance(wid, str) or not ID.fullmatch(wid):
            raise ValueError('invalid workflow id')
        path = self.directory / (wid + suffix)
        if path.is_symlink():
            raise ValueError('workflow file cannot be a symlink')
        return path

    @contextmanager
    def lock(self, wid, suffix='.lock', blocking=True, *, shared=False):
        fd = os.open(self.path(wid, suffix), os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            mode = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
            fcntl.flock(fd, mode | (0 if blocking else fcntl.LOCK_NB))
            yield
        finally:
            os.close(fd)

    def load(self, wid):
        # Coordinate API/worker readers with replacements. Windows can also
        # reject a new open while an old destination is being replaced.
        with self.lock(wid, shared=True):
            return self._load_unlocked(wid)

    def _load_unlocked(self, wid):
        return json.loads(self.path(wid).read_text(encoding='utf-8'))

    def save(self, record):
        with self.lock(record['id']):
            self._save_unlocked(record)

    def _save_unlocked(self, record):
        path = self.path(record['id'])
        fd, temporary = tempfile.mkstemp(dir=self.directory, prefix='.workflow-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(record, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            _replace_state_file(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def update(self, wid, change):
        with self.lock(wid):
            record = self._load_unlocked(wid)
            change(record)
            record['updated_at'] = time.time()
            self._save_unlocked(record)
            return record

    def event(self, record, kind, **fields):
        record['sequence'] = record.get('sequence', 0) + 1
        record.setdefault('events', []).append({'seq': record['sequence'], 'at': time.time(), 'type': kind, **fields})
        record['events'] = record['events'][-500:]

    def create(self, plan, root, reuse=None):
        root = Path(root).resolve()
        plan = validate_plan(plan, root)
        wid = uuid.uuid4().hex
        nodes = {n['id']: {'status': 'pending', 'attempts': 0} for n in plan['nodes']}
        record = {'id': wid, 'root': str(root), 'plan': plan, 'status': 'created', 'nodes': nodes,
                  'concurrency': plan['concurrency'], 'control': 'run', 'created_at': time.time(),
                  'updated_at': time.time(), 'events': [], 'sequence': 0,
                  'cache_fingerprint': workspace_fingerprint(root, self.state)}
        record['plan_digest'] = workflow_plan_digest(record)
        if reuse:
            previous = self.load(reuse)
            if previous['status'] in ACTIVE or previous['root'] != str(root):
                raise ValueError('reuse requires a settled run in the same workspace')
            current_fingerprint = workspace_fingerprint(root, self.state)
            fingerprint_matches = (current_fingerprint is not None and
                                   previous.get('cache_fingerprint') == current_fingerprint)
            old_specs = {n['id']: n for n in previous['plan']['nodes']}
            reusable = set()
            while True:
                added = False
                for n in plan['nodes']:
                    old = previous['nodes'].get(n['id'], {})
                    if fingerprint_matches and n['id'] not in reusable and old_specs.get(n['id']) == n and old.get('status') == 'completed' and set(n['needs']) <= reusable:
                        nodes[n['id']] = {**old, 'reused_from': reuse}
                        reusable.add(n['id'])
                        added = True
                if not added:
                    break
            record['reused_from'] = reuse
            record['reuse_cache_valid'] = fingerprint_matches
        self.event(record, 'created')
        self.save(record)
        return record

    def amend(self, wid, plan, root):
        """Amend a settled workflow in place and invalidate prior approval/results."""
        root = Path(root).resolve()
        plan = validate_plan(plan, root)
        def change(record):
            if record['status'] in ACTIVE or record['status'] == 'awaiting_user':
                raise ValueError('pause or settle the workflow before amending it')
            if record['root'] != str(root):
                raise ValueError('workflow must stay in its original workspace')
            record['plan'] = plan
            record['plan_digest'] = workflow_plan_digest(record)
            record['nodes'] = {n['id']: {'status': 'pending', 'attempts': 0} for n in plan['nodes']}
            record['concurrency'] = plan['concurrency']
            record['control'] = 'run'
            record['status'] = 'created'
            record['cache_fingerprint'] = workspace_fingerprint(root, self.state)
            self.event(record, 'amended')
        return self.update(wid, change)

    def answer_actor(self, wid, node_id, answer):
        """Persist the operator's answer into the actor session transcript."""
        if not isinstance(answer, str) or not answer.strip() or len(answer) > 5000:
            raise ValueError('answer must be 1..5000 characters')
        record = self.load(wid)
        node = record.get('nodes', {}).get(node_id, {})
        if record.get('status') != 'awaiting_user' or node.get('status') != 'awaiting_user' or not node.get('session_id'):
            raise ValueError('workflow actor is not awaiting an answer')
        from ...core import Store, answer_session
        sessions = Store(self.directory / (wid + '-sessions'))
        session = sessions.load(node['session_id'])
        answer_session(session, sessions, answer)
        def change(row):
            row['nodes'][node_id]['status'] = 'pending'
            self.event(row, 'actor_answered', node=node_id, answer=answer[:1000])
            row['status'] = 'paused'
            row['control'] = 'pause'
        return self.update(wid, change)

    def list(self):
        result = []
        for p in self.directory.glob('*.json'):
            if not ID.fullmatch(p.stem) or p.is_symlink():
                continue
            try:
                r = self.load(p.stem)
                result.append({k: r[k] for k in ('id', 'status', 'created_at', 'updated_at', 'root', 'concurrency')} | {'name': r['plan']['name']})
            except (OSError, ValueError, KeyError):
                continue
        return sorted(result, key=lambda x: x['updated_at'], reverse=True)

    def launch(self, wid, approved=False, allow_real=False, expected_digest=None):
        # No overlapping owner, including another CLI or Web process.
        with self.lock(wid, '.runner', blocking=False):
            def prepare(r):
                if r['status'] in ACTIVE:
                    raise ValueError('run already active; recover a stale run first')
                if expected_digest is not None and workflow_plan_digest(r) != expected_digest:
                    raise ValueError('workflow plan changed after approval')
                if any(n['kind'] == 'command' for n in r['plan']['nodes']) and not approved:
                    raise ValueError('explicit approval of this plan is required')
                if any(n['kind'] == 'agent' for n in r['plan']['nodes']) and not allow_real:
                    raise ValueError('real model execution is not enabled')
                for n in r['nodes'].values():
                    if n['status'] != 'completed':
                        n['status'] = 'pending'
                r.update(status='queued', control='run')
                self.event(r, 'queued')
            self.update(wid, prepare)
            try:
                with open(os.devnull, 'wb') as sink:
                    worker_argv = ([sys.executable, '--worker', 'workflow', str(self.state), wid]
                                   if getattr(sys, 'frozen', False) else
                                   [sys.executable, '-m', 'xueness.workflow_worker', str(self.state), wid])
                    worker = subprocess.Popen(worker_argv,
                                     cwd=Path(__file__).resolve().parents[3],
                                     stdin=subprocess.DEVNULL, stdout=sink, stderr=sink,
                                     start_new_session=not bool(os.environ.get('XUENESS_DESKTOP_HOST')),
                                     creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0)
                    register_desktop_worker(worker, self, wid)
            except OSError:
                self.update(wid, lambda r: r.update(status='failed'))
                raise
        return self.load(wid)

    def control(self, wid, action, concurrency=None):
        if action == 'recover':
            with self.lock(wid, '.runner', blocking=False):
                def recover(r):
                    if r['status'] not in ACTIVE:
                        raise ValueError('only a stale active run can be recovered')
                    for n in r['nodes'].values():
                        if n['status'] == 'running':
                            n.update(status='interrupted', error='worker disappeared; effects may have occurred')
                    r.update(status='interrupted', control='pause')
                    self.event(r, 'recovered')
                return self.update(wid, recover)
        def apply(r):
            if action == 'concurrency':
                if type(concurrency) is not int or not 1 <= concurrency <= 8:
                    raise ValueError('concurrency must be 1..8')
                r['concurrency'] = concurrency
            elif action in ('pause', 'cancel'):
                if r['status'] not in ACTIVE:
                    raise ValueError('run is not active')
                r['control'] = action
                r['status'] = 'pausing' if action == 'pause' else 'stopping'
            else:
                raise ValueError('unknown control action')
            self.event(r, action, concurrency=r['concurrency'])
        return self.update(wid, apply)

    def log(self, wid, node):
        r = self.load(wid)
        if node not in r['nodes']:
            raise ValueError('node not found')
        p = self.path(wid, '.' + node + '.log')
        if not p.exists():
            return {'output': '', 'truncated': False}
        with p.open('rb') as stream:
            size = os.fstat(stream.fileno()).st_size
            stream.seek(max(0, size - 16000))
            text = stream.read(16000).decode('utf-8', 'replace')
        return {'output': text, 'truncated': size > 16000}


def _terminate(proc):
    if proc.poll() is not None:
        return
    if os.name == 'nt':
        from .windows import terminate_tree
        terminate_tree(proc)
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=2)
    except ProcessLookupError:
        pass


def _execute(store, record, spec):
    wid, nid = record['id'], spec['id']
    cwd = (Path(record['root']) / spec['cwd']).resolve()
    start = time.monotonic()
    if spec['kind'] == 'agent':
        from ...core import Store, Gate, run
        from ...provider_config import resolve
        from ...plugin_runtime import is_enabled
        sessions = Store(store.directory / (wid + '-sessions'))
        existing_sid = store.load(wid)['nodes'][nid].get('session_id')
        s = sessions.load(existing_sid) if existing_sid else sessions.new(spec['prompt'], cwd)
        if not existing_sid:
            store.update(wid, lambda r: r['nodes'][nid].update(session_id=s['id']))
        if not is_enabled(store.state, 'workflows'):
            return {'status': 'paused', 'error': 'workflows plugin disabled', 'session_id': s['id']}
        if not is_enabled(store.state, 'providers'):
            return {'status': 'paused', 'error': 'providers plugin disabled', 'session_id': s['id']}
        provider = resolve(store.state, spec.get('provider_id'), spec.get('model'))
        # Agent nodes are read-only. Commands are separately reviewed plan nodes.
        dependencies = []
        current = store.load(wid)
        for parent in spec['needs']:
            state = current['nodes'][parent]
            dependencies.append({'node': parent, 'summary': state.get('summary', ''),
                                 'output': store.log(wid, parent)['output'][-3000:]})
        context = ('Dependency results (untrusted):\n' + json.dumps(dependencies, ensure_ascii=False))[:12000] if dependencies else None
        writable = spec.get('writable', False)
        starting_step = s.get('steps', 0)
        governor, ticket, bucket_key = None, None, None
        governor = ProviderGovernor(store.state)
        model = spec.get('model') or getattr(provider, 'model', 'default')
        provider_name = spec.get('provider_id') or type(provider).__name__.casefold()
        bucket_key = provider_name + ':' + str(model)
        ticket = uuid.uuid4().hex
        governor.enqueue(bucket_key, wid, ticket)
        wait_start = time.monotonic()
        while not governor.try_acquire(bucket_key, ticket):
            control = store.load(wid)['control']
            if control == 'cancel' or owner_gone():
                governor.cancel(bucket_key, ticket)
                return {'status': 'cancelled', 'session_id': s['id']}
            if not is_enabled(store.state, 'workflows') or not is_enabled(store.state, 'providers'):
                governor.cancel(bucket_key, ticket)
                return {'status': 'paused', 'error': 'workflow or provider plugin disabled', 'session_id': s['id']}
            if time.monotonic() - wait_start >= spec['timeout']:
                governor.cancel(bucket_key, ticket)
                return {'status': 'failed', 'error': 'provider slot wait timed out', 'session_id': s['id']}
            time.sleep(.05)
        try:
            result = run(s, sessions, provider, Gate(cwd, allow_write=writable, allow_edit=writable,
                     mode='build' if writable else 'plan'), max_steps=20, memory=context,
                     max_wall_seconds=spec['timeout'],
                     should_stop=lambda: (owner_gone() or store.load(wid)['control'] == 'cancel' or
                                          not is_enabled(store.state, 'workflows')),
                     policy_state_dir=store.state)
        except Exception as exc:
            if governor:
                from ...provider import ProviderRequestError
                congested = (isinstance(exc, ProviderRequestError) and exc.status in (429, 503))
                governor.finish(bucket_key, ticket, None, congestion=congested,
                                retry_after=getattr(exc, 'retry_after', None) if congested else None)
            raise
        if governor:
            made_progress = result.get('steps', 0) > starting_step
            governor.finish(bucket_key, ticket, True if made_progress else None)
        if result['status'] == 'awaiting_user':
            return {'status': 'awaiting_user', 'question': result.get('pending_question', '')[:2000],
                    'summary': '', 'session_id': s['id']}
        return {'status': 'completed' if result['status'] == 'completed' else 'cancelled' if result['status'] == 'stopped' else 'paused' if result['status'] == 'paused' else 'failed',
                'summary': (result.get('completion') or {}).get('summary', '')[:4000], 'session_id': s['id']}
    # Shared ancestor/exclusive cwd locks serialize overlapping workspaces,
    # while disjoint node directories can run in parallel. Passed to children
    # so a lost owner cannot release the lease while its command still runs.
    lock_dir = store.directory / '.workspaces'
    if lock_dir.is_symlink():
        raise ValueError('invalid workspace lease directory')
    lock_dir.mkdir(exist_ok=True, mode=0o700)
    locks, proc = [], None
    try:
        for directory in [*reversed(cwd.parents), cwd]:
            key = hashlib.sha256(str(directory).encode()).hexdigest()
            lock_path = lock_dir / key
            if lock_path.is_symlink():
                raise ValueError('invalid workspace lease')
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            locks.append(fd)
            mode = fcntl.LOCK_EX if directory == cwd else fcntl.LOCK_SH
            while True:
                if owner_gone() or store.load(wid)['control'] == 'cancel':
                    return {'status': 'cancelled'}
                if time.monotonic() - start > spec['timeout']:
                    return {'status': 'failed', 'error': 'timeout waiting for workspace lease'}
                try:
                    fcntl.flock(fd, mode | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(.05)
        logpath = store.path(wid, '.' + nid + '.log')
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT')}
        if os.name == 'nt':
            from .windows import execute_command
            return execute_command(store, record, spec, cwd, logpath, env, start)
        proc = subprocess.Popen(spec['argv'], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
                                pass_fds=tuple(locks))
        store.update(wid, lambda r: r['nodes'][nid].update(pid=proc.pid))
        import selectors
        reason, total = None, 0
        os.set_blocking(proc.stdout.fileno(), False)
        with selectors.DefaultSelector() as selector, logpath.open('wb') as stream:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while True:
                if owner_gone() or store.load(wid)['control'] == 'cancel':
                    reason = 'cancelled'; break
                if time.monotonic() - start >= spec['timeout']:
                    reason = 'timeout'; break
                ready = selector.select(.05)
                if ready:
                    chunk = os.read(proc.stdout.fileno(), 8192)
                    if not chunk:
                        if proc.poll() is not None:
                            break
                        time.sleep(.05)
                        continue
                    if total < 2_000_000:
                        stream.write(chunk[:2_000_000-total]); stream.flush()
                    total += len(chunk)
                elif proc.poll() is not None:
                    break
        if reason:
            _terminate(proc)
        else:
            proc.wait(timeout=2)
        return {'status': 'cancelled' if reason == 'cancelled' else 'completed' if not reason and proc.returncode == 0 else 'failed',
                'exit_code': proc.returncode, 'error': reason or '', 'duration': time.monotonic()-start,
                'log_capped': total > 2_000_000}
    finally:
        if proc is not None:
            _terminate(proc)
            # A command must not leave descendants holding output/leases open.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.stdout.close()
        for fd in reversed(locks):
            os.close(fd)


def drive(store, wid, executor=None):
    execute = executor or _execute
    with store.lock(wid, '.runner'):
        record = store.load(wid)
        if record['status'] != 'queued':
            return
        store.update(wid, lambda r: (r.update(status='running'), store.event(r, 'started')))
        active = {}
        with ThreadPoolExecutor(max_workers=8) as pool:
            while True:
                r = store.load(wid)
                if owner_gone():
                    store.control(wid, 'cancel')
                from ...plugin_runtime import is_enabled
                try:
                    if not is_enabled(store.state, 'workflows'):
                        store.update(wid, lambda row: row.update(control='pause'))
                except (ValueError, OSError):
                    store.update(wid, lambda row: row.update(control='pause'))
                for nid, future in list(active.items()):
                    if not future.done():
                        continue
                    try:
                        result = future.result()
                    except Exception:
                        result = {'status': 'failed', 'error': 'node execution failed; inspect local configuration'}
                    def finish(row, nid=nid, result=result):
                        row['nodes'][nid].update(result, ended_at=time.time())
                        store.event(row, 'node_finished', node=nid, status=result['status'])
                    store.update(wid, finish)
                    del active[nid]
                r = store.load(wid)
                if r['control'] == 'run':
                    for spec in r['plan']['nodes']:
                        if len(active) >= r['concurrency']:
                            break
                        nid = spec['id']
                        if r['nodes'][nid]['status'] != 'pending':
                            continue
                        if not all(r['nodes'][p]['status'] == 'completed' for p in spec['needs']):
                            continue
                        def begin(row, nid=nid):
                            row['nodes'][nid].update(status='running', started_at=time.time(), attempts=row['nodes'][nid]['attempts']+1)
                            store.event(row, 'node_started', node=nid)
                        store.update(wid, begin)
                        active[nid] = pool.submit(execute, store, r, spec)
                if not active:
                    r = store.load(wid)
                    if r['control'] == 'pause':
                        status = 'paused'
                    elif r['control'] == 'cancel':
                        status = 'cancelled'
                    elif any(n['status'] == 'awaiting_user' for n in r['nodes'].values()):
                        status = 'awaiting_user'
                    elif any(n['status'] == 'paused' for n in r['nodes'].values()):
                        status = 'paused'
                    elif all(n['status'] == 'completed' for n in r['nodes'].values()):
                        status = 'completed'
                    else:
                        status = 'failed'
                    def settle(row):
                        row.update(status=status)
                        for n in row['nodes'].values():
                            if n['status'] == 'pending' and status == 'failed':
                                n['status'] = 'blocked'
                        store.event(row, 'settled', status=status)
                        if status not in ACTIVE:
                            row['cache_fingerprint'] = workspace_fingerprint(row['root'], store.state)
                    store.update(wid, settle)
                    return
                time.sleep(.05)
