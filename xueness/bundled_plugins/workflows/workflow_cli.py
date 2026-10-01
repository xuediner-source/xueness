"""Workflow controls and one-command background jobs."""
import json
import time
from pathlib import Path
from ...workflows import WorkflowStore, ACTIVE


def add_parsers(commands):
    group = commands.add_parser('workflow', help='durable workflows: create, start/resume, pause, cancel, reuse')
    sub = group.add_subparsers(dest='action', required=True)
    create = sub.add_parser('create')
    create.add_argument('file', type=Path)
    create.add_argument('--root', type=Path, required=True)
    create.add_argument('--reuse', help='reuse unchanged completed nodes from a settled run')
    sub.add_parser('list')
    for action in ('show', 'start', 'resume', 'pause', 'cancel', 'recover', 'concurrency', 'logs', 'wait'):
        p = sub.add_parser(action)
        p.add_argument('id')
        if action in ('start', 'resume'):
            p.add_argument('--approve', action='store_true', help='approve the exact stored command plan')
            p.add_argument('--allow-real', action='store_true', help='allow model calls by agent nodes')
        if action == 'concurrency':
            p.add_argument('limit', type=int)
        if action == 'logs':
            p.add_argument('node')
        if action == 'wait':
            p.add_argument('--timeout', type=float, default=60)
    jobs = commands.add_parser('jobs', help='background commands using the workflow runner')
    sub = jobs.add_subparsers(dest='action', required=True)
    sub.add_parser('list')
    start = sub.add_parser('start')
    start.add_argument('--root', type=Path, required=True)
    start.add_argument('--timeout', type=float, default=300)
    start.add_argument('--approve', action='store_true')
    start.add_argument('argv', nargs='+', help='literal argv (use -- before command flags)')
    for action in ('show', 'cancel', 'logs', 'wait'):
        p = sub.add_parser(action)
        p.add_argument('id')
        if action == 'wait':
            p.add_argument('--timeout', type=float, default=60)


def execute(args):
    store = WorkflowStore(args.state)
    action = args.action
    if action == 'list':
        return {'workflows': store.list()}
    if args.cmd == 'jobs' and action == 'start':
        if not args.approve:
            raise ValueError('jobs start requires --approve for the specified argv')
        plan = {'name': args.argv[0], 'nodes': [{'id': 'command', 'argv': args.argv, 'timeout': args.timeout}]}
        record = store.create(plan, args.root)
        return store.launch(record['id'], approved=True)
    if action == 'create':
        source = args.file.read_text()
        if args.file.suffix.casefold() == '.py':
            from .dsl import compile_workflow_script
            plan = compile_workflow_script(source, args.root, args.file.stem)
        else:
            plan = json.loads(source)
        return store.create(plan, args.root, args.reuse)
    if action in ('start', 'resume'):
        return store.launch(args.id, approved=args.approve, allow_real=args.allow_real)
    if action == 'show':
        return store.load(args.id)
    if action == 'logs':
        return store.log(args.id, 'command' if args.cmd == 'jobs' else args.node)
    if action == 'wait':
        if not 0 < args.timeout <= 3600:
            raise ValueError('wait timeout must be 0..3600')
        end = time.monotonic() + args.timeout
        while True:
            record = store.load(args.id)
            if record['status'] not in ACTIVE or time.monotonic() >= end:
                return record
            time.sleep(.1)
    return store.control(args.id, action, getattr(args, 'limit', None))
