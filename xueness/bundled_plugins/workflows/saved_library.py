"""Named saved-workflow templates: a durable library of validated plan data.

A saved workflow is one JSON file under ``<state>/workflows/saved`` holding a
plan that ``validate_plan`` accepted at save time, plus bounded metadata. A
template is data, never code: it can only contain the declarative node fields
the DAG engine already accepts, and instantiating one goes through the same
``WorkflowStore.create``/``launch`` validation, Gate checks and approvals as a
hand-written plan — this module adds no runtime, no permission surface and no
executable content.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

from ...resources import _atomic_write_json, _is_link, _protect_private_directory
from ...session_lease import exclusive_lock
from .workflows import WorkflowStore, validate_plan

#: Template names are file names, so the charset is deliberately narrow: no
#: separators, whitespace or leading dots, and never a Windows reserved device
#: base name. A name therefore always maps to one file directly inside the
#: library directory and cannot traverse anywhere else.
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z')
MAX_DESCRIPTION = 500
_RESERVED_BASES = frozenset(
    ['con', 'prn', 'aux', 'nul'] + [f'com{i}' for i in range(1, 10)] + [f'lpt{i}' for i in range(1, 10)])


def validate_name(value):
    """Return the canonical template name, or raise ``ValueError``."""
    if (not isinstance(value, str) or not NAME.fullmatch(value)
            or value.split('.', 1)[0].casefold() in _RESERVED_BASES):
        raise ValueError('saved workflow name must be 1..64 characters of letters, '
                         'digits, dot, dash or underscore, starting with a letter or digit')
    return value


def template_plan_digest(plan):
    """Root-independent digest binding an approval to the exact template plan."""
    body = json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(body.encode('utf-8')).hexdigest()


def _source_plan(state_dir, workflow_id, workspace):
    """The plan of one existing durable run, only inside the given workspace."""
    workspace = Path(workspace).resolve()
    record = WorkflowStore(state_dir).load(workflow_id)
    if record.get('root') != str(workspace):
        raise PermissionError('workflow belongs to another workspace')
    return record['plan'], {'kind': 'run', 'workflow_id': record['id']}


def _latest_run_plan(state_dir, workspace):
    """The most recently updated run plan inside the given workspace."""
    workspace = Path(workspace).resolve()
    store = WorkflowStore(state_dir)
    for item in store.list():  # already sorted by updated_at, newest first
        try:
            record = store.load(item['id'])
        except (OSError, ValueError, KeyError):
            continue
        if record.get('root') == str(workspace):
            return record['plan'], {'kind': 'run', 'workflow_id': record['id']}
    raise ValueError('no workflow runs exist in this workspace yet')


class SavedWorkflowLibrary:
    """Per-template JSON storage under ``<state>/workflows/saved``."""

    def __init__(self, state):
        state_path = Path(state)
        if _is_link(state_path):
            raise ValueError('saved workflow state directory cannot be a symlink')
        self.state = state_path.resolve()
        self.directory = self.state / 'workflows' / 'saved'
        # The parent directories are checked before mkdir: a junction or
        # symlinked component would redirect the whole library.
        parent = self.state / 'workflows'
        if _is_link(parent) or _is_link(self.directory):
            raise ValueError('saved workflow library cannot be a symlink')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        _protect_private_directory(self.directory)

    def _ensure_safe_directories(self):
        if (_is_link(self.state) or _is_link(self.state / 'workflows')
                or _is_link(self.directory)):
            raise ValueError('saved workflow library cannot be a symlink')

    def path(self, name):
        self._ensure_safe_directories()
        path = self.directory / (validate_name(name) + '.json')
        if _is_link(path):
            raise ValueError('saved workflow file cannot be a symlink')
        return path

    def _lock(self, name):
        """Coordinate one template's reads and replacements across processes."""
        self._ensure_safe_directories()
        return exclusive_lock(self.directory / '.locks', 'saved-' + validate_name(name) + '.lock')

    def save(self, plan, name, root, *, description=None, overwrite=False, source=None):
        """Validate a plan against ``root`` and persist it as one named template.

        Saving never reuses an existing name silently: replacing a template
        requires the explicit ``overwrite`` decision, because the previous
        content is destroyed in the same atomic replace.
        """
        name = validate_name(name)
        root = Path(root).resolve()
        plan = validate_plan(plan, root)
        if type(overwrite) is not bool:
            raise ValueError('overwrite must be a boolean')
        if description is None:
            description = ''
        if not isinstance(description, str) or len(description) > MAX_DESCRIPTION:
            raise ValueError('description must be a string up to %d characters' % MAX_DESCRIPTION)
        description = description.strip()
        record = {'name': name, 'description': description, 'plan': plan,
                  'plan_digest': template_plan_digest(plan), 'node_count': len(plan['nodes']),
                  'concurrency': plan['concurrency'], 'saved_at': time.time(),
                  'updated_at': time.time()}
        if isinstance(source, dict):
            record['source'] = source
        with self._lock(name):
            path = self.path(name)
            if path.exists() and not overwrite:
                raise ValueError("saved workflow '%s' already exists; pass overwrite to replace it" % name)
            _atomic_write_json(path, record)
        return self.view(record)

    def load(self, name):
        name = validate_name(name)
        with self._lock(name):
            path = self.path(name)
            try:
                record = json.loads(path.read_text(encoding='utf-8'))
            except FileNotFoundError:
                raise ValueError('unknown saved workflow: %s' % name) from None
        if not isinstance(record, dict) or not isinstance(record.get('plan'), dict):
            raise ValueError('saved workflow record is damaged: %s' % name)
        return record

    def list(self):
        self._ensure_safe_directories()
        rows = []
        for path in self.directory.glob('*.json'):
            try:
                name = validate_name(path.stem)
            except ValueError:
                continue
            try:
                with self._lock(name):
                    record_path = self.path(name)
                    record = json.loads(record_path.read_text(encoding='utf-8'))
                rows.append(self.view(record))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return sorted(rows, key=lambda row: row['updated_at'], reverse=True)

    def view(self, record):
        """Listing projection: name, description, node count and times only."""
        plan = record.get('plan') or {}
        return {'name': record['name'], 'description': record.get('description', ''),
                'node_count': len(plan.get('nodes', [])),
                'concurrency': record.get('concurrency'),
                'plan_name': plan.get('name'), 'plan_digest': record.get('plan_digest'),
                'saved_at': record.get('saved_at'), 'updated_at': record.get('updated_at')}


def add_parsers(commands):
    """Register the ``xueness workflows`` command group owned by this plugin."""
    group = commands.add_parser('workflows', help='named saved workflow templates: save, list, run')
    sub = group.add_subparsers(dest='action', required=True)
    save = sub.add_parser('save', help='save a plan/DSL file or an existing run as a named template')
    save.add_argument('name')
    save.add_argument('file', type=Path, nargs='?', help='plan JSON (.json) or DSL script (.py)')
    save.add_argument('--root', type=Path, required=True, help='workspace the plan is validated against')
    save.add_argument('--description', help='human-readable template description')
    save.add_argument('--overwrite', action='store_true', help='replace an existing template of this name')
    save.add_argument('--from-run', dest='from_run', help='save the plan of this workflow run id')
    save.add_argument('--latest', action='store_true', help='save the most recent run in the workspace')
    sub.add_parser('list', help='list saved templates (JSON)')
    run = sub.add_parser('run', help='instantiate a saved template in a workspace and start it')
    run.add_argument('name')
    run.add_argument('--root', type=Path, required=True)
    run.add_argument('--approve', action='store_true', help='approve the exact stored command plan')
    run.add_argument('--allow-real', action='store_true', help='allow model calls by agent nodes')


def execute_cli(args):
    """CLI face over the same library and store the model tools use."""
    from .dsl import compile_workflow_script
    state_dir = Path(args.state)
    library = SavedWorkflowLibrary(state_dir)
    if args.action == 'list':
        return {'ok': True, 'saved': library.list()}
    root = args.root.resolve()
    if args.action == 'save':
        chosen = [args.file is not None, bool(args.from_run), bool(args.latest)]
        if sum(chosen) != 1:
            raise ValueError('provide exactly one of a plan/script file, --from-run or --latest')
        if args.file is not None:
            text = args.file.read_text(encoding='utf-8')
            if args.file.suffix.casefold() == '.py':
                plan, source = compile_workflow_script(text, root, args.file.stem), {'kind': 'script'}
            else:
                plan, source = json.loads(text), {'kind': 'plan'}
        elif args.from_run:
            plan, source = _source_plan(state_dir, args.from_run, root)
        else:
            plan, source = _latest_run_plan(state_dir, root)
        saved = library.save(plan, args.name, root, description=args.description,
                             overwrite=bool(args.overwrite), source=source)
        return {'ok': True, 'saved': saved}
    record = library.load(args.name)
    created = WorkflowStore(state_dir).create(record['plan'], root)
    return WorkflowStore(state_dir).launch(created['id'], approved=bool(args.approve),
                                           allow_real=bool(args.allow_real))
