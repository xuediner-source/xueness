"""MCP client pool with serialized access and discovery-only reconnection."""
from __future__ import annotations
import threading
from .mcp import client_for, _McpTransportError

class Pool:
    def __init__(self,cwd): self.cwd=cwd;self.clients={};self.lock=threading.RLock()
    def get(self,server):
        with self.lock:
            client=self.clients.get(server['id'])
            if client is not None and getattr(client, "active", not getattr(client, "closed", False)): return client
            if client is not None: client.close()
            client=client_for(server,cwd=self.cwd)
            try:
                client.start()
                if not getattr(client, "active", True): raise ValueError("MCP connection failed")
            except Exception:
                client.close()
                raise
            self.clients[server['id']]=client
            return client
    def discard(self, sid):
        with self.lock:
            client = self.clients.pop(sid, None)
            if client is not None:
                client.close()
    def close(self):
        with self.lock:
            for client in self.clients.values(): client.close()
            self.clients.clear()

def catalog(client,kind):
    if kind not in ('resources','prompts'): raise ValueError('invalid MCP catalog kind')
    rows=[];cursor=None;seen=set()
    for _ in range(50):
        rid=client._next_id;client._next_id+=1
        response=client._request(kind+'/list',{'cursor':cursor} if cursor else {},rid)
        items=response.get(kind)
        if not isinstance(items,list) or any(not isinstance(x,dict) for x in items): raise ValueError('invalid MCP catalog')
        rows.extend(items)
        if len(rows)>1000: raise ValueError('MCP catalog too large')
        cursor=response.get('nextCursor')
        if cursor is None: return rows
        if not isinstance(cursor,str) or not cursor or cursor in seen: raise ValueError('invalid MCP pagination')
        seen.add(cursor)
    raise ValueError('MCP catalog page limit')

def read(client,kind,key,arguments=None):
    if not isinstance(key,str) or not key or len(key)>4096: raise ValueError('invalid MCP resource or prompt key')
    method='resources/read' if kind=='resources' else 'prompts/get' if kind=='prompts' else None
    if method is None: raise ValueError('invalid MCP content kind')
    rid=client._next_id;client._next_id+=1
    params={'uri':key} if kind=='resources' else {'name':key,'arguments':arguments or {}}
    return client._request(method,params,rid)

def dispatch(method,parts,query,data,ctx):
    if parts[:2]!=['api','mcp'] or len(parts) not in (4,5): return None
    from .mcp import load
    from . import oauth
    server=next((s for s in load(ctx['state_dir']) if s['id']==parts[2]),None)
    if server is None: return 404,{'error':'MCP server not found'}
    try:
        if parts[3]=='oauth':
            if len(parts)==4 and method=='GET': return 200,oauth.status(ctx['state_dir'],server['id'])
            if len(parts)==5 and method=='POST':
                if parts[4]=='start': return 200,oauth.begin(ctx['state_dir'],server)
                if parts[4]=='finish': return 200,oauth.finish(ctx['state_dir'],server,data.get('code'),data.get('state'))
                if parts[4]=='revoke': return 200,oauth.revoke(ctx['state_dir'],server['id'])
        if parts[3] in ('resources','prompts') and method=='POST':
            # Starting a configured process/server is an explicit operator act.
            if data.get('confirmed') is not True: return 400,{'error':'confirm MCP request first'}
            config={**server,'_state_dir':str(ctx['state_dir'])}
            with Pool(ctx['project_dir']) as pool:
                client=pool.get(config)
                if len(parts)==4: return 200,{parts[3]:catalog(client,parts[3])}
                if parts[4]=='read': return 200,{'result':read(client,parts[3],data.get('key'),data.get('arguments'))}
        return 405,{'error':'method not allowed'}
    except Exception: return 400,{'error':'MCP request failed (details suppressed)'}

Pool.__enter__=lambda self:self
Pool.__exit__=lambda self,*args:self.close()
