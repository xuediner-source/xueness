"""Local Git mutations and recoverable workspace checkpoints.

No shell, remote verbs or force flags. Checkpoints use a temporary index so
staged changes survive snapshots. Restore first saves a recovery checkpoint.
"""
from __future__ import annotations
import os
import re
import subprocess
import tempfile
import uuid
from pathlib import Path
from ...session_lease import lease
from ...process_runtime import run_external
from .git_api import GitApiError

ID_RE=re.compile(r'[0-9a-f]{32}')
LOCKED=('stage','unstage','commit','branch','stash','checkpoints','init')

def _git(root,argv,env=None,stdin=None,raw=False):
    try:
        proc=run_external(subprocess.run,['git',*argv],cwd=root,env={**os.environ,**(env or {}),'GIT_TERMINAL_PROMPT':'0'},input=stdin,text=True,capture_output=True,timeout=15,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0) if os.name=='nt' else 0)
    except (OSError,subprocess.TimeoutExpired): raise GitApiError(400,'Git operation failed') from None
    if proc.returncode: raise GitApiError(409,'Git operation failed; review repository state')
    return proc.stdout if raw else proc.stdout.strip()

def _nul_paths(root,argv):
    return {item for item in _git(root,argv,raw=True).split('\0') if item}

def _path_overlap(left,right):
    return (left == right or left.startswith(right.rstrip('/') + '/')
            or right.startswith(left.rstrip('/') + '/'))

def _refuse_ignored_restore_conflicts(root,head,commit):
    """Do not overwrite ignored workspace data absent from recovery snapshots.

    A non-ignored untracked file is captured by ``checkpoint``. An ignored file
    is not, so if it occupies a path the restore would write or remove, refuse
    before changing either the worktree or Git refs.
    """
    affected = _nul_paths(root,['ls-tree','-r','--name-only','-z',head,'--','.'])
    affected.update(_nul_paths(root,['ls-tree','-r','--name-only','-z',commit,'--','.']))
    index_paths = _nul_paths(root,['ls-files','--cached','-z','--','.'])
    affected.update(index_paths)
    ignored = _nul_paths(root,['ls-files','--others','--ignored','--exclude-standard',
                               '-z','--','.'])
    # ``--others`` omits paths force-added to the real index even when an
    # ignore rule matches. They still will not be present in our HEAD-based
    # temporary recovery index, so identify ignored cached entries separately.
    ignored.update(_nul_paths(root,['ls-files','--cached','--ignored',
                                    '--exclude-standard','-z','--','.']))
    if any(_path_overlap(path, candidate)
           for path in ignored for candidate in affected):
        raise GitApiError(409,'Ignored files overlap the checkpoint; move them before restoring')

def checkpoints(root):
    raw=_git(root,['for-each-ref','--format=%(refname:short)%09%(objectname)%09%(contents:subject)','refs/xueness/checkpoints/'])
    return [{'id':x[0].rsplit('/',1)[-1],'hash':x[1],'message':x[2]} for row in raw.splitlines() if len(x:=row.split('\t',2))==3][-100:]

def checkpoint(root,message='Workspace checkpoint'):
    if not isinstance(message,str) or not message.strip() or len(message)>500: raise ValueError('message required (max 500)')
    head=_git(root,['rev-parse','HEAD'])
    fd,name=tempfile.mkstemp(prefix='xueness-index-');os.close(fd);os.unlink(name)
    env={'GIT_INDEX_FILE':name,'GIT_AUTHOR_NAME':'Xueness','GIT_AUTHOR_EMAIL':'local@xueness','GIT_COMMITTER_NAME':'Xueness','GIT_COMMITTER_EMAIL':'local@xueness'}
    try:
        _git(root,['read-tree',head],env)
        _git(root,['add','--all','--','.'],env)
        tree=_git(root,['write-tree'],env)
        commit=_git(root,['commit-tree',tree,'-p',head],env,message.strip()+'\n')
        cid=uuid.uuid4().hex;_git(root,['update-ref','refs/xueness/checkpoints/'+cid,commit])
        return {'id':cid,'hash':commit,'message':message.strip()}
    finally:
        for path in (name,name+'.lock'):
            try: os.unlink(path)
            except FileNotFoundError: pass

def restore(root,cid):
    if not ID_RE.fullmatch(cid): raise ValueError('invalid checkpoint')
    commit=_git(root,['rev-parse','refs/xueness/checkpoints/'+cid+'^{commit}'])
    head=_git(root,['rev-parse','HEAD'])
    _refuse_ignored_restore_conflicts(root,head,commit)
    backup=checkpoint(root,'Recovery before restoring '+cid[:8])
    # Checkpoints are created from this cwd with ``git add --all -- .``. Keep
    # the inverse equally scoped: read-tree --reset -u would write the entire
    # repository tree, even when this is only a nested session workspace.
    # --worktree leaves the real index (including staged changes elsewhere)
    # untouched. Untracked files outside the checkpoint's known paths are not
    # selected by Git's restore pathspec.
    # Recheck after creating the recovery snapshot; an ignored conflict is not
    # represented there and must never be overwritten by this restore.
    _refuse_ignored_restore_conflicts(root,head,commit)
    _git(root,['restore','--source='+commit,'--worktree','--','.'])
    return {'restored':cid,'recovery':backup}

def _paths(root,values):
    if not isinstance(values,list) or not values or len(values)>100: raise ValueError('paths required')
    base=Path(root).resolve();out=[]
    for name in values:
        if not isinstance(name,str) or not name or len(name)>1024 or name.startswith('-') or not (base/name).resolve().is_relative_to(base): raise ValueError('invalid path')
        out.append(name)
    return out

def action(root,verb,data):
    if data.get('confirmed') is not True: raise ValueError('review and confirm this Git operation')
    if verb=='init': _git(root,['init'])
    elif verb=='stage': _git(root,['add','--',*_paths(root,data.get('paths'))])
    elif verb=='unstage': _git(root,['restore','--staged','--',*_paths(root,data.get('paths'))])
    elif verb=='commit':
        text=data.get('message','')
        if not isinstance(text,str) or not text.strip() or len(text)>5000: raise ValueError('commit message required')
        _git(root,['-c','core.hooksPath=/dev/null','commit','-m',text])
    elif verb=='branch':
        name=data.get('name')
        if not isinstance(name,str) or len(name)>200 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]*',name) or '..' in name or '@{' in name: raise ValueError('invalid branch name')
        _git(root,['check-ref-format','--branch',name]);_git(root,['switch',*(['-c'] if data.get('create') is True else []),name])
    elif verb=='stash': _git(root,['stash','push','-m','Xueness local stash'])
    elif verb=='checkpoints': return {'checkpoint':checkpoint(root,data.get('message','Workspace checkpoint'))}
    else: raise ValueError('unknown Git operation')
    return {'ok':True}

def dispatch(method,parts,query,data,ctx):
    if len(parts) not in (5,7) or parts[:2]!=['api','sessions'] or parts[3]!='git' or not ID_RE.fullmatch(parts[2]): return None
    verb=parts[4]
    if verb not in LOCKED: return None
    try:
        session=ctx['store'].load(parts[2]);root=session['root']
        if method=='GET' and verb=='checkpoints' and len(parts)==5: return 200,{'checkpoints':checkpoints(root)}
        if method!='POST': return 405,{'error':'method not allowed'}
        with lease(ctx['store'],parts[2]):
            if len(parts)==7 and verb=='checkpoints' and parts[6]=='restore':
                if data.get('confirmed') is not True: raise ValueError('review and confirm checkpoint restore')
                return 200,restore(root,parts[5])
            if len(parts)!=5: return None
            return 200,action(root,verb,data)
    except BlockingIOError: return 409,{'error':'workspace session is in use'}
    except GitApiError as exc: return exc.status,{'error':exc.message}
    except (ValueError,OSError,KeyError): return 400,{'error':'invalid Git operation or missing session'}
