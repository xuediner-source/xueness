"""Durable offset-based model text stream, separate from the frozen event v1.

Offsets address text in one immutable stream id. Completed/interrupted streams
remain bounded in the journal so reconnects cannot duplicate another turn.
"""
import json
import time


def page(session,stream_id,cursor):
    records=[*session.get('stream_history',[])]
    if isinstance(session.get('streaming'),dict): records.append(session['streaming'])
    row=next((x for x in reversed(records) if not stream_id or x.get('id')==stream_id),None)
    if row is None and stream_id: raise LookupError('stream not found')
    if row is None: return {'schema':'xueness.model-delta.v1','streamId':stream_id or '', 'cursor':cursor,'nextCursor':cursor,'text':'','done':session.get('status') not in ('pending','running'),'status':'waiting'}
    text=row.get('text','');head=len(text)
    if cursor>head: raise ValueError('cursor exceeds stream length')
    chunk=text[cursor:cursor+4096];end=cursor+len(chunk)
    done=row.get('status') in ('completed','interrupted') and end==head
    return {'schema':'xueness.model-delta.v1','streamId':row['id'],'cursor':cursor,'nextCursor':end,'head':head,'text':chunk,'done':done,'status':row.get('status','streaming'),'truncated':bool(row.get('truncated'))}

def dispatch(method,parts,query,data,ctx):
    if method!='GET' or len(parts)!=4 or parts[:2]!=['api','sessions'] or parts[3]!='deltas': return None
    streaming_response = False
    try:
        cursor=int((query.get('cursor') or ['0'])[0])
        if not 0<=cursor<=2_000_000: raise ValueError('invalid cursor')
        stream_id=(query.get('stream_id') or [''])[0]
        if stream_id and (len(stream_id)!=32 or any(x not in '0123456789abcdef' for x in stream_id)): raise ValueError('invalid stream id')
        session=ctx['store'].load(parts[2]);result=page(session,stream_id,cursor)
        handler=ctx.get('handler')
        if handler is None or 'text/event-stream' not in handler.headers.get('Accept',''): return 200,result
        streaming_response = True
        handler.send_response(200);handler.send_header('Content-Type','text/event-stream');handler.send_header('Cache-Control','no-store');handler.send_header('Connection','close');handler.end_headers()
        deadline=time.monotonic()+30;last=None
        while True:
            result=page(ctx['store'].load(parts[2]),stream_id,cursor)
            if result!=last:
                body=f"id: {result['streamId']}:{result['nextCursor']}\nevent: model.delta\ndata: {json.dumps(result,ensure_ascii=False)}\n\n".encode()
                handler.wfile.write(body);handler.wfile.flush();last=result
                stream_id=result['streamId'];cursor=result['nextCursor']
            if result['done'] or time.monotonic()>=deadline: break
            if cursor<result.get('head',cursor): continue
            time.sleep(.1)
        from ...http_contract import HANDLED_RESPONSE
        return HANDLED_RESPONSE
    except (ValueError,TypeError): return 400,{'error':'invalid model stream cursor'}
    except (OSError,KeyError,LookupError):
        if streaming_response:
            from ...http_contract import HANDLED_RESPONSE
            return HANDLED_RESPONSE
        return 404,{'error':'session or stream unavailable'}
