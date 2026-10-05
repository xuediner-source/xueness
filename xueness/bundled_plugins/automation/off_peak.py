"""Off-peak (闲时) task queue: defer a non-urgent prompt until a local idle window.

A queued task holds a prompt, the workspace it belongs to and an optional model
selection. The existing automation scheduler claims it once the configured window
is open, and the run is an ordinary single-agent workflow plan, so nothing here
grants a capability: unattended execution still needs the operator's approval of
the immutable plan digest, and the host still decides whether a real provider may
be called at all.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
import hashlib
import json
import os
import re
import time
import uuid
from zoneinfo import ZoneInfo

from ...plugin_runtime import require_enabled
from ...resources import _atomic_write_json
from ...tool_contract import BuiltinTool, execution_context
from ..workflows.workflows import ACTIVE, WorkflowStore, validate_plan

QUEUE_FILE = 'offpeak.json'
SETTINGS_FILE = 'offpeak-settings.json'
LOCK_FILE = '.offpeak.lock'

#: Window bounds are wall-clock minutes; a start after the end spans midnight.
DEFAULT_WINDOW = {'start': '00:00', 'end': '08:00'}
CLOCK_FIELD = re.compile(r'([01]\d|2[0-3]):([0-5]\d)\Z')

MAX_TASKS = 50
MAX_HISTORY = 20
MAX_QUEUE_BYTES = 2_000_000
MAX_SETTINGS_BYTES = 65_536
MAX_NAME = 120
MAX_PROMPT = 5_000
MAX_MODEL_TEXT = 200
MIN_DEADLINE = 60
MAX_DEADLINE = 14_400
DEFAULT_DEADLINE = 3_600
#: ``validate_plan`` caps one node at an hour; the row deadline bounds the whole run.
MAX_NODE_TIMEOUT = 3_600

ADD_FIELDS = {'name', 'prompt', 'root', 'model', 'provider_id', 'window', 'timezone',
              'onlyWhenIdle', 'deadlineSeconds', 'confirm', 'allowReal'}
SETTINGS_FIELDS = {'window', 'timezone'}
QUEUED = 'queued'
RUNNING = 'running'


def _lock(state):
    """Queue writes need their own lock, not the plugin switch one."""
    from ... import file_lock

    @contextmanager
    def held():
        root = Path(state)
        root.mkdir(parents=True, exist_ok=True)
        path = root / LOCK_FILE
        if path.is_symlink():
            raise ValueError('闲时队列锁不能是符号链接')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'a+b') as stream:
            file_lock.flock(stream, file_lock.LOCK_EX)
            try:
                yield
            finally:
                file_lock.flock(stream, file_lock.LOCK_UN)
    return held()


def _text(value, field, maximum, required=False):
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('%s 需要是 1 到 %d 个字符的文本' % (field, maximum))
    return value.strip()


def _clock_minutes(value, field):
    if not isinstance(value, str) or not CLOCK_FIELD.match(value):
        raise ValueError('%s 需要是 HH:MM 时间' % field)
    return int(value[:2]) * 60 + int(value[3:])


def _zone(name):
    if name in (None, ''):
        return None
    if not isinstance(name, str) or len(name) > 64:
        raise ValueError('时区无效')
    try:
        return ZoneInfo(name)
    except (ValueError, OSError, KeyError):
        raise ValueError('时区无法解析') from None


def _wall_clock(now, timezone_name):
    moment = datetime.fromtimestamp(now, timezone.utc)
    zone = _zone(timezone_name)
    return moment.astimezone(zone) if zone is not None else moment.astimezone()


def window_span(window):
    """Start/end minutes of day; refuses an empty window."""
    if not isinstance(window, dict) or set(window) - {'start', 'end'}:
        raise ValueError('闲时窗口只包含 start 与 end')
    start = _clock_minutes(window.get('start'), '闲时窗口开始')
    end = _clock_minutes(window.get('end'), '闲时窗口结束')
    if start == end:
        raise ValueError('闲时窗口的开始与结束时间不能相同')
    return start, end


def in_window(now, window, timezone_name=None):
    start, end = window_span(window)
    minute = _wall_clock_minutes(now, timezone_name)
    return start <= minute < end if start < end else minute >= start or minute < end


def next_window_open(now, window, timezone_name=None):
    """The next instant the window starts, always strictly after ``now``."""
    start, _end = window_span(window)
    local = _wall_clock(now, timezone_name)
    opening = local.replace(hour=start // 60, minute=start % 60, second=0, microsecond=0)
    if local.hour * 60 + local.minute >= start:
        opening += timedelta(days=1)
    return opening.timestamp()


def _wall_clock_minutes(now, timezone_name):
    local = _wall_clock(now, timezone_name)
    return local.hour * 60 + local.minute


def host_is_idle(state):
    """Nothing else of this host is busy: no active workflow run is in flight."""
    try:
        runs = WorkflowStore(state).list()
    except (OSError, ValueError):
        return False
    return not any(run.get('status') in ACTIVE for run in runs)


def plan_for(row):
    """The immutable one-node plan a task runs, plus the digest its approval binds to."""
    root = Path(row['root'])
    if not root.is_dir():
        raise ValueError('工作区目录不存在')
    node = {'id': 'off_peak', 'kind': 'agent', 'prompt': row['prompt'], 'cwd': '.',
            'timeout': min(row['deadlineSeconds'], MAX_NODE_TIMEOUT)}
    for field in ('model', 'provider_id'):
        if row.get(field):
            node[field] = row[field]
    plan = validate_plan({'name': row['name'], 'nodes': [node], 'concurrency': 1}, root)
    digest = hashlib.sha256(json.dumps({'root': str(root.resolve()), 'plan': plan},
                                       sort_keys=True).encode()).hexdigest()
    return plan, digest


def _append_history(row, entry):
    row['history'] = (row.get('history') or [])[-(MAX_HISTORY - 1):] + [entry]
    return row['history']


class OffPeakQueue:
    """Durable off-peak queue with at-most-once claims inside a local window."""

    def __init__(self, state, *, clock=time.time, allow_real_host=False, idle_check=None):
        self.state = Path(state)
        self.clock = clock
        self.allow_real_host = allow_real_host
        self.idle_check = idle_check if callable(idle_check) else (lambda: host_is_idle(self.state))
        self.path = self.state / QUEUE_FILE
        self.settings_path = self.state / SETTINGS_FILE

    # ------------------------------------------------------------------ reads

    def _read(self, path, maximum, kind):
        if path.is_symlink():
            raise ValueError('闲时%s不能是符号链接' % kind)
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return None
        if len(raw) > maximum:
            raise ValueError('闲时%s超出大小上限' % kind)
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise ValueError('闲时%s已损坏，请先修复或删除该状态文件' % kind) from None

    def _rows(self):
        rows = self._read(self.path, MAX_QUEUE_BYTES, '队列')
        if rows is None:
            return []
        if not isinstance(rows, list):
            raise ValueError('闲时队列必须是 JSON 数组')
        return rows

    def list(self):
        return self._rows()

    def get(self, task_id):
        return next((row for row in self._rows() if row.get('id') == task_id), None)

    def settings(self):
        document = self._read(self.settings_path, MAX_SETTINGS_BYTES, '设置')
        if document is None:
            return {'window': dict(DEFAULT_WINDOW), 'timezone': None}
        if not isinstance(document, dict) or set(document) - SETTINGS_FIELDS:
            raise ValueError('闲时设置包含未知字段')
        window = document.get('window') or dict(DEFAULT_WINDOW)
        window_span(window)
        timezone_name = document.get('timezone')
        if timezone_name is not None:
            _zone(timezone_name)
        return {'window': {'start': window['start'], 'end': window['end']},
                'timezone': timezone_name or None}

    def overview(self):
        settings = self.settings()
        now = self.clock()
        window = settings['window']
        zone = settings['timezone']
        inside = in_window(now, window, zone)
        return {'tasks': self.list(), 'settings': settings, 'windowOpen': inside,
                'nextWindowAt': next_window_open(now, window, zone)}

    def _window_of(self, row):
        settings = self.settings()
        return (row.get('window') or settings['window'],
                row.get('timezone') if row.get('timezone') is not None else settings['timezone'])

    @contextmanager
    def _mutate(self):
        with _lock(self.state):
            rows = self._rows()
            payload = {'rows': rows}
            yield payload
            self._write(payload['rows'])

    def _write(self, rows):
        _atomic_write_json(self.path, rows)

    # ------------------------------------------------------------ queue edits

    def add(self, data):
        require_enabled(self.state, 'automation')
        if not isinstance(data, dict):
            raise ValueError('闲时任务必须是一个对象')
        unknown = sorted(set(data) - ADD_FIELDS)
        if unknown:
            raise ValueError('闲时任务包含未知字段: ' + ', '.join(unknown))
        prompt = _text(data.get('prompt'), '提示词', MAX_PROMPT, required=True)
        name = _text(data.get('name'), '任务名称', MAX_NAME) or '闲时任务'
        root_value = _text(data.get('root'), '工作区路径', 4096, required=True)
        candidate = Path(root_value)
        if not candidate.is_absolute():
            raise ValueError('工作区路径需要是绝对路径')
        root = candidate.resolve()
        if not root.is_dir():
            raise ValueError('工作区目录不存在')
        model = _text(data.get('model'), '模型', MAX_MODEL_TEXT)
        provider_id = _text(data.get('provider_id'), '服务商', MAX_MODEL_TEXT)
        deadline = data.get('deadlineSeconds', DEFAULT_DEADLINE)
        if type(deadline) is not int or not MIN_DEADLINE <= deadline <= MAX_DEADLINE:
            raise ValueError('闲时任务超时需要是 %d 到 %d 秒的整数' % (MIN_DEADLINE, MAX_DEADLINE))
        for field, label in (('onlyWhenIdle', '仅在空闲时'), ('confirm', '批准无人值守执行'),
                             ('allowReal', '允许真实服务商')):
            if type(data.get(field, False)) is not bool:
                raise ValueError('%s需要是布尔值' % label)
        window = data.get('window')
        if window is not None:
            window = window if isinstance(window, dict) else {'start': None}
            window_span(window)
            window = {'start': window['start'], 'end': window['end']}
        timezone_name = data.get('timezone')
        if timezone_name is not None:
            _zone(timezone_name)
            timezone_name = timezone_name or None
        now = self.clock()
        row = {'id': uuid.uuid4().hex, 'name': name, 'prompt': prompt, 'root': str(root),
               'model': model, 'provider_id': provider_id, 'deadlineSeconds': deadline,
               'onlyWhenIdle': data.get('onlyWhenIdle', False) is True,
               'window': window, 'timezone': timezone_name, 'status': QUEUED,
               'createdAt': now, 'nextEligibleAt': now, 'holdUntil': None,
               'approved': data.get('confirm') is True,
               'allowReal': data.get('allowReal') is True,
               'runId': None, 'workflowId': None, 'claimedAt': None, 'finishedAt': None,
               'history': []}
        row['digest'] = plan_for(row)[1]
        with self._mutate() as payload:
            if len(payload['rows']) >= MAX_TASKS:
                raise ValueError('闲时队列已满（上限 %d 项）' % MAX_TASKS)
            payload['rows'].append(row)
        return row

    def approve(self, task_id, allow_real=False, confirmed=False):
        require_enabled(self.state, 'automation')
        if confirmed is not True:
            raise ValueError('需要先确认所批准的不可变计划')
        if allow_real is True and not self.allow_real_host:
            raise ValueError('real provider disabled by host')
        now = self.clock()
        with self._mutate() as payload:
            row = next((r for r in payload['rows'] if r.get('id') == task_id), None)
            if row is None:
                raise ValueError('闲时任务不存在')
            if row['status'] not in (QUEUED, 'failed'):
                raise ValueError('只有排队中的任务可以批准')
            row['approved'] = True
            row['allowReal'] = allow_real is True
            row['status'] = QUEUED
            row['nextEligibleAt'] = now
            row['holdUntil'] = None
            return row

    def cancel(self, task_id):
        require_enabled(self.state, 'automation')
        now = self.clock()
        with self._mutate() as payload:
            row = next((r for r in payload['rows'] if r.get('id') == task_id), None)
            if row is None:
                raise ValueError('闲时任务不存在')
            if row['status'] not in ('completed', 'cancelled'):
                if row['status'] == RUNNING:
                    payload['cancelRun'] = row.get('workflowId')
                row['status'] = 'cancelled'
                row['finishedAt'] = now
                _append_history(row, {'id': uuid.uuid4().hex, 'at': now, 'status': 'cancelled',
                                      'workflowId': row.get('workflowId')})
            payload['result'] = row
        if payload.get('cancelRun'):
            # A cancelled task must not keep occupying the provider budget.
            self._stop_workflow(payload['cancelRun'])
        return payload['result']

    def _stop_workflow(self, workflow_id):
        store = WorkflowStore(self.state)
        try:
            store.control(workflow_id, 'cancel')
        except ValueError:
            # Cancellation may reach the workflow before launch has changed
            # its created state. Preserve that decision without starting it.
            def cancel_created(record):
                if record.get('status') == 'created':
                    record.update(status='cancelled', control='cancel')
                    store.event(record, 'cancel')
            store.update(workflow_id, cancel_created)
        except (OSError, KeyError):
            pass

    def save_settings(self, data):
        require_enabled(self.state, 'automation')
        if not isinstance(data, dict) or set(data) - SETTINGS_FIELDS:
            raise ValueError('闲时设置包含未知字段')
        current = self.settings()
        window = data.get('window', current['window'])
        if not isinstance(window, dict):
            raise ValueError('闲时窗口只包含 start 与 end')
        window = {'start': window.get('start') or current['window']['start'],
                  'end': window.get('end') or current['window']['end']}
        window_span(window)
        timezone_name = data.get('timezone', current['timezone'])
        if timezone_name is not None:
            _zone(timezone_name)
            timezone_name = timezone_name or None
        document = {'window': window, 'timezone': timezone_name}
        with _lock(self.state):
            _atomic_write_json(self.settings_path, document)
        return document

    # ------------------------------------------------------------ execution

    def _granted(self, row):
        return bool(row.get('approved')) and row.get('allowReal') is True and self.allow_real_host

    def _hold(self, row, now, status, error):
        """Nothing started, so the task keeps its seat and waits for a later window."""
        window, zone = self._window_of(row)
        row['status'] = QUEUED
        row['holdUntil'] = next_window_open(now, window, zone)
        _append_history(row, {'id': uuid.uuid4().hex, 'at': now, 'status': status, 'error': error})
        return {'id': row['id'], 'status': status, 'error': error}

    def _claim(self, task_id, now, ignore_window=False):
        """Move one queued task to running exactly once; returns the frozen snapshot."""
        with self._mutate() as payload:
            row = next((r for r in payload['rows'] if r.get('id') == task_id), None)
            if row is None or row['status'] != QUEUED:
                return None
            if not ignore_window and row.get('holdUntil') and now < row['holdUntil']:
                return None
            if not self._granted(row):
                reason = ('operator approval is required' if not row.get('approved')
                          else 'real provider disabled by host')
                return ('held', self._hold(row, now, 'awaiting_approval', reason))
            row['status'] = RUNNING
            row['claimedAt'] = now
            row['runId'] = uuid.uuid4().hex
            row['workflowId'] = None
            _append_history(row, {'id': row['runId'], 'at': now, 'status': 'claimed'})
            return ('claimed', dict(row))

    def _launch(self, row, now):
        """Create and start the workflow behind an already claimed task."""
        try:
            if (self.get(row['id']) or {}).get('status') == 'cancelled':
                return self._settle(row['id'], now, 'cancelled')
            plan, digest = plan_for(row)
            if digest != row['digest']:
                return self._settle(row['id'], now, 'awaiting_approval',
                                    error='plan changed after approval', hold=True)
            store = WorkflowStore(self.state)
            run = store.create(plan, row['root'])
            # Publish the workflow identity before launch. A concurrent cancel
            # can now reach it; a cancel during create prevents launch entirely.
            with self._mutate() as payload:
                current = next((r for r in payload['rows'] if r.get('id') == row['id']), None)
                permitted = current is not None and current.get('runId') == row.get('runId') and current['status'] == RUNNING
                if current is not None and current.get('runId') == row.get('runId'):
                    current['workflowId'] = run['id']
            if not permitted:
                self._stop_workflow(run['id'])
                return self._settle(row['id'], now, 'cancelled', workflow_id=run['id'])
            require_enabled(self.state, 'automation')
            run = store.launch(run['id'], approved=True, allow_real=row['allowReal'])
            return self._settle(row['id'], now, 'started', workflow_id=run['id'])
        except (OSError, ValueError, KeyError, PermissionError) as error:
            reason = str(error) or error.__class__.__name__
        return self._settle(row['id'], now, 'failed', error=reason, hold=True)

    def _settle(self, task_id, now, status, error=None, workflow_id=None, hold=False):
        cancel_workflow_id = None
        with self._mutate() as payload:
            row = next((r for r in payload['rows'] if r.get('id') == task_id), None)
            if row is None:
                return {'id': task_id, 'status': status, 'error': 'task removed'}
            cancelled = row['status'] == 'cancelled'
            record = {'id': row.get('runId'), 'at': row.get('claimedAt') or now, 'status': 'cancelled' if cancelled else status,
                      'workflowId': workflow_id or row.get('workflowId')}
            if error:
                record['error'] = str(error)[:500]
            entry = next((item for item in row['history'] if item.get('id') == row.get('runId')), None)
            if entry is not None:
                row['history'] = [record if item is entry else item for item in row['history']]
            else:
                _append_history(row, record)
            if cancelled:
                # Launch/failure must not overwrite a cancellation or put the
                # task back in the queue. Launch can race the first stop, so
                # stop again after it returns, outside the queue file lock.
                if workflow_id:
                    row['workflowId'] = workflow_id
                cancel_workflow_id = row.get('workflowId')
                result = {'id': row['id'], 'status': 'cancelled', 'workflowId': cancel_workflow_id}
            elif status == 'started':
                row['workflowId'] = workflow_id
                result = {'id': row['id'], 'status': 'started', 'workflowId': workflow_id}
            else:
                if status in ('completed', 'failed', 'cancelled'):
                    row['status'] = status
                    row['finishedAt'] = now
                if hold:
                    window, zone = self._window_of(row)
                    row['status'] = QUEUED
                    row['holdUntil'] = next_window_open(now, window, zone)
                result = {'id': row['id'], 'status': status, 'error': record.get('error')}
        if cancel_workflow_id:
            self._stop_workflow(cancel_workflow_id)
        return result

    def _reconcile(self, row, now):
        """Fold one running task's workflow outcome back into the automation history."""
        workflow_id = row.get('workflowId')
        if not workflow_id:
            return None
        try:
            record = WorkflowStore(self.state).load(workflow_id)
        except (OSError, ValueError, KeyError):
            return self._settle(row['id'], now, 'failed', error='workflow record unavailable', hold=True)
        status = record.get('status')
        if status == 'completed':
            return self._settle(row['id'], now, 'completed', workflow_id=workflow_id)
        if status in ACTIVE:
            if now < (row.get('claimedAt') or now) + row['deadlineSeconds']:
                return None
            try:
                WorkflowStore(self.state).control(workflow_id, 'cancel')
            except (OSError, ValueError, KeyError):
                pass
            return self._settle(row['id'], now, 'failed',
                                error='timed out after %ds' % row['deadlineSeconds'])
        return self._settle(row['id'], now, 'failed', error='workflow %s' % status,
                            workflow_id=workflow_id)

    def _due(self, row, now, settings):
        if row.get('status') != QUEUED or now < row.get('nextEligibleAt', 0):
            return False
        if row.get('holdUntil') and now < row['holdUntil']:
            return False
        window = row.get('window') or settings['window']
        zone = row.get('timezone') if row.get('timezone') is not None else settings['timezone']
        if not in_window(now, window, zone):
            return False
        if row.get('onlyWhenIdle') and not self.idle_check():
            return False
        return True

    def tick(self, now=None):
        """One scheduler pass: settle running tasks, then claim what the window allows."""
        require_enabled(self.state, 'automation')
        now = self.clock() if now is None else now
        settings = self.settings()
        outcomes = []
        for row in self.list():
            if row.get('status') == RUNNING:
                settled = self._reconcile(row, now)
                if settled:
                    outcomes.append(settled)
        for row in self.list():
            if not self._due(row, now, settings):
                continue
            claimed = self._claim(row['id'], now)
            if not claimed:
                continue
            kind, payload = claimed
            outcomes.append(payload if kind == 'held' else self._launch(payload, now))
        return outcomes

    def run_now(self, task_id, now=None):
        """Manual trigger: skips the window, never an approval or the host provider gate."""
        require_enabled(self.state, 'automation')
        now = self.clock() if now is None else now
        row = self.get(task_id)
        if row is None:
            raise ValueError('闲时任务不存在')
        if row['status'] not in (QUEUED, 'failed'):
            raise ValueError('任务已开始或已结束')
        if row['status'] == 'failed':
            with self._mutate() as payload:
                current = next((r for r in payload['rows'] if r.get('id') == task_id), None)
                if current is not None and current['status'] == 'failed':
                    current['status'] = QUEUED
                    current['holdUntil'] = None
                    current['nextEligibleAt'] = now
        claimed = self._claim(task_id, now, ignore_window=True)
        if not claimed:
            raise ValueError('任务已被其他运行领取')
        kind, payload = claimed
        if kind == 'held':
            return payload
        return self._launch(payload, now)


# ------------------------------------------------------------------ model tool

def _subject(args):
    return json.dumps(args, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _create(root, gate, args, session, call_id):
    context = execution_context()
    state = context.get('state_dir') or getattr(context.get('store'), 'directory', None)
    if state is None:
        raise ValueError('闲时任务需要绑定状态目录')
    require_enabled(state, 'automation')
    workspace = Path(root).resolve()
    if not workspace.is_dir():
        raise ValueError('session workspace is unavailable')
    gate.check('exec', _subject(args), call_id)
    queue = OffPeakQueue(Path(state))
    row = queue.add({'prompt': args.get('prompt'), 'name': args.get('name'),
                     'root': str(workspace), 'model': args.get('model'), 'confirm': False})
    position = sum(1 for item in queue.list() if item.get('status') == QUEUED)
    return {'ok': True, 'task': row, 'queuePosition': position,
            'note': '任务已排入闲时队列；操作员在「自动化 → 闲时任务」批准计划后才会无人值守执行。'}


TOOLS = (BuiltinTool(
    'offpeak_create',
    'Queue a non-urgent task for off-peak execution in this session workspace: it runs unattended '
    'inside the locally configured idle window once the operator approves the plan. Use only when '
    'the user explicitly asks for idle-time/off-peak execution; there is no guaranteed start time.',
    {'prompt': {'type': 'string', 'minLength': 1, 'maxLength': MAX_PROMPT,
                'description': 'What the deferred run must deliver; never ask it to schedule more tasks'},
     'name': {'type': 'string', 'maxLength': MAX_NAME, 'description': 'Short task title'},
     'model': {'type': 'string', 'maxLength': MAX_MODEL_TEXT,
               'description': 'Optional model id override'}},
    ('prompt',), 'exec', True, _create, _subject),)


# ------------------------------------------------------------------ entry points

def http(method, parts, data, ctx):
    """The ``/api/automation/offpeak`` family. Gate and switch checks stay in the host."""
    require_enabled(ctx['state_dir'], 'automation')
    queue = OffPeakQueue(ctx['state_dir'], allow_real_host=ctx.get('allow_real', False))
    if len(parts) == 3:
        if method == 'GET':
            return 200, queue.overview()
        if method == 'POST':
            return 201, {'task': queue.add(data)}
        return 405, {'error': 'method not allowed'}
    if len(parts) == 4 and parts[3] == 'settings':
        if method == 'GET':
            return 200, {'settings': queue.settings()}
        if method == 'POST':
            return 200, {'settings': queue.save_settings(data)}
        return 405, {'error': 'method not allowed'}
    if len(parts) == 4 and method == 'DELETE':
        return 200, {'cancelled': queue.cancel(parts[3])['id']}
    if len(parts) == 5 and method == 'POST':
        task_id, action = parts[3], parts[4]
        if action == 'run':
            return 200, {'result': queue.run_now(task_id)}
        if action == 'approve':
            if data.get('allowReal') is True and not ctx.get('allow_real', False):
                return 403, {'error': 'real provider disabled by host'}
            if data.get('confirmed') is not True:
                return 400, {'error': 'approval must name the saved plan'}
            return 200, {'task': queue.approve(task_id, data.get('allowReal'), True)}
    return 405, {'error': 'method not allowed'}


def register_cli(sub):
    """``xueness automation offpeak ...`` under the plugin's own command group."""
    group = sub.add_parser('offpeak', help='queue non-urgent work for the local idle window')
    actions = group.add_subparsers(dest='offpeak_action', required=True)
    actions.add_parser('list')
    add = actions.add_parser('add')
    add.add_argument('prompt')
    add.add_argument('--root', default='.', help='workspace the deferred run works in')
    add.add_argument('--name', default=None)
    add.add_argument('--model', default=None)
    add.add_argument('--deadline', type=int, default=DEFAULT_DEADLINE)
    add.add_argument('--only-when-idle', action='store_true')
    add.add_argument('--approve-execution', action='store_true',
                     help='approve the immutable plan for unattended off-peak execution')
    add.add_argument('--allow-real-provider', action='store_true')
    for name in ('cancel', 'run-now'):
        actions.add_parser(name).add_argument('id')
    approve = actions.add_parser('approve')
    approve.add_argument('id')
    approve.add_argument('--approve-execution', action='store_true')
    approve.add_argument('--allow-real-provider', action='store_true')
    settings = actions.add_parser('settings')
    settings.add_argument('--start', default=None)
    settings.add_argument('--end', default=None)
    settings.add_argument('--timezone', default=None)


def cli(args):
    queue = OffPeakQueue(args.state, allow_real_host=getattr(args, 'allow_real_provider', False))
    action = args.offpeak_action
    if action == 'list':
        return queue.overview()
    if action == 'add':
        return {'task': queue.add({
            'prompt': args.prompt, 'name': args.name, 'root': args.root, 'model': args.model,
            'deadlineSeconds': args.deadline, 'onlyWhenIdle': args.only_when_idle,
            'confirm': args.approve_execution, 'allowReal': args.allow_real_provider})}
    if action == 'cancel':
        return {'cancelled': queue.cancel(args.id)['id']}
    if action == 'run-now':
        return {'result': queue.run_now(args.id)}
    if action == 'approve':
        if not args.approve_execution:
            raise ValueError('--approve-execution is required after reviewing the immutable plan')
        return {'task': queue.approve(args.id, args.allow_real_provider, True)}
    if action == 'settings':
        if not any(value is not None for value in (args.start, args.end, args.timezone)):
            return {'settings': queue.settings()}
        return {'settings': queue.save_settings({'window': {'start': args.start, 'end': args.end},
                                                 'timezone': args.timezone})}
    raise ValueError('unknown off-peak command')
