"""Trusted bundled feature registry shared by CLI, tools, HTTP and UI.

Only package code shipped with Xueness is importable. State stores boolean
switches, never module names, commands or executable entrypoints. Run-time
permissions remain the kernel Gate's responsibility. Disabling a dependency
blocks dependents without silently enabling or rewriting any other plugin.

The optional ``profile`` layer in ``plugin-state.json`` is a second set of
boolean switches chosen by a composition profile. Resolution priority is fixed:
an explicit user switch, then the profile overlay, then the manifest default.
A profile can therefore only narrow or restore allowlisted plugins; it never
names code and never relaxes a Gate, workspace boundary or approval rule.
"""
from __future__ import annotations

import importlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from contextlib import contextmanager
from pathlib import Path

from .plugin_contract import lifecycle_field_errors, tool_events_field_errors
from .plugin_scope import ScopeRegistry, activation_plan
from .resources import _atomic_write_json, _is_link

API_VERSION = 1
PLUGIN_IDS = ('sessions', 'files', 'shell', 'planning', 'providers', 'memory',
              'settings', 'usage', 'git', 'workflows', 'terminal', 'office',
              'commands', 'skills', 'hooks', 'mcp', 'subagents', 'network', 'automation', 'extensions', 'diagnostics', 'browser', 'remote', 'bots', 'onboarding', 'updates', 'desktop', 'tools')
PACKAGE_ROOT = Path(__file__).with_name('bundled_plugins')
CONFIG_NAME = 'plugin-state.json'
MAX_STATE_BYTES = 65536
MAX_PROFILE_NAME_CHARS = 64
_LOCK = threading.RLock()
#: HTTP ownership comes from the immutable build manifests, so it is resolved once.
_ROUTE_INDEX: dict | None = None


class PluginDisabled(ValueError):
    """The requested feature or one of its dependencies is unavailable."""


def _manifests():
    result = {}
    for pid in PLUGIN_IDS:
        item = json.loads((PACKAGE_ROOT / pid / 'manifest.json').read_text(encoding='utf-8'))
        if item.get('id') != pid or item.get('apiVersion') != API_VERSION:
            raise ValueError('incompatible bundled plugin manifest')
        if type(item.get('defaultEnabled')) is not bool:
            raise ValueError('invalid bundled plugin default')
        if any(dep not in PLUGIN_IDS for dep in item['dependencies']):
            raise ValueError('unknown bundled plugin dependency')
        errors = lifecycle_field_errors(pid, item)
        errors.extend(tool_events_field_errors(pid, item))
        if errors:
            raise ValueError('; '.join(errors))
        result[pid] = item
    return result


def _switch_map(value, message):
    """Validate a ``plugin id -> boolean`` mapping, refusing anything else."""
    if not isinstance(value, dict) or any(
            pid not in PLUGIN_IDS or type(item) is not bool for pid, item in value.items()):
        raise ValueError(message)
    return value


def _read_profile(value):
    if value is None:
        return {'name': None, 'overlay': {}}
    if not isinstance(value, dict) or set(value) - {'name', 'overlay'}:
        raise ValueError('unknown plugin profile fields')
    name = value.get('name')
    if name is not None and (type(name) is not str or not name or len(name) > MAX_PROFILE_NAME_CHARS):
        raise ValueError('invalid plugin profile name')
    return {'name': name, 'overlay': _switch_map(value.get('overlay'), 'invalid plugin profile switches')}


def _read_state(state_dir) -> dict:
    """The whole switch document: user switches plus the profile overlay.

    Both layers are allowlisted ids with boolean values, read without following
    a symlink and within one size budget. Unknown fields are refused rather than
    ignored, so a state file cannot smuggle a new kind of configuration.
    """
    path = Path(state_dir) / CONFIG_NAME
    if _is_link(path):
        raise ValueError('plugin configuration must not be a symlink')
    try:
        with path.open('rb') as stream:
            raw = stream.read(MAX_STATE_BYTES + 1)
    except FileNotFoundError:
        return {'enabled': {}, 'profile': {'name': None, 'overlay': {}}}
    if len(raw) > MAX_STATE_BYTES:
        raise ValueError('plugin configuration too large')
    try:
        item = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError('invalid plugin configuration') from None
    if not isinstance(item, dict) or item.get('apiVersion') != API_VERSION or isinstance(item.get('apiVersion'), bool):
        raise ValueError('invalid plugin configuration version')
    if set(item) - {'apiVersion', 'enabled', 'profile'}:
        raise ValueError('unknown plugin configuration fields')
    return {'enabled': _switch_map(item.get('enabled'), 'invalid plugin switches'),
            'profile': _read_profile(item.get('profile'))}


def _write_state(state_dir, switches, profile):
    item = {'apiVersion': API_VERSION, 'enabled': switches}
    if profile['name'] is not None or profile['overlay']:
        item['profile'] = profile
    _atomic_write_json(Path(state_dir) / CONFIG_NAME, item)


def profile_state(state_dir) -> dict:
    """The active composition profile as pure data, failing closed when broken."""
    try:
        return _read_state(state_dir)['profile']
    except (OSError, ValueError):
        return {'name': None, 'overlay': {}}


def _chooser(manifests, switches, overlay):
    """Explicit user switch, then the profile overlay, then the manifest default."""
    def chosen(pid):
        if pid in switches:
            return switches[pid]
        if pid in overlay:
            return overlay[pid]
        return manifests[pid]['defaultEnabled']
    return chosen


def _resolve_items(manifests, chosen, error):
    effective = {}

    def resolve(pid, visiting=()):
        if pid in effective:
            return effective[pid]
        if pid in visiting:
            raise ValueError('cyclic plugin dependencies')
        available = chosen(pid) and all(resolve(dep, visiting + (pid,))
                                        for dep in manifests[pid]['dependencies'])
        effective[pid] = available
        return available

    for pid in PLUGIN_IDS:
        resolve(pid)
    items = [{**manifest, 'enabled': chosen(pid),
              'effective': effective[pid],
              'blockedBy': [dep for dep in manifest['dependencies'] if not effective[dep]],
              **({'configurationError': error} if error else {})}
             for pid, manifest in manifests.items()]
    order, blocked = activation_plan(items)
    activated = set(order)
    for item in items:
        item['activated'] = item['id'] in activated
        if item['id'] in blocked:
            item['activationError'] = blocked[item['id']]
    return items


def _broken_state():
    return {'enabled': {pid: False for pid in PLUGIN_IDS}, 'profile': {'name': None, 'overlay': {}}}


def catalog(state_dir):
    manifests = _manifests()
    error = ''
    try:
        state = _read_state(state_dir)
    except (OSError, ValueError):
        state = _broken_state()
        error = 'invalid plugin configuration; repair plugin-state.json'
    return _resolve_items(manifests,
                          _chooser(manifests, state['enabled'], state['profile']['overlay']), error)


def preview(state_dir, overlay=None):
    """The catalog this state would show with a proposed profile overlay.

    Nothing is written: dependency resolution, ``blockedBy`` and activation all
    run on the proposal, so a dry-run answer cannot drift from the real apply.
    """
    manifests = _manifests()
    error = ''
    try:
        state = _read_state(state_dir)
    except (OSError, ValueError):
        state = _broken_state()
        error = 'invalid plugin configuration; repair plugin-state.json'
    layer = state['profile']['overlay'] if overlay is None else _switch_map(
        overlay, 'invalid plugin profile switches')
    return _resolve_items(manifests, _chooser(manifests, state['enabled'], layer), error)


def is_enabled(state_dir, plugin_id):
    return any(p['id'] == plugin_id and p['effective'] for p in catalog(state_dir))


def require_enabled(state_dir, plugin_id):
    if not is_enabled(state_dir, plugin_id):
        raise PluginDisabled('plugin disabled or dependency unavailable: ' + plugin_id)


@contextmanager
def _config_lock(state_dir):
    # CLI and Web may run in separate processes. Re-read under this lock to
    # avoid one toggle losing another writer's change.
    from . import file_lock as fcntl
    root = Path(state_dir)
    root.mkdir(parents=True, exist_ok=True)
    path = root / '.plugin-state.lock'
    if path.is_symlink():
        raise ValueError('plugin lock must not be a symlink')
    import os
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'a+b') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def set_enabled(state_dir, plugin_id, enabled):
    if plugin_id not in PLUGIN_IDS:
        raise ValueError('unknown plugin: ' + str(plugin_id))
    if type(enabled) is not bool:
        raise ValueError('enabled must be a boolean')
    with _LOCK, _config_lock(state_dir):
        state = _read_state(state_dir)
        switches = state['enabled']
        if enabled:
            unavailable = next(p for p in catalog(state_dir) if p['id'] == plugin_id)['blockedBy']
            if unavailable:
                raise ValueError('enable dependencies first: ' + ', '.join(unavailable))
        switches[plugin_id] = enabled
        _write_state(state_dir, switches, state['profile'])
        return catalog(state_dir)


def set_profile(state_dir, name, overlay):
    """Record the active profile overlay, keeping every user switch intact.

    ``name`` only labels the profile in the catalog and ``overlay`` holds boolean
    switches for allowlisted ids. Writing a profile never enables a dependency,
    so a plugin whose dependency stays off keeps reporting it in ``blockedBy``.
    """
    if name is not None and (type(name) is not str or not name or len(name) > MAX_PROFILE_NAME_CHARS):
        raise ValueError('invalid plugin profile name')
    if not isinstance(overlay, dict):
        raise ValueError('plugin profile overlay must be id/boolean switches')
    if len(overlay) > len(PLUGIN_IDS):
        raise ValueError('plugin profile overlay too large')
    unknown = sorted(str(pid) for pid in overlay if pid not in PLUGIN_IDS)
    if unknown:
        raise ValueError('unknown plugin: ' + ', '.join(unknown))
    _switch_map(overlay, 'profile switch must be a boolean')
    with _LOCK, _config_lock(state_dir):
        state = _read_state(state_dir)
        _write_state(state_dir, state['enabled'],
                     {'name': name, 'overlay': dict(overlay or {})})
        return catalog(state_dir)


def entrypoint(plugin_id):
    """Load a trusted package from the immutable build allowlist."""
    if plugin_id not in PLUGIN_IDS:
        raise ValueError('unknown plugin')
    return importlib.import_module('xueness.bundled_plugins.' + plugin_id + '.plugin')


def completion_instructions(state_dir, session):
    """Trusted optional plugin guidance, with the same effective gate as tools."""
    blocks = []
    for item in catalog(state_dir):
        if item['effective']:
            callback = getattr(entrypoint(item['id']), 'completion_instructions', None)
            if callable(callback):
                block = callback(session)
                if isinstance(block, str) and block:
                    blocks.append(block[:6000])
    return blocks


def completion_checks(state_dir, root, gate, session, summary):
    """Collect host checks from active plugins; no plugin claims another's outcome."""
    checks = {}
    for item in catalog(state_dir):
        if item['effective']:
            callback = getattr(entrypoint(item['id']), 'completion_check', None)
            if callable(callback):
                checks[item['id']] = callback(root, gate, session, summary, state_dir=state_dir)
    return checks


def completion_requires_evidence(state_dir, session, call_ids=()):
    """Ask enabled plugins whether this turn has evidence-bearing obligations.

    The kernel keeps a conservative fallback when the sessions policy is
    disabled; this hook only allows an enabled product feature to add a
    requirement, never to erase a requirement from another plugin.
    """
    required = False
    for item in catalog(state_dir):
        if not item['effective']:
            continue
        callback = getattr(entrypoint(item['id']), 'completion_requires_evidence', None)
        if callable(callback) and callback(session, call_ids):
            required = True
    return required


#: Tool event pipeline (Cordis-style pre/post seams, aligned with the DeepSeek
#: harness capability seams and ZCode's call runner): effective plugins may
#: observe registry calls before and after execution, and a manifest declaration
#: grants a structured deny (before) or restricted result rewrite (after). A
#: declared ``after_tool_authorization`` observer runs only after the handler's
#: Gate check succeeds. Declarations are pure data; callbacks come only from
#: build-allowlist entrypoints. The pipeline can only tighten a decision -- Gate,
#: approvals, permission modes and workspace boundaries still decide inside the
#: handler, and it never grants access.
#:
#: Upper bound for one plugin callback, in seconds. Callbacks run in a helper
#: thread; on timeout the result is discarded and the run continues, so a
#: stalled observer can never stall the tool it watches. The thread itself
#: cannot be killed and keeps running cooperatively.
TOOL_EVENT_TIMEOUT_SECONDS = 10.0
#: Bounds for one deny reason and one diagnostic detail line.
TOOL_EVENT_REASON_MAX = 500
TOOL_EVENT_DETAIL_MAX = 200
TOOL_EVENT_DIAGNOSTICS_MAX = 50
#: Result fields that identify a call. They are kernel-owned, and a rewrite
#: may keep them exactly as they were or leave them out -- never change them.
_TOOL_RESULT_IDENTITY_KEYS = ('tool_call_id', '_tool_call_id')

#: Serialises callback execution across threads: concurrent read batches fire
#: one before/after pair per call from worker threads, and the event callbacks
#: themselves must stay serial even though the tool handlers they surround do
#: not. Re-entrant for the same thread only; a callback that synchronously
#: executed another tool through dispatch from a helper thread would deadlock,
#: so callbacks observe and report, they do not run tools.
_TOOL_EVENT_LOCK = threading.RLock()


def _tool_event_declaration(item) -> dict:
    declaration = item.get('toolEvents')
    return declaration if isinstance(declaration, dict) else {}


def _tool_event_priority(item) -> int:
    priority = _tool_event_declaration(item).get('priority')
    return priority if type(priority) is int else 0


def tool_event_order(items) -> list[str]:
    """Order plugin catalog rows for event dispatch: topology, then priority.

    A dependency always dispatches before its dependents, whatever the declared
    priorities; among plugins the topology leaves unordered, the higher
    manifest-declared priority goes first and PLUGIN_IDS order breaks ties.
    Cycles cannot survive catalog resolution, but the order degrades to the
    declaration order rather than looping if one ever appears here.
    """
    by_id = {item['id']: item for item in items if isinstance(item, dict) and item.get('id')}
    emitted: set = set()
    remaining = set(by_id)

    def sort_key(pid):
        return (-_tool_event_priority(by_id[pid]), PLUGIN_IDS.index(pid))

    order: list[str] = []
    while remaining:
        ready = sorted((pid for pid in remaining
                        if all(dep in emitted for dep in by_id[pid]['dependencies']
                               if dep in by_id)), key=sort_key)
        if not ready:
            ready = sorted(remaining, key=sort_key)
        emitted.add(ready[0])
        order.append(ready[0])
        remaining.discard(ready[0])
    return order


def tool_event_plan(state_dir) -> list[dict]:
    """Effective plugins in tool-event dispatch order, with their grants.

    Returns one row per effective plugin; ``before``/``after`` say whether the
    manifest's ``toolEvents`` declaration grants intervention and ``authorized``
    records its observer-only post-Gate event. Pure data, resolved from trusted
    build manifests and persisted switches.
    """
    items = [item for item in catalog(state_dir) if item['effective']]
    by_id = {item['id']: item for item in items}
    plan = []
    for pid in tool_event_order(items):
        events = _tool_event_declaration(by_id[pid]).get('events') or ()
        plan.append({'id': pid, 'priority': _tool_event_priority(by_id[pid]),
                     'before': 'before_tool_execution' in events,
                     'after': 'after_tool_execution' in events,
                     'authorized': 'after_tool_authorization' in events,
                     'effect': 'before_tool_effect' in events})
    return plan


def _tool_event_diagnostics(session, event, plugin_id, kind, detail) -> None:
    """Append one bounded diagnostic to the session journal; never raises.

    Records every intervention (deny, rewrite) and every anomaly (error,
    timeout, rejected attempt) so a misbehaving plugin stays visible without
    breaking the run it only observes.
    """
    if not isinstance(session, dict):
        return
    try:
        log = session.setdefault('tool_event_diagnostics', [])
        log.append({'event': event, 'plugin': plugin_id, 'kind': kind,
                    'detail': str(detail or '')[:TOOL_EVENT_DETAIL_MAX]})
        if len(log) > TOOL_EVENT_DIAGNOSTICS_MAX:
            del log[:-TOOL_EVENT_DIAGNOSTICS_MAX]
    except Exception:  # noqa: BLE001 - diagnostics must never break a run
        pass


def _run_tool_event_callback(plugin_id, event, callback, payload, session):
    """Run one callback isolated: lock-serialised, time-bounded, never raises.

    Returns the callback's return value, or ``None`` when it raised or timed
    out. An exception is recorded by type name only -- callback text may carry
    untrusted data and must not be echoed into the journal.
    """
    with _TOOL_EVENT_LOCK:
        timeout = TOOL_EVENT_TIMEOUT_SECONDS
        try:
            if isinstance(timeout, (int, float)) and timeout > 0:
                pool = ThreadPoolExecutor(max_workers=1,
                                          thread_name_prefix='xueness-tool-event')
                try:
                    future = pool.submit(callback, payload)
                    try:
                        return future.result(timeout=timeout)
                    except FutureTimeoutError:
                        future.cancel()
                        _tool_event_diagnostics(session, event, plugin_id, 'timeout',
                                                'callback exceeded %ss' % (timeout,))
                        return None
                finally:
                    pool.shutdown(wait=False)
            return callback(payload)
        except Exception as exc:  # noqa: BLE001 - one callback must not fail the run
            _tool_event_diagnostics(session, event, plugin_id, 'error',
                                    type(exc).__name__)
            return None


def before_tool_execution(state_dir, session, store, tool_name, gate_kind,
                          tool_call_id=None):
    """Tell effective plugins that a tool call is about to run; honour a deny.

    Every effective plugin with a ``before_tool_execution`` callback observes
    the call, in :func:`tool_event_plan` order. A plugin whose manifest
    declares ``before_tool_execution`` in ``toolEvents`` may additionally
    return ``{'decision': 'deny', 'reason': ...}`` to stop the call before any
    side effect; the deny travels back as a structured tool error carrying the
    reason. A deny from an undeclared plugin, or one without a usable reason,
    is ignored as an observation and recorded as a diagnostic. The pipeline
    can only tighten: it never grants, and the handler's own Gate, approval
    and workspace checks still decide whatever it lets through.

    Returns ``None`` to proceed, or the structured denial result.
    """
    if state_dir is None:
        return None
    try:
        payload = {'state_dir': state_dir, 'session': session, 'store': store,
                   'tool': tool_name, 'gate_kind': gate_kind,
                   'tool_call_id': tool_call_id}
        for participant in tool_event_plan(state_dir):
            callback = getattr(entrypoint(participant['id']),
                               'before_tool_execution', None)
            if not callable(callback):
                continue
            outcome = _run_tool_event_callback(participant['id'],
                                               'before_tool_execution',
                                               callback, payload, session)
            if not isinstance(outcome, dict) or outcome.get('decision') != 'deny':
                continue
            if not participant['before']:
                _tool_event_diagnostics(session, 'before_tool_execution',
                                        participant['id'], 'deny_ignored',
                                        'toolEvents does not declare this event')
                continue
            reason = outcome.get('reason')
            if not isinstance(reason, str) or not reason.strip():
                _tool_event_diagnostics(session, 'before_tool_execution',
                                        participant['id'], 'deny_ignored',
                                        'deny without a usable reason')
                continue
            reason = reason.strip()[:TOOL_EVENT_REASON_MAX]
            _tool_event_diagnostics(session, 'before_tool_execution',
                                    participant['id'], 'deny', reason)
            return {'ok': False, 'error': 'denied by plugin ' + participant['id'],
                    'error_code': 'plugin_denied', 'plugin': participant['id'],
                    'user_reason': reason}
    except Exception:  # noqa: BLE001 - the seam must degrade, not fail the call
        return None
    return None


def before_tool_effect(state_dir, session, store, tool_name, gate_kind,
                       subject, tool_call_id=None):
    """Synchronously run declared strict policies after Gate, before effects.

    Unlike observational tool events, this seam is fail-closed and is allowed
    to return a structured refusal. It also runs for state-bound direct calls
    without a model session; such callers receive only the plugin's scoped
    behavior and do not acquire a synthetic session.
    """
    if state_dir is None:
        return None
    from .tool_contract import ToolEffectDenied
    payload = {'state_dir': state_dir, 'session': session, 'store': store,
               'tool': tool_name, 'gate_kind': gate_kind, 'subject': subject,
               'tool_call_id': tool_call_id}
    try:
        participants = [item for item in tool_event_plan(state_dir)
                        if item.get('effect')]
    except Exception:  # noqa: BLE001 - policy lookup failure must fail closed.
        raise ToolEffectDenied({
            'ok': False, 'error': 'tool execution policy unavailable',
            'error_code': 'tool_policy_unavailable', 'retryable': False})
    for participant in participants:
        callback = getattr(entrypoint(participant['id']),
                           'before_tool_effect', None)
        if not callable(callback):
            continue
        try:
            outcome = callback(payload)
        except Exception as exc:  # noqa: BLE001 - strict policy fails closed.
            _tool_event_diagnostics(session, 'before_tool_effect',
                                    participant['id'], 'error',
                                    type(exc).__name__)
            raise ToolEffectDenied({
                'ok': False, 'error': 'tool execution policy unavailable',
                'error_code': 'tool_policy_unavailable', 'retryable': False})
        if outcome is None:
            continue
        if (isinstance(outcome, dict) and outcome.get('decision') == 'deny'
                and isinstance(outcome.get('result'), dict)
                and outcome['result'].get('ok') is False):
            _tool_event_diagnostics(session, 'before_tool_effect',
                                    participant['id'], 'deny',
                                    outcome['result'].get('error_code', ''))
            return outcome['result']
        _tool_event_diagnostics(session, 'before_tool_effect',
                                participant['id'], 'invalid_result', '')
        raise ToolEffectDenied({
            'ok': False, 'error': 'tool execution policy unavailable',
            'error_code': 'tool_policy_unavailable', 'retryable': False})
    return None


def after_tool_authorization(state_dir, session, store, tool_name, gate_kind,
                             subject, tool_call_id=None):
    """Notify declared observers immediately after a handler's Gate succeeds.

    This event is observation-only: return values are ignored, so it cannot
    grant, deny, or rewrite a tool call. It gives effective plugins a precise
    point to capture state before the authorized handler continues. Gate
    failures and pending approvals never reach this seam.
    """
    if session is None or state_dir is None:
        return
    try:
        payload = {'state_dir': state_dir, 'session': session, 'store': store,
                   'tool': tool_name, 'gate_kind': gate_kind, 'subject': subject,
                   'tool_call_id': tool_call_id}
        for participant in tool_event_plan(state_dir):
            if not participant['authorized']:
                continue
            callback = getattr(entrypoint(participant['id']),
                               'after_tool_authorization', None)
            if not callable(callback):
                continue
            # The handler must not start while a checkpoint observer is still
            # running. Unlike observational before/after hooks, this seam is
            # synchronous; each trusted callback must bound its own work.
            with _TOOL_EVENT_LOCK:
                try:
                    callback(payload)
                except Exception as exc:  # noqa: BLE001 - do not alter Gate result.
                    _tool_event_diagnostics(session, 'after_tool_authorization',
                                            participant['id'], 'error',
                                            type(exc).__name__)
    except Exception:  # noqa: BLE001 - the seam must degrade, not fail the call.
        return


def _rewrite_problem(original, rewritten):
    """Why a proposed result rewrite cannot be accepted, or ``None``.

    The replacement must stay a JSON-serialisable object, keep ``ok`` exactly
    as it was -- a failure can never become a success, nor the reverse -- and
    leave the call-identity fields untouched. Tool name and call id live
    outside the rewritten payload (the kernel owns them), so the rewrite
    cannot change which call a result belongs to.
    """
    if not isinstance(rewritten, dict):
        return 'rewritten result must be an object'
    if rewritten.get('ok') is not original.get('ok'):
        return 'ok must stay unchanged'
    for key in _TOOL_RESULT_IDENTITY_KEYS:
        if original.get(key) != rewritten.get(key):
            return 'call identity must stay unchanged'
    try:
        json.dumps(rewritten, ensure_ascii=False)
    except (TypeError, ValueError, OverflowError):
        return 'rewritten result must stay JSON-serialisable'
    return None


def after_tool_execution(state_dir, session, store, tool_name, tool_call_id, result):
    """Let effective plugins observe, and if declared rewrite, a tool result.

    Fired once per registry tool call after the handler settled and before the
    result is recorded for the model, in :func:`tool_event_plan` order. Each
    callback sees the previously accepted rewrite. A plugin whose manifest
    declares ``after_tool_execution`` in ``toolEvents`` may return
    ``{'decision': 'rewrite', 'result': {...}}``; the kernel validates the
    replacement with :func:`_rewrite_problem` and rejects it otherwise,
    recording a diagnostic. Returns the result to record.
    """
    if state_dir is None or not isinstance(result, dict):
        return result
    try:
        try:
            from .tool_contract import execution_context
            execution_scope = execution_context().get('execution_scope')
        except ValueError:
            execution_scope = None
        payload = {'state_dir': state_dir, 'session': session, 'store': store,
                   'tool': tool_name, 'tool_call_id': tool_call_id, 'result': result,
                   'execution_scope': execution_scope}
        for participant in tool_event_plan(state_dir):
            callback = getattr(entrypoint(participant['id']),
                               'after_tool_execution', None)
            if not callable(callback):
                continue
            outcome = _run_tool_event_callback(participant['id'],
                                               'after_tool_execution',
                                               callback, {**payload, 'result': result},
                                               session)
            if not isinstance(outcome, dict) or outcome.get('decision') != 'rewrite':
                continue
            if not participant['after']:
                _tool_event_diagnostics(session, 'after_tool_execution',
                                        participant['id'], 'rewrite_rejected',
                                        'toolEvents does not declare this event')
                continue
            problem = _rewrite_problem(result, outcome.get('result'))
            if problem is not None:
                _tool_event_diagnostics(session, 'after_tool_execution',
                                        participant['id'], 'rewrite_rejected', problem)
                continue
            result = outcome['result']
            _tool_event_diagnostics(session, 'after_tool_execution',
                                    participant['id'], 'rewrite', '')
        return result
    except Exception:  # noqa: BLE001 - the seam must degrade, not fail the call
        return result


def active_tool_names(state_dir):
    from .tool_registry import REGISTRY
    effective = {p['id'] for p in catalog(state_dir) if p['effective']}
    return frozenset(tool.name for tool in REGISTRY if tool_owner(tool.name) in effective)


def tool_owner(name):
    for pid, spec in _manifests().items():
        if name in spec['tools'] or pid == 'mcp' and (name == 'mcp' or name.startswith('mcp__')):
            return pid
    for pid in PLUGIN_IDS:
        if any(tool.name == name for tool in getattr(entrypoint(pid), 'tools', lambda: ())()):
            return pid
    return None


def tool_schemas(state_dir):
    from .tool_registry import REGISTRY
    effective = {p['id'] for p in catalog(state_dir) if p['effective']}
    schemas = []
    for tool in REGISTRY:
        if tool_owner(tool.name) not in effective:
            continue
        schema = tool.schema()
        if tool.schema_for_state is not None:
            schema = tool.schema_for_state(schema, state_dir)
        schemas.append(schema)
    return schemas


def cli_owner(command, args=None):
    if command == 'resources':
        kind = getattr(args, 'kind', None)
        if kind == 'plugins':
            return 'extensions'
        return kind if kind in ('skills','commands','hooks','mcp','subagents') else None
    for pid, spec in _manifests().items():
        if command in spec['commands']:
            return pid
    return None


def plugins_action_owner(action):
    """The plugin running one sub-action of the shared ``plugins`` command group.

    The group itself is kernel routing (``plugin_cli``); a feature plugin owns a
    sub-action by listing it in ``pluginsActions``, the same declarative source
    as ``tools`` and ``commands``. One action can have one owner.
    """
    for pid, spec in _manifests().items():
        if action in (spec.get('pluginsActions') or ()):
            return pid
    return None


def slash_owner(name):
    """Plugin owning an in-chat ``/name`` command, from the same manifest list
    that owns the top-level CLI command. Generic routing data, not behavior."""
    if not isinstance(name, str) or not name or name.startswith('/'):
        return None
    for pid, spec in _manifests().items():
        if name in spec['commands']:
            return pid
    return None


def dispatch_slash(text, ctx):
    """Route an in-chat slash command to the plugin that owns its name.

    Same ownership source as the CLI parser registry. Returns the plugin's
    reply string when it handled the command, ``None`` when no plugin claims
    the name (the caller keeps its existing behavior), and an error message
    when the owning plugin is disabled — a disabled feature must fall through
    into neither execution nor a silent model prompt.
    """
    if not isinstance(text, str) or not text.startswith('/'):
        return None
    state_dir = ctx.get('state_dir') if isinstance(ctx, dict) else None
    name, _, argument = text[1:].partition(' ')
    owner = slash_owner(name)
    if owner is None or state_dir is None:
        return None
    if not is_enabled(state_dir, owner):
        return 'plugin disabled or dependency unavailable: ' + owner
    handler = getattr(entrypoint(owner), 'execute_slash', None)
    if handler is None:
        return None
    return handler(name, argument.strip(), ctx)


def build_http_family_index(manifests=None):
    """Map each plugin's declared ``httpFamilies`` patterns to its owner.

    Entries are path data relative to ``/api``. A literal segment must match, and
    ``*`` skips exactly one segment, so ``sessions/*/git`` is git's ownership of
    a session sub-resource without claiming the whole ``sessions`` family.
    """
    index = {}
    for pid, spec in (manifests if manifests is not None else _manifests()).items():
        for entry in spec.get('httpFamilies') or ():
            pattern = tuple(entry.split('/'))
            previous = index.get(pattern)
            if previous is not None and previous != pid:
                raise ValueError('http family %s is owned by %s and %s' % (entry, previous, pid))
            index[pattern] = pid
    return index


def _http_family_index():
    global _ROUTE_INDEX
    if _ROUTE_INDEX is None:
        _ROUTE_INDEX = build_http_family_index()
    return _ROUTE_INDEX


def route_owner(parts):
    """The plugin owning an ``/api`` path family, longest declared pattern first."""
    if not parts or parts[0] != 'api' or len(parts) < 2:
        return None
    path = parts[1:]
    index = _http_family_index()
    owner, depth = None, 0
    for pattern, pid in index.items():
        if len(pattern) <= depth or len(pattern) > len(path):
            continue
        if all(segment == '*' or segment == got for segment, got in zip(pattern, path)):
            owner, depth = pid, len(pattern)
    return owner


def _plugin_owned_segments():
    """Second ``/api/plugins`` path segments that a build manifest claims.

    The kernel manager answers ``GET /api/plugins`` and ``POST /api/plugins/<id>``;
    ownership of every other sub-family comes from the same immutable manifests
    ``route_owner`` reads, so a plugin adding an HTTP surface adds no new host
    special case.
    """
    return {pattern[1] for pattern in _http_family_index() if len(pattern) > 1 and pattern[0] == 'plugins'}


def dispatch_http(method, parts, query, data, ctx):
    if parts[:2] == ['api', 'plugins'] and (len(parts) < 3 or parts[2] not in _plugin_owned_segments()):
        if len(parts) == 2 and method == 'GET':
            return 200, {'plugins': catalog(ctx['state_dir'])}
        if len(parts) == 3 and method == 'POST':
            if set(data) != {'enabled'}:
                return 400, {'error': 'expected enabled boolean only'}
            try:
                items = set_enabled(ctx['state_dir'], parts[2], data['enabled'])
                sync_services(ctx)
                return 200, {'plugins': items}
            except (ValueError, OSError) as exc:
                return 400, {'error': str(exc)}
        return 405, {'error': 'method not allowed'}
    owner = route_owner(parts)
    if owner:
        if not is_enabled(ctx['state_dir'], owner):
            return 403, {'error': 'plugin disabled or dependency unavailable: ' + owner, 'plugin': owner}
        handler = getattr(entrypoint(owner), 'dispatch', None)
        if handler:
            result = handler(method, parts, query, data, ctx)
            if result is not None:
                return result
    # Generic resource repository is kernel storage; individual resource kinds
    # have been checked above, and legacy SDK manifests remain manageable.
    if parts[:2] == ['api', 'resources']:
        from . import resources
        return resources.dispatch(method, parts, query, data, ctx)
    return None


def sync_services(ctx):
    """Apply plugin lifecycle changes at HTTP request boundaries.

    The kernel no longer knows which feature owns a terminal, a browser worker
    or a scheduler: each of those plugins contributes ``activate(scope, ctx)``
    and releases what it acquired when its scope is disposed.
    """
    if ctx.get("handler") is not None:
        ctx = ctx["handler"]._ctx
    policy_sync = ctx.get('native_policy_sync')
    if callable(policy_sync):
        policy_sync()
    registry = ctx.get('plugin_scopes')
    if registry is None:
        with _LOCK:
            registry = ctx.get('plugin_scopes')
            if registry is None:
                registry = ctx['plugin_scopes'] = ScopeRegistry(ctx)
    return registry.sync()


def register_cli_parsers(commands):
    for pid in PLUGIN_IDS:
        register = getattr(entrypoint(pid), 'register_cli', None)
        if register:
            register(commands)
