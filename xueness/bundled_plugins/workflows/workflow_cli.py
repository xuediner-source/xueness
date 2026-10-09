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
    dwf = sub.add_parser('dwf', help="one session's dynamic workflow runs: list, cancel, resume")
    dwf.add_argument('dwf_action', nargs='?', default='list', choices=('list', 'cancel', 'resume'))
    dwf.add_argument('run', nargs='?', help='run id for cancel/resume')
    dwf.add_argument('--session', required=True, help='owning session id')
    dwf.add_argument('--approve', action='store_true', help='approve re-running the stored command plan')
    dwf.add_argument('--allow-real', action='store_true', help='allow model calls by agent nodes')
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
    expert = commands.add_parser('expert',
                                 help='durable expert workflow: research -> plan -> implement -> review')
    expert.add_argument('task', nargs='*', help='task text, or status|resume|stop')
    expert.add_argument('--session', help='bind a new run to / select runs of a session id')
    expert.add_argument('--run', help='operate on an explicit expert run id')
    expert.add_argument('--answer', help='resume: answer a waiting implement-phase actor')
    expert.add_argument('--root', type=Path, help='workspace for a new run (default: current directory)')


def execute(args):
    if args.cmd == 'expert':
        from . import expert
        return expert.execute_cli(args)
    if args.action == 'dwf':
        # Same implementation the web API and the chat /dwf command call.
        from . import dynamic_runs
        return dynamic_runs.execute_cli(args)
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
        source = args.file.read_text(encoding='utf-8')
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
