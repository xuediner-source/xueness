"""Automation HTTP and scheduler contributions."""
from .scheduler import Automations, Scheduler

def create_service(state,allow_real=False): return Scheduler(state,allow_real=allow_real)


def activate(scope, ctx):
    """Run the local cron scheduler while the host serves plugins.

    The host decides whether background triggering may start at all: a server
    that has closed admission for an update, or one that never serves plugins,
    must not gain a scheduler here.
    """
    state_dir = ctx['state_dir']

    def acquire():
        scheduler = ctx.get('automation_service')
        if scheduler is not None:
            return scheduler
        if not ctx.get('serve_plugins') or ctx.get('admission_closed'):
            return None
        scheduler = create_service(state_dir, allow_real=ctx.get('allow_real', False))
        ctx['automation_service'] = scheduler
        return scheduler

    def release(scheduler):
        scheduler.close()
        if ctx.get('automation_service') is scheduler:
            ctx['automation_service'] = None

    scope.ensure('automation.scheduler', acquire, release,
                 live=lambda scheduler: ctx.get('automation_service') is scheduler)


def dispatch(method,parts,query,data,ctx):
    if parts[:2]!=['api','automations']: return None
    try:
        store=Automations(ctx['state_dir'])
        if len(parts)==2:
            if method=='GET': return 200,{'automations':store.list()}
            if method=='POST': return 201,{'automation':store.save(data)}
        if len(parts)==3:
            if method in ('PATCH','POST'): return 200,{'automation':store.save(data,parts[2])}
            if method=='DELETE': return 200,store.delete(parts[2])
        if len(parts)==4 and method=='POST':
            if parts[3]=='run': return 200,{'run':store.run(parts[2],allow_real_host=ctx.get('allow_real',False))}
            if parts[3]=='approve' and data.get('allowReal') is True and not ctx.get('allow_real',False): return 403,{'error':'real provider disabled by host'}
            if parts[3]=='approve' and data.get('confirmed') is True: return 200,{'automation':store.approve(parts[2],data.get('allowReal',False))}
        return 405,{'error':'method not allowed'}
    except (ValueError,OSError,KeyError,StopIteration): return 400,{'error':'invalid automation or unknown ID'}


def register_cli(commands):
    group=commands.add_parser('automation',help='manage local cron schedules')
    sub=group.add_subparsers(dest='automation_action',required=True)
    sub.add_parser('list')
    create=sub.add_parser('create');create.add_argument('file')
    for name in ('run','approve','delete'):
        parser=sub.add_parser(name);parser.add_argument('id')
        if name=='approve': parser.add_argument('--allow-real-provider',action='store_true');parser.add_argument('--approve-execution',action='store_true')
        if name=='run': parser.add_argument('--allow-real-provider',action='store_true')
    daemon=sub.add_parser('daemon');daemon.add_argument('--allow-real-provider',action='store_true')


def execute_cli(args):
    import json,sys,time
    from pathlib import Path
    from ...plugin_runtime import require_enabled
    try:
        require_enabled(args.state,'automation');store=Automations(args.state)
        action=args.automation_action
        if action=='list': result={'automations':store.list()}
        elif action=='create':
            raw=Path(args.file).read_bytes()
            if len(raw)>100000: raise ValueError('automation document too large')
            result=store.save(json.loads(raw))
        elif action=='delete': result=store.delete(args.id)
        elif action=='approve':
            if not args.approve_execution: raise ValueError('--approve-execution is required after reviewing the immutable plan')
            result=store.approve(args.id,args.allow_real_provider)
        elif action=='run': result=store.run(args.id,allow_real_host=args.allow_real_provider)
        elif action=='daemon':
            service=Scheduler(args.state,allow_real=args.allow_real_provider)
            try:
                while True: time.sleep(1)
            except KeyboardInterrupt: service.close()
            return 0
        else: raise ValueError('unknown automation command')
        print(json.dumps(result,ensure_ascii=False,indent=2));return 0
    except (ValueError,OSError,KeyError,StopIteration) as error:
        print('ERROR: '+str(error),file=sys.stderr);return 1
