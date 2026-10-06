"""Experimental tool dry-run: preview a side effect instead of causing it.

Feature ``tools.dry_run_experimental``: with settings key
``general.toolsDryRunEnabled`` (default off, or the operator override
``XUENESS_TOOLS_DRY_RUN``) a registry tool that the existing Gate and registry
classifications count as a side effect no longer runs. ``write`` and ``edit``
answer with the resolved target and a unified diff against the file as it
stands, ``exec`` answers with the exact argv and working directory, and every
other side-effecting tool is refused outright by this plugin's
``before_tool_execution`` participant, because a preview this feature cannot
build is not one it may invent. Read-only tools are untouched.

The switch can only tighten:

* Gate still decides. :func:`guard` asks the same policy the handler would have
  faced -- a copy of the live gate holding no approvals, checked with the very
  subject string the handler hands ``Gate.check`` -- and steps aside when that
  policy refuses, so a plan-mode denial, a disallowed tool, an unknown gate
  kind or a path outside the workspace stays the authentic denial it always
  was, with the same payload.
* Nothing is granted or consumed. The probe holds an empty approval bucket, so a
  call that would have waited for one keeps waiting: the preview reports
  ``requires_approval`` instead of spending it. No ``after_tool_authorization``
  observer (a Git checkpoint, for instance) ever sees a call that dry-run
  answered, because no call was authorized.
* The workspace jail still bounds the preview. Targets resolve through the same
  helper the write handler uses, so a preview can never name a path this server
  would not have written to.
* The flag is read per call from the state directory bound to the run or
  request, and only while this plugin is effective, so toggling needs no
  restart and disabling the plugin restores plain behaviour.

Out of scope, deliberately: MCP calls reach their server through the capability
seam instead of this registry, a PreToolUse hook runs its own command before
dispatch, and delegated sub-agent tasks never enter ``dispatch``. Dry-run is an
operator convenience, not a containment boundary -- Gate, approvals and the
workspace jail remain the only security mechanisms.
"""
from __future__ import annotations

import difflib
import os
import stat
from pathlib import Path

#: Stable ids for the feature catalog and the refusal wording.
FEATURE_ID = 'tools.dry_run_experimental'
PLUGIN_ID = 'tools'
SETTINGS_SECTION = 'general'
SETTINGS_KEY = 'toolsDryRunEnabled'
ENV_FLAG = 'XUENESS_TOOLS_DRY_RUN'
#: The same truthy spellings the other operator environment overrides accept.
ENV_TRUE = ('1', 'true', 'yes', 'on')

#: The gate kinds ``Gate._check`` treats as side effects. Combined with the
#: registry's own ``mutating`` declaration, this is the existing classification
#: this feature borrows -- it adds no new category of its own.
SIDE_EFFECT_GATE_KINDS = frozenset({'write', 'edit', 'exec', 'mcp',
                                    'web_fetch', 'web_search'})
#: The handlers that ask :func:`guard`, each with the gate kind its own handler
#: passes to ``Gate.check``. Keeping the kind here rather than looking it up
#: means the probe is handed exactly the question the handler would have asked.
COOPERATIVE_TOOLS = {'write': 'write', 'edit': 'edit', 'exec': 'exec'}

#: Preview bounds. A tool result travels into the model context and the session
#: journal, so nothing here may grow with the file it describes.
MAX_PREVIEW_CHARS = 2000
MAX_DIFF_CHARS = 4000
MAX_DIFF_LINES = 80
MAX_DIFF_COMPARE_LINES = 4000
MAX_DIFF_COMPARE_CHARS = 200_000
MAX_ARGV_ITEMS = 64
MAX_ARG_CHARS = 300
MAX_SOURCE_BYTES = 1_000_000
MAX_EDIT_ARGUMENT_CHARS = 200_000
MAX_WRITE_CONTENT_CHARS = 200_000


class PreviewUnavailable(Exception):
    """A preview cannot safely describe this target within its bounds."""

    SAFE_REASONS = frozenset({
        'cannot inspect target', 'target is not a regular file',
        'target exceeds preview size limit', 'cannot read existing target',
        'edit arguments exceed preview size limit',
        'diff exceeds comparison limit', 'preview unavailable',
    })

    def __init__(self, reason, *, file_exists=None, readable=None):
        self.reason = reason if reason in self.SAFE_REASONS else 'preview unavailable'
        self.file_exists = file_exists if type(file_exists) is bool else None
        self.readable = readable if type(readable) is bool else None
        super().__init__(self.reason)

def _registry_tool(name):
    from ...tool_registry import REGISTRY_BY_NAME
    return REGISTRY_BY_NAME.get(name)


def side_effecting(name) -> bool:
    """Whether one registry call counts as a side effect here.

    Both existing signals are honoured, whichever a plugin declared: the
    registry's ``mutating`` flag and an approval-bearing gate kind. A name the
    registry does not carry (an MCP tool, a delegation) is not judged at all --
    those paths stay outside this feature, as documented above.
    """
    tool = _registry_tool(name)
    if tool is None:
        return False
    return bool(tool.mutating) or tool.gate_kind in SIDE_EFFECT_GATE_KINDS


def env_enabled() -> bool:
    """The operator override, read fresh so a shell can flip it per invocation."""
    return os.environ.get(ENV_FLAG, '').strip().lower() in ENV_TRUE


def flag_enabled(state_dir) -> bool:
    """The persistent flag, or the environment override, ignoring the switch."""
    if env_enabled():
        return True
    if state_dir is None:
        return False
    from ..settings.settings_store import load_settings
    section = load_settings(state_dir).get(SETTINGS_SECTION, {})
    return isinstance(section, dict) and section.get(SETTINGS_KEY) is True


def active(state_dir) -> bool:
    """On only when the flag says so *and* this plugin is effective.

    A call with no bound state directory has no plugin policy to consult --
    only the environment override can reach it, mirroring how the kernel treats
    those historical low-level callers.
    """
    if not flag_enabled(state_dir):
        return False
    if state_dir is None:
        return True
    from ...plugin_runtime import is_enabled
    return is_enabled(state_dir, PLUGIN_ID)


def _state_dir(gate):
    try:
        from ...tool_contract import execution_context
        context = execution_context()
    except ValueError:
        context = {}
    state_dir = context.get('state_dir')
    if state_dir is None:
        state_dir = getattr(context.get('store'), 'directory', None)
    if state_dir is None:
        state_dir = getattr(gate, 'state_dir', None)
    return state_dir


def _policy_probe(gate):
    """A copy of the live gate's policy that holds no approvals and never asks.

    Only the fields carrying policy travel over, so the copy cannot reach the
    session's one-shot approval buckets or prompt an operator: it answers
    "would this have been refused?" and nothing else. A WebGate keeps its mode,
    disallow set, permission mode and plan-draft policy; its blanket approvals
    live in the buckets, which the copy deliberately does not have.
    """
    from ...core import Gate
    return Gate(Path(getattr(gate, 'root', '.')),
                allow_write=bool(getattr(gate, 'allow_write', False)),
                allow_exec=bool(getattr(gate, 'allow_exec', False)),
                interactive=False,
                mode=getattr(gate, 'mode', 'build'),
                allow_edit=getattr(gate, 'allow_edit', None),
                disallow=getattr(gate, 'disallow', ()),
                allow_mcp=bool(getattr(gate, 'allow_mcp', False)),
                allow_network=bool(getattr(gate, 'allow_network', False)),
                permission_mode=getattr(gate, 'permission_mode', None),
                plan_draft=getattr(gate, 'plan_draft', None),
                hold_remote_exec=bool(getattr(gate, 'hold_remote_exec', False)))


def _probe_policy(gate, kind, subject) -> str:
    """``'allow'``, ``'approval'`` or ``'refuse'`` for one Gate decision.

    ``'approval'`` is not a refusal: it is the pause the caller would have gone
    through, and reporting it is the whole point of a dry run. A probe that
    cannot answer at all reports ``'refuse'``, which hands the call back to the
    handler's own Gate instead of inventing an answer for it.
    """
    try:
        _policy_probe(gate)._check(kind, subject)
    except PermissionError as exc:
        return 'approval' if str(exc).endswith('requires explicit approval') else 'refuse'
    except (OSError, ValueError, KeyError, TypeError):
        return 'refuse'
    return 'allow'


def _current_text(target) -> "str | None":
    try:
        info = target.stat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise PreviewUnavailable('cannot inspect target') from exc
    if not stat.S_ISREG(info.st_mode):
        raise PreviewUnavailable('target is not a regular file',
                                 file_exists=True, readable=False)
    if info.st_size > MAX_SOURCE_BYTES:
        raise PreviewUnavailable('target exceeds preview size limit',
                                 file_exists=True, readable=False)
    try:
        with target.open('rb') as stream:
            raw = stream.read(MAX_SOURCE_BYTES + 1)
        if len(raw) > MAX_SOURCE_BYTES:
            raise PreviewUnavailable('target exceeds preview size limit',
                                     file_exists=True, readable=False)
        return raw.decode('utf-8')
    except PreviewUnavailable:
        raise
    except FileNotFoundError:
        return None
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        # Existing unreadable or non-UTF-8 content is never described as a new
        # file; the guard turns this into a safe, non-executing refusal.
        raise PreviewUnavailable('cannot read existing target',
                                 file_exists=True, readable=False) from exc


def _diff(old: str, new: str, *, file_exists=None) -> dict:
    """A bounded unified-diff summary of what the call would have changed."""
    if old == new:
        return {'changed': False, 'added_lines': 0, 'removed_lines': 0,
                'excerpt': '', 'truncated': False}
    if len(old) + len(new) > MAX_DIFF_COMPARE_CHARS:
        raise PreviewUnavailable('diff exceeds comparison limit',
                                 file_exists=file_exists,
                                 readable=True if file_exists else None)
    old_lines, new_lines = old.splitlines(), new.splitlines()
    if len(old_lines) + len(new_lines) > MAX_DIFF_COMPARE_LINES:
        raise PreviewUnavailable('diff exceeds comparison limit',
                                 file_exists=file_exists,
                                 readable=True if file_exists else None)
    added = removed = 0
    lines: list = []
    for line in difflib.unified_diff(old_lines, new_lines,
                                     fromfile='current', tofile='after', lineterm='', n=1):
        if line.startswith('+++') or line.startswith('---'):
            continue
        if line.startswith('+'):
            added += 1
        elif line.startswith('-'):
            removed += 1
        if len(lines) < MAX_DIFF_LINES:
            lines.append(line)
    excerpt = '\n'.join(lines)
    truncated = len(excerpt) > MAX_DIFF_CHARS or added + removed > len(lines)
    return {'changed': True, 'added_lines': added, 'removed_lines': removed,
            'excerpt': excerpt[:MAX_DIFF_CHARS], 'truncated': truncated}


def _target(root, gate, path) -> Path:
    """Where a write would land, resolved exactly as the write handler resolves it.

    Reuses the files plugin's helper so the plan-mode draft exception cannot
    drift here; a path outside the workspace raises, and :func:`guard` hands the
    call back to the handler, which raises the same denial on its own.
    """
    from ..files.builtin_tools import _mutating_target
    return _mutating_target(gate, root, path)


def _write_preview(root, gate, args):
    path, content = args.get('path'), args.get('content')
    if not isinstance(path, str) or not isinstance(content, str):
        return None  # the handler reports its own argument error, unchanged
    if len(content) > MAX_WRITE_CONTENT_CHARS:
        return None  # the handler rejects this before writing, unchanged
    target = _target(root, gate, path)
    current = _current_text(target)
    return {'action': 'write', 'path': path, 'target': str(target),
            'creates_new_file': current is None,
            'previous_chars': len(current) if current is not None else None,
            'content_chars': len(content),
            'file_exists': current is not None,
            'readable': True if current is not None else None,
            'content_preview': content[:MAX_PREVIEW_CHARS],
            'content_truncated': len(content) > MAX_PREVIEW_CHARS,
            'diff': _diff(current or '', content,
                          file_exists=current is not None)}


def _edit_preview(root, gate, args):
    path, old, new = args.get('path'), args.get('old'), args.get('new')
    if not isinstance(path, str) or not isinstance(old, str) or not isinstance(new, str):
        return None
    if len(old) > MAX_EDIT_ARGUMENT_CHARS or len(new) > MAX_EDIT_ARGUMENT_CHARS:
        raise PreviewUnavailable('edit arguments exceed preview size limit')
    target = _target(root, gate, path)
    current = _current_text(target)
    matches = current.count(old) if (current is not None and old) else 0
    after = current.replace(old, new, 1) if (current is not None and matches == 1) else current
    return {'action': 'edit', 'path': path, 'target': str(target),
            'old_chars': len(old), 'new_chars': len(new),
            'matches': matches, 'would_apply': matches == 1,
            'file_exists': current is not None,
            'readable': True if current is not None else None,
            'diff': _diff(current or '', after or '',
                          file_exists=current is not None)}


def _exec_preview(root, gate, args):
    argv = args.get('argv')
    if (not isinstance(argv, list) or not argv
            or any(not isinstance(item, str) or not item for item in argv)):
        return None
    truncated = len(argv) > MAX_ARGV_ITEMS or any(len(item) > MAX_ARG_CHARS for item in argv)
    return {'action': 'exec', 'argv': [item[:MAX_ARG_CHARS] for item in argv[:MAX_ARGV_ITEMS]],
            'argv_truncated': truncated, 'cwd': str(Path(root).resolve()),
            'shell': False, 'would_filter_secrets_from_environment': True}


_PREVIEWS = {'write': _write_preview, 'edit': _edit_preview, 'exec': _exec_preview}


def _result(name: str, kind: str, payload: dict, requires_approval: bool) -> dict:
    return {'ok': False, 'error': 'dry_run', 'error_code': 'dry_run_preview',
            'dry_run': True, 'feature': FEATURE_ID, 'tool': name, 'gate_kind': kind,
            'executed': False, 'awaiting_approval': False, 'retryable': False,
            'requires_approval': requires_approval, 'preview': payload,
            'user_reason': ('工具干跑已开启（' + FEATURE_ID + '）：本次调用没有执行，preview 是它将执行的预览。'
                            if requires_approval else
                            '工具干跑已开启（' + FEATURE_ID + '）：权限策略本会放行，但本次调用没有执行，'
                            'preview 是它将执行的预览。')}


def guard(root, gate, name, subject, args):
    """The dry-run answer for one side-effecting handler, or ``None`` to run it.

    ``None`` means "nothing to see here, carry on exactly as before": the switch
    is off, this plugin is not effective, the policy already refuses this call,
    or the arguments are malformed enough that the handler would reject them
    itself before touching anything. ``subject`` must be exactly the string the
    handler hands ``Gate.check``: the probe is only faithful when it is asked
    the same question.

    A handler therefore keeps its own Gate call as the authority for every
    denial, and this feature only replaces the effect.
    """
    if name not in COOPERATIVE_TOOLS or not isinstance(args, dict):
        return None
    # Let the handler report malformed inputs without charging a budget for an
    # effect it would reject before any preview or side effect.
    if name == 'write':
        if (not isinstance(args.get('path'), str)
                or not isinstance(args.get('content'), str)
                or len(args['content']) > MAX_WRITE_CONTENT_CHARS):
            return None
    elif name == 'edit':
        if (not isinstance(args.get('path'), str)
                or not isinstance(args.get('old'), str)
                or not isinstance(args.get('new'), str)
                or len(args['old']) > MAX_EDIT_ARGUMENT_CHARS
                or len(args['new']) > MAX_EDIT_ARGUMENT_CHARS):
            return None
    elif name == 'exec':
        argv = args.get('argv')
        if (not isinstance(argv, list) or not argv
                or any(not isinstance(item, str) or not item for item in argv)):
            return None
    if not active(_state_dir(gate)):
        return None
    verdict = _probe_policy(gate, COOPERATIVE_TOOLS[name], subject)
    if verdict == 'refuse':
        return None
    # A preview is itself a settled tool call for budget purposes. The probe
    # above first preserves Gate refusals and approval semantics.
    try:
        from .call_budget import reserve
        from ...tool_contract import execution_context
        context = execution_context()
        budget_denial = reserve(context.get('state_dir'),
                                context.get('session'), context.get('store'))
        if budget_denial is not None:
            return budget_denial
    except ValueError:
        # Historical calls without an execution binding have no persistent
        # plugin policy or counter to consult.
        pass
    try:
        payload = _PREVIEWS[name](root, gate, args)
    except PermissionError:
        return None  # boundary denial: the handler raises the same one itself
    except PreviewUnavailable as exc:
        payload = {'action': name, 'preview_unavailable': True,
                   'reason': exc.reason}
        if exc.file_exists is not None:
            payload['file_exists'] = exc.file_exists
        if exc.readable is not None:
            payload['readable'] = exc.readable
    except (OSError, ValueError, KeyError, TypeError):
        # A preview this feature cannot describe must still not be executed.
        payload = {'action': name, 'preview_unavailable': True,
                   'reason': 'preview unavailable'}
    if payload is None:
        return None
    return _result(name, COOPERATIVE_TOOLS[name], payload, verdict == 'approval')


def before_tool_execution(payload):
    """Refuse a side-effecting registry call that has no dry-run preview.

    Runs at the kernel's pre-dispatch seam, so it also covers the tools of
    other plugins. Under dry-run an un-instrumented side effect is never simply
    executed: the safe answer is a refusal, which tightens the policy without
    ever loosening it. Cheap checks come first because this sees every registry
    call, read-only ones included.
    """
    if not isinstance(payload, dict):
        return None
    name = payload.get('tool')
    if not isinstance(name, str) or name in COOPERATIVE_TOOLS or not side_effecting(name):
        return None
    if not active(payload.get('state_dir')):
        return None
    return {'decision': 'deny',
            'reason': ('工具干跑已开启（' + FEATURE_ID + '）：' + str(name)
                       + ' 属于副作用工具且没有干跑预览，已拒绝执行。'
                       ' / Dry run is on: ' + str(name)
                       + ' is a side-effecting tool with no preview, so it was refused.')}
