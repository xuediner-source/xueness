"""Timezone-aware local cron and durable at-most-once launch claims.

Schedules never acquire command/provider approval implicitly. The operator may
approve the immutable plan for unattended runs; amendments reset that approval.
An unapproved due schedule creates a reviewable plan without starting it.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import hashlib
import json
from pathlib import Path
import threading
import time
import uuid
from ...resources import _atomic_write_json
from ...plugin_runtime import _config_lock, require_enabled, is_enabled
from ..workflows.workflows import WorkflowStore, validate_plan


def _field(text,lo,hi):
    values=set()
    for chunk in text.split(','):
        base,sep,step=chunk.partition('/')
        step=int(step) if sep else 1
        if step<1 or step>hi+1: raise ValueError('invalid cron step')
        if base=='*': first,last=lo,hi
        elif '-' in base: first,last=map(int,base.split('-'))
        else: first=last=int(base)
        if first<lo or last>hi or first>last: raise ValueError('cron field out of range')
        values.update(range(first,last+1,step))
    if not values: raise ValueError('empty cron field')
    return values

def cron(schedule):
    if not isinstance(schedule,str) or len(schedule)>200 or len(schedule.split())!=5: raise ValueError('schedule must have five cron fields')
    return [_field(x,*bounds) for x,bounds in zip(schedule.split(),[(0,59),(0,23),(1,31),(1,12),(0,6)])]

def next_run(schedule,tz,after):
    fields=cron(schedule);zone=ZoneInfo(tz)
    cursor=datetime.fromtimestamp(after,timezone.utc).replace(second=0,microsecond=0)+timedelta(minutes=1)
    dom_any=schedule.split()[2]=='*';dow_any=schedule.split()[4]=='*'
    for _ in range(366*24*60):
        local=cursor.astimezone(zone)
        dom=local.day in fields[2];dow=(local.weekday()+1)%7 in fields[4]
        day=dom and dow if dom_any or dow_any else dom or dow
        if local.minute in fields[0] and local.hour in fields[1] and local.month in fields[3] and day: return cursor.timestamp()
        cursor+=timedelta(minutes=1)
    raise ValueError('schedule has no occurrence in the next year')

class Automations:
    def __init__(self,state): self.state=Path(state);self.path=self.state/'automations.json'
    def _load(self):
        if self.path.is_symlink(): raise ValueError('automation state cannot be a symlink')
        try:
            raw=self.path.read_bytes()
            if len(raw)>2_000_000: raise ValueError('automation state too large')
            rows=json.loads(raw)
            if not isinstance(rows,list): raise ValueError('invalid automation state')
            return rows
        except FileNotFoundError: return []
    def list(self): return self._load()
    def mutate(self,fn):
        with _config_lock(self.state):
            rows=self._load();out=fn(rows);_atomic_write_json(self.path,rows);return out
    def save(self,data,aid=None):
        now=time.time()
        if not isinstance(data,dict): raise ValueError('automation must be an object')
        def write(rows):
            previous=next((r for r in rows if r['id']==aid),None)
            if aid and previous is None: raise ValueError('automation not found')
            row={**(previous or {}),**data}
            name=row.get('name','Automation');schedule=row.get('schedule');tz=row.get('timezone','UTC');enabled=row.get('enabled',False)
            if not isinstance(name,str) or not name.strip() or len(name)>120 or type(enabled) is not bool: raise ValueError('invalid name or enabled state')
            if not isinstance(tz,str): raise ValueError('invalid timezone')
            ZoneInfo(tz)
            workflow=row.get('workflow',{})
            if not isinstance(workflow,dict) or not isinstance(workflow.get('root'),str): raise ValueError('workflow root required')
            root=Path(workflow['root']).resolve()
            if not root.is_dir(): raise ValueError('workflow root must exist')
            plan=validate_plan({k:v for k,v in workflow.items() if k!='root'},root)
            digest=hashlib.sha256(json.dumps({'root':str(root),'plan':plan},sort_keys=True).encode()).hexdigest()
            item={'id':aid or uuid.uuid4().hex,'name':name,'schedule':schedule,'timezone':tz,'enabled':enabled,'workflow':{'root':str(root),**plan},'nextRunAt':next_run(schedule,tz,now),'history':(previous or {}).get('history',[]),'approvalRequired':True,'approved':(previous or {}).get('approved',False) if (previous or {}).get('digest')==digest else False,'allowReal':(previous or {}).get('allowReal',False),'digest':digest}
            if previous: rows[rows.index(previous)]=item
            else:
                if len(rows)>=100: raise ValueError('automations capped at 100')
                rows.append(item)
            return item
        return self.mutate(write)
    def delete(self,aid):
        def change(rows): rows[:]=[r for r in rows if r['id']!=aid];return {'deleted':aid}
        return self.mutate(change)
    def approve(self,aid,allow_real=False):
        def change(rows):
            row=next(r for r in rows if r['id']==aid);row['approved']=True;row['allowReal']=allow_real is True;return row
        return self.mutate(change)
    def run(self,aid,due=False,now=None,allow_real_host=False):
        require_enabled(self.state,'automation');now=time.time() if now is None else now
        def claim(rows):
            row=next(r for r in rows if r['id']==aid)
            if due and (not row['enabled'] or row['nextRunAt']>now): return None
            if due: row['nextRunAt']=next_run(row['schedule'],row['timezone'],now)
            wid=uuid.uuid4().hex
            row['history']=(row['history']+[{'id':wid,'at':now,'status':'claimed'}])[-100:]
            return dict(row),wid
        claimed=self.mutate(claim)
        if not claimed: return None
        row,claim_id=claimed;store=WorkflowStore(self.state)
        try:
            plan=dict(row['workflow']);root=plan.pop('root');run=store.create(plan,root)
            granted = row['approved'] and (not row['allowReal'] or allow_real_host)
            if granted: run=store.launch(run['id'],approved=True,allow_real=row['allowReal'])
            status='started' if granted else 'awaiting_approval'
            result={'id':claim_id,'at':now,'status':status,'workflowId':run['id']}
        except Exception:
            result={'id':claim_id,'at':now,'status':'failed','error':'workflow launch failed'}
        def settle(rows):
            current=next((r for r in rows if r['id']==aid),None)
            if current:
                current['history']=[result if x['id']==claim_id else x for x in current['history']]
            return result
        return self.mutate(settle)

class Scheduler:
    def __init__(self,state,allow_real=False):
        self.allow_real = allow_real
        self.state=state;self.stop=threading.Event();self.thread=threading.Thread(target=self._loop,daemon=True,name='xueness-cron');self.thread.start()
    def _loop(self):
        while not self.stop.is_set():
            try:
                if is_enabled(self.state,'automation'):
                    store=Automations(self.state)
                    for row in store.list():
                        if row['enabled'] and row['nextRunAt']<=time.time(): store.run(row['id'],due=True,allow_real_host=self.allow_real)
            except (ValueError,OSError,KeyError): pass
            self.stop.wait(15)
    def close(self): self.stop.set();self.thread.join(timeout=1)
