"""Workspace-scoped bounded history search and run-state introspection (sessions)."""
from pathlib import Path
from ...tool_contract import BuiltinTool, execution_context

#: read_state summarizes the current run; the todo list is already normalized
#: and capped by the planning plugin, so the bound here only caps the reply.
READ_STATE_MAX_TODOS = 50

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


def _read_state(root, gate, args, session, call_id):
    """Read-only snapshot of the current run's own progress state.

    Pure projection of fields the session already carries — identity, status,
    mode, steps, title, the task line and the normalized todo list. No message
    bodies, no workspace paths beyond what the run already knows, no writes.
    """
    gate.check('read_state', '')
    if not isinstance(session, dict):
        return {'ok': False, 'error': 'no active session'}
    todos = session.get('todos')
    todo_rows = [item for item in todos if isinstance(item, dict)][:READ_STATE_MAX_TODOS] \
        if isinstance(todos, list) else []
    return {'ok': True, 'id': session.get('id'), 'status': session.get('status'),
            'mode': session.get('mode'), 'permissionMode': session.get('permission_mode'),
            'steps': session.get('steps', 0), 'title': session.get('title'),
            'task': str(session.get('task') or '')[:300], 'todos': todo_rows,
            'pendingQuestion': bool(session.get('pending_question')),
            'note': '当前会话运行状态概览（只读）；待办详情用 todo_read 查看。'}


REGISTRY=(
    BuiltinTool('read_session_context','Find relevant user/assistant history in sessions belonging to this workspace',{'query':{'type':'string'},'session_id':{'type':'string'}},(), 'read_session_context',False,_read,concurrency_safe=True),
    BuiltinTool('read_state','Introspect this session run state: status, mode, permission mode, step count, title, task line, pending question and the todo list. Read-only snapshot of the current session.',
                {}, (), 'read_state', False, _read_state, concurrency_safe=True),
)
