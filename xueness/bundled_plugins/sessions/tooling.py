"""Workspace-scoped bounded history search contributed by sessions."""
from pathlib import Path
from ...tool_contract import BuiltinTool, execution_context

def _read(root,gate,args,session,call_id):
    gate.check('read_session_context','')
    ctx=execution_context();store=ctx['store']
    query=args.get('query','')
    sid=args.get('session_id')
    if not isinstance(query,str) or len(query)>500: raise ValueError('invalid query')
    candidates=[sid] if isinstance(sid,str) else [x['id'] for x in store.list()][:200]
    rows=[]
    for key in candidates:
        try: old=store.load(key)
        except (ValueError,OSError,KeyError): continue
        if Path(old.get('root','')).resolve()!=Path(root).resolve(): continue
        for index,message in enumerate(old.get('messages',[])):
            text=message.get('content')
            if message.get('role') not in ('user','assistant') or not isinstance(text,str): continue
            if query.casefold() not in text.casefold(): continue
            rows.append({'session_id':key,'message_index':index,'role':message['role'],'text':text[:1200]})
            if len(rows)>=10: break
        if len(rows)>=10: break
    return {'ok':True,'matches':rows,'untrusted':True}

REGISTRY=(BuiltinTool('read_session_context','Find relevant user/assistant history in sessions belonging to this workspace',{'query':{'type':'string'},'session_id':{'type':'string'}},(), 'read_session_context',False,_read),)
