"""Redacted diagnostic export and bounded state storage reporting."""
from collections import Counter
from pathlib import Path
import platform
import time
from ...plugin_runtime import catalog
from . import runtime_metrics


def report(ctx):
    root=Path(ctx['state_dir']).resolve();groups={}
    for group in ('sessions','workflows','resources','mcp-oauth'):
        directory=root/group if group!='sessions' else root
        count=size=0
        if directory.is_dir() and not directory.is_symlink():
            entries=directory.glob('*.json') if group=='sessions' else directory.rglob('*')
            for i,path in enumerate(entries):
                if i>=10000: break
                if path.is_symlink() or not path.resolve().is_relative_to(root): continue
                try:
                    if path.is_file(): count+=1;size+=path.stat().st_size
                except OSError: pass
        groups[group]={'files':count,'bytes':size}
    sessions=ctx['store'].list()
    return {'schema':'xueness.diagnostics.v1','createdAt':time.time(),'runtime':{'python':platform.python_version(),'system':platform.system(),'machine':platform.machine()},'plugins':[{'id':p['id'],'effective':p['effective'],'version':p.get('version')} for p in catalog(root)],'sessions':dict(Counter(row.get('status','unknown') for row in sessions)),'storage':groups,'redacted':True}

def dispatch(method,parts,query,data,ctx):
    if parts[:2]!=['api','diagnostics']: return None
    if parts==['api','diagnostics','runtime']:
        if method!='GET': return 405,{'error':'method not allowed'}
        return 200,runtime_metrics.snapshot(ctx)
    if method=='GET' and len(parts) in (2,3) and (len(parts)==2 or parts[2] in ('export','storage')): return 200,report(ctx)
    # Cleanup is scoped to logs of settled workflows older than a cutoff. Never
    # remove sessions, manifests, provider secrets or running workflow state.
    if method=='POST' and parts==['api','diagnostics','cleanup']:
        if data.get('confirmed') is not True or type(data.get('olderThanDays')) is not int or not 1<=data['olderThanDays']<=3650: return 400,{'error':'confirmed cutoff required'}
        from ..workflows.workflows import WorkflowStore, ACTIVE
        store=WorkflowStore(ctx['state_dir']);cutoff=time.time()-data['olderThanDays']*86400;removed=0
        for item in store.list():
            with store.lock(item['id']):
                row=store.load(item['id'])
                if row['status'] in ACTIVE or row['updated_at']>=cutoff: continue
                for path in store.directory.glob(item['id']+'.*.log'):
                    if path.is_symlink(): continue
                    path.unlink();removed+=1
        return 200,{'removedLogs':removed}
    return 405,{'error':'method not allowed'}
