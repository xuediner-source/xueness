"""Named SSH connections; host keys must already be trusted by the operator.

Remote commands are quoted for a POSIX shell (``shlex``). A connection may
declare ``system`` as ``posix`` (the default when the field is absent) or
``windows``. Windows means the remote shell is cmd or PowerShell; execution is
refused before approval and before SSH, because those shells do not honor
POSIX quoting. Saving a connection without ``system`` keeps a previously
stored value, so a client that does not yet send the field cannot silently
turn a Windows host back into a POSIX command.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
from ...resources import _atomic_write_json
from ...tool_contract import BuiltinTool,execution_context
from ...plugin_runtime import _config_lock

_REMOTE_FIELDS = {'id', 'host', 'user', 'port', 'directory', 'system'}
_REMOTE_SYSTEMS = {'posix', 'windows'}
_WINDOWS_REMOTE_ERROR = (
    'remote Windows hosts are not supported (system=windows): commands are '
    'quoted for a POSIX shell and cannot be run safely on cmd or PowerShell')


def _load(state):
    path=Path(state).resolve()/'remote-connections.json'
    if path.is_symlink(): raise ValueError('remote state symlink denied')
    try:
        fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError('remote state must be a regular file')
            with os.fdopen(fd,'rb',closefd=False) as stream: raw=stream.read(100001)
        finally:
            os.close(fd)
        if len(raw)>100000: raise ValueError('remote configuration too large')
        rows=json.loads(raw)
        if not isinstance(rows,list) or len(rows)>100: raise ValueError('invalid remote configuration')
        checked=[_validate(row) for row in rows]
        ids=[row['id'] for row in checked]
        if len(ids)!=len(set(ids)): raise ValueError('duplicate remote connection id')
        return checked
    except FileNotFoundError: return []

def _validate(row):
    if not isinstance(row,dict) or set(row)-_REMOTE_FIELDS: raise ValueError('invalid remote fields')
    for key,pattern in [('id',r'[A-Za-z0-9_-]{1,64}'),('host',r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}'),('user',r'[A-Za-z_][A-Za-z0-9_-]{0,63}')]:
        if not isinstance(row.get(key),str) or not re.fullmatch(pattern,row[key]): raise ValueError('invalid remote '+key)
    if type(row.get('port',22)) is not int or not 1<=row.get('port',22)<=65535: raise ValueError('invalid remote port')
    if not isinstance(row.get('directory','.'),str) or len(row.get('directory','.'))>1000 or '\0' in row.get('directory','.'): raise ValueError('invalid remote directory')
    if row.get('system', 'posix') not in _REMOTE_SYSTEMS: raise ValueError('invalid remote system')
    return row

def _keep_saved_system(row, previous):
    """Keep a stored ``system`` when this save does not mention the field."""
    if 'system' not in row and isinstance(previous, dict) and 'system' in previous:
        return {**row, 'system': previous['system']}
    return row

def _require_posix_remote(row):
    """Refuse Windows remotes before a POSIX-quoted command is built or run."""
    system = row.get('system', 'posix')
    if system == 'windows':
        raise ValueError(_WINDOWS_REMOTE_ERROR)
    if system != 'posix':
        raise ValueError('invalid remote system')

def _ssh_creationflags():
    """Hide the console on a local Windows ssh client; other hosts pass 0."""
    return getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0

def _subject(args): return json.dumps(args,sort_keys=True,separators=(',',':'),ensure_ascii=False)

def _digest(row): return hashlib.sha256(json.dumps(row,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def _exec(root,gate,args,session,call_id):
    state=execution_context()['state_dir'];row=next((_validate(x) for x in _load(state) if x.get('id')==args.get('connection')),None)
    if row is None: raise ValueError('connection unavailable')
    _require_posix_remote(row)
    argv=args.get('argv')
    if not isinstance(argv,list) or not argv or len(argv)>128 or any(not isinstance(x,str) or not x or '\0' in x or len(x)>16000 for x in argv): raise ValueError('literal argv required')
    # Bind the exact current connection configuration as well as argv.
    expected=json.dumps(row,sort_keys=True,separators=(',',':'))
    if args.get('connection_digest')!=__import__('hashlib').sha256(expected.encode()).hexdigest(): raise ValueError('connection changed; inspect configuration again')
    gate.check('exec',_subject(args),call_id)
    command='cd -- '+shlex.quote(row.get('directory','.'))+' && exec '+shlex.join(argv)
    from ...process_runtime import run_external
    proc=run_external(subprocess.run,['ssh','-F',os.devnull,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-p',str(row.get('port',22)),row['user']+'@'+row['host'],command],cwd=root,text=True,capture_output=True,timeout=40,creationflags=_ssh_creationflags(),env={k:v for k,v in os.environ.items() if not re.search('KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL',k,re.I)})
    return {'ok':proc.returncode==0,'exit_code':proc.returncode,'output':(proc.stdout+proc.stderr)[:16000]}

REGISTRY=(BuiltinTool('remote_exec','Run literal argv on a configured POSIX SSH host; trusted host key and exact action approval required. Connections declared system=windows (cmd or PowerShell) are refused.',{'connection':{'type':'string'},'connection_digest':{'type':'string'},'argv':{'type':'array','items':{'type':'string'}}},('connection','connection_digest','argv'),'exec',True,_exec,_subject),)
def tools(): return REGISTRY

def dispatch(method,parts,query,data,ctx):
    if parts[:2]!=['api','remote']: return None
    try:
        if len(parts)==2 and method=='GET':
            import hashlib
            return 200,{'connections':[{**x,'digest':hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()} for x in _load(ctx['state_dir'])]}
        if len(parts)==2 and method=='POST':
            row=_validate(data)
            with _config_lock(ctx['state_dir']):
                existing=_load(ctx['state_dir'])
                previous=next((item for item in existing if item.get('id')==row['id']), None)
                row=_keep_saved_system(row, previous)
                rows=[x for x in existing if x.get('id')!=row['id']]
                if len(rows)>=100: raise ValueError('remote connections capped at 100')
                _atomic_write_json(Path(ctx['state_dir'])/'remote-connections.json',rows+[row])
            return 200,{'connection':row}
        if len(parts)==3 and method=='DELETE':
            with _config_lock(ctx['state_dir']): _atomic_write_json(Path(ctx['state_dir'])/'remote-connections.json',[x for x in _load(ctx['state_dir']) if x.get('id')!=parts[2]])
            return 200,{'deleted':parts[2]}
        return 405,{'error':'method not allowed'}
    except (ValueError,OSError): return 400,{'error':'invalid remote connection'}


def register_cli(commands):
    group=commands.add_parser('remote',help='manage explicitly approved named SSH connections')
    sub=group.add_subparsers(dest='remote_action',required=True)
    sub.add_parser('list',help='list saved SSH connection metadata')
    save=sub.add_parser('save',help='save a named SSH connection')
    save.add_argument('id'); save.add_argument('--host',required=True); save.add_argument('--user',required=True)
    save.add_argument('--port',type=int,default=22); save.add_argument('--directory',default='.')
    save.add_argument('--system', choices=('posix', 'windows'), default=None,
                      help='remote shell family; windows is stored but execution is refused')
    remove=sub.add_parser('remove',help='remove a saved SSH connection'); remove.add_argument('id')
    run=sub.add_parser('exec',help='run literal remote argv (requires exact interactive approval or --allow-exec)')
    run.add_argument('id'); run.add_argument('--root',type=Path,default=Path.cwd())
    run.add_argument('--allow-exec',action='store_true',help='approve this remote execution for the invocation')
    run.add_argument('argv',nargs=argparse.REMAINDER,help='remote argv after --')
    server=commands.add_parser('app-server',
        help='serve JSON-RPC 2.0 over stdio for an IDE or external frontend (never opens a network port)')
    server.add_argument('--web-runs',type=Path,default=None,metavar='PATH',
                        help='server-owned workspace parent (default the repository .web-runs)')
    server.add_argument('--workspace-root',action='append',type=Path,default=[],metavar='PATH',
                        help='allow an existing host workspace directory (repeatable)')
    server.add_argument('--allow-real-provider',dest='allow_real',action='store_true',default=None,
                        help='allow online provider runs (default follows XUENESS_ALLOW_REAL)')
    server.add_argument('--no-real-provider',dest='allow_real',action='store_false',
                        help='refuse online provider runs for this server')


def execute_cli(args):
    # The stdio server owns its own loop, streams and exit code; it must not be
    # wrapped in the connection-store lock or the JSON summary print below.
    if getattr(args,'cmd',None)=='app-server':
        from . import app_server
        return app_server.run(Path(args.state),web_runs=getattr(args,'web_runs',None),
                              workspace_roots=getattr(args,'workspace_root',()),
                              allow_real=getattr(args,'allow_real',None))
    state=Path(args.state)
    try:
        with _config_lock(state):
            rows=_load(state)
            if args.remote_action=='list':
                result={'connections':[{**row,'digest':_digest(row)} for row in rows]}
            elif args.remote_action=='save':
                row=_validate({'id':args.id,'host':args.host,'user':args.user,
                               'port':args.port,'directory':args.directory})
                system=getattr(args, 'system', None)
                if system is not None:
                    row['system']=system
                    row=_validate(row)
                previous=next((item for item in rows if item.get('id')==row['id']), None)
                row=_keep_saved_system(row, previous)
                rows=[item for item in rows if item.get('id')!=row['id']]
                if len(rows)>=100: raise ValueError('remote connections capped at 100')
                _atomic_write_json(state/'remote-connections.json',rows+[row])
                result={'connection':row,'digest':_digest(row)}
            elif args.remote_action=='remove':
                if not any(row.get('id')==args.id for row in rows): raise ValueError('connection not found')
                _atomic_write_json(state/'remote-connections.json',[row for row in rows if row.get('id')!=args.id])
                result={'deleted':args.id}
            else:
                row=next((item for item in rows if item.get('id')==args.id),None)
                if row is None: raise ValueError('connection not found')
                argv=args.argv[1:] if args.argv and args.argv[0]=='--' else args.argv
                if not argv: raise ValueError('remote argv required after --')
                from ...core import Gate
                from ...tool_contract import bind_execution
                from ...cli import _approval_prompt
                call={'connection':args.id,'connection_digest':_digest(row),'argv':argv}
                root=Path(args.root).resolve()
                if not root.is_dir(): raise ValueError('approval workspace must already exist')
                gate=Gate(root,allow_exec=bool(args.allow_exec),interactive=True,
                          approval_prompt=_approval_prompt)
                with bind_execution(state_dir=state):
                    result=_exec(root,gate,call,None,None)
    except (OSError,ValueError,PermissionError,subprocess.TimeoutExpired) as exc:
        print(json.dumps({'error':str(exc)},ensure_ascii=False),file=__import__('sys').stderr)
        return 1
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if result.get('ok',True) else 2
