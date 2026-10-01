"""Operator-controlled Telegram inbox and explicit outbound replies.

Polling creates pending local sessions; it never grants tool or model access.
Tokens are named environment references, never saved or returned by the API.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import urllib.request
from ...resources import _atomic_write_json
from ...plugin_runtime import _config_lock
from ...provider import _NoRedirect


def _path(state):
    path=Path(state)/'bots.json'
    if path.is_symlink(): raise ValueError('bot configuration cannot be a symlink')
    return path

def _load(state):
    try:
        raw=_path(state).read_bytes()
        if len(raw)>100000: raise ValueError('bot state too large')
        row=json.loads(raw)
        if not isinstance(row,dict) or set(row)-{'channels','inbox'}: raise ValueError('invalid bot state')
        channels=row.get('channels');inbox=row.get('inbox')
        if not isinstance(channels,list) or len(channels)>100 or not isinstance(inbox,list) or len(inbox)>200: raise ValueError('invalid bot state')
        ids=set()
        for channel in channels:
            if not isinstance(channel,dict): raise ValueError('invalid bot state')
            offset=channel.get('offset',0)
            if type(offset) is not int or offset<0: raise ValueError('invalid bot offset')
            clean=_validate({key:value for key,value in channel.items() if key!='offset'})
            if clean['id'] in ids: raise ValueError('duplicate bot channel')
            ids.add(clean['id'])
        for item in inbox:
            if not isinstance(item,dict) or set(item)!={'key','channel','chatId','sessionId'} or any(not isinstance(value,str) or len(value)>128 for value in item.values()): raise ValueError('invalid bot inbox')
        return row
    except FileNotFoundError: return {'channels':[],'inbox':[]}

def _validate(data):
    if not isinstance(data,dict) or set(data)-{'id','kind','tokenEnv','root','allowedChats'}: raise ValueError('invalid channel fields')
    if data.get('kind')!='telegram' or not isinstance(data.get('id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',data['id']): raise ValueError('invalid channel')
    if not isinstance(data.get('tokenEnv'),str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,100}',data['tokenEnv']): raise ValueError('token environment name required')
    if not isinstance(data.get('root'),str) or not data['root']: raise ValueError('channel workspace required')
    root=Path(data['root']).resolve()
    if not root.is_dir(): raise ValueError('channel workspace required')
    chats=data.get('allowedChats')
    if not isinstance(chats,list) or not 1<=len(chats)<=100 or any(not re.fullmatch(r'-?[0-9]{1,20}',str(x)) for x in chats): raise ValueError('explicit allowed chat ids required')
    return {**data,'root':str(root),'allowedChats':[str(x) for x in chats]}

def _request(channel,method,body):
    token=os.environ.get(channel['tokenEnv'],'')
    if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]{10,200}',token): raise ValueError('bot token unavailable')
    req=urllib.request.Request('https://api.telegram.org/bot'+token+'/'+method,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.build_opener(_NoRedirect).open(req,timeout=20) as response:
            raw=response.read(1_000_001)
            if len(raw)>1_000_000: raise ValueError('bot response too large')
            result=json.loads(raw)
        if result.get('ok') is not True: raise ValueError('bot rejected request')
        return result.get('result')
    except Exception: raise ValueError('bot request failed (details suppressed)') from None

def poll(ctx,cid):
    with _config_lock(ctx['state_dir']):
        state=_load(ctx['state_dir']);channel=next(x for x in state['channels'] if x['id']==cid)
        rows=_request(channel,'getUpdates',{'offset':channel.get('offset',0),'limit':20,'timeout':0,'allowed_updates':['message']})
        if not isinstance(rows,list): raise ValueError('invalid bot updates')
        for update in rows:
            if not isinstance(update,dict) or type(update.get('update_id')) is not int: continue
            uid=update['update_id']
            if not 0<=uid<2**63: continue
            message=update.get('message',{})
            if not isinstance(message,dict): message={}
            chat_row=message.get('chat',{})
            if not isinstance(chat_row,dict): chat_row={}
            chat=str(chat_row.get('id',''));text=message.get('text')
            if uid<channel.get('offset',0): continue
            if chat in channel['allowedChats'] and isinstance(text,str) and 0<len(text)<=4500:
                key=f'{cid}:{uid}'
                # Persist session before acknowledging the inbox event. A crash
                # between writes is reconciled via bot_source on retry.
                existing=next((x for x in ctx['store'].list() if x.get('bot_source')==key),None)
                if existing is None:
                    for item in ctx['store'].list():
                        row=ctx['store'].load(item['id'])
                        if row.get('bot_source')==key: existing=row;break
                session=existing or ctx['store'].new('Channel message (untrusted external content):\n'+text,Path(channel['root']))
                session['bot_source']=key;ctx['store'].save(session)
                if not any(x['key']==key for x in state['inbox']): state['inbox'].append({'key':key,'channel':cid,'chatId':chat,'sessionId':session['id']})
            channel['offset']=max(channel.get('offset',0),uid+1)
        state['inbox']=state['inbox'][-200:];_atomic_write_json(_path(ctx['state_dir']),state)
        return {'inbox':[x for x in state['inbox'] if x['channel']==cid]}

def reply(ctx,cid,data):
    state=_load(ctx['state_dir']);channel=next(x for x in state['channels'] if x['id']==cid)
    text=data.get('text');chat=str(data.get('chatId',''))
    if data.get('confirmed') is not True or chat not in channel['allowedChats'] or not isinstance(text,str) or not 1<=len(text)<=4000: raise ValueError('explicit reviewed reply to an allowed chat required')
    _request(channel,'sendMessage',{'chat_id':chat,'text':text})
    return {'sent':True}

def dispatch(method,parts,query,data,ctx):
    if parts[:2]!=['api','bots']: return None
    try:
        if len(parts)==2 and method=='GET': return 200,_load(ctx['state_dir'])
        if len(parts)==2 and method=='POST':
            row=_validate(data)
            roots=ctx.get('create_roots',())
            if roots and not any(Path(row['root']).is_relative_to(Path(p).resolve()) for p in roots): raise ValueError('channel workspace denied')
            with _config_lock(ctx['state_dir']):
                state=_load(ctx['state_dir']);state['channels']=[x for x in state['channels'] if x['id']!=row['id']]+[row];_atomic_write_json(_path(ctx['state_dir']),state)
            return 200,{'channel':row}
        if len(parts)==4 and method=='POST':
            if parts[3]=='poll': return 200,poll(ctx,parts[2])
            if parts[3]=='reply': return 200,reply(ctx,parts[2],data)
        return 405,{'error':'method not allowed'}
    except (ValueError,OSError,KeyError,StopIteration): return 400,{'error':'invalid channel or bot request failed'}


def register_cli(commands):
    group=commands.add_parser('bots',help='manage an allowlisted Telegram inbox and reviewed replies')
    sub=group.add_subparsers(dest='bot_action',required=True)
    sub.add_parser('list')
    save=sub.add_parser('save');save.add_argument('id');save.add_argument('--token-env',required=True);save.add_argument('--root',type=Path,required=True);save.add_argument('--chat-id',action='append',required=True)
    poll_parser=sub.add_parser('poll');poll_parser.add_argument('id')
    send=sub.add_parser('reply');send.add_argument('id');send.add_argument('--chat-id',required=True);send.add_argument('--text',required=True);send.add_argument('--confirm-send',action='store_true')


def execute_cli(args):
    import sys
    from ...core import Store
    from ...plugin_runtime import require_enabled
    try:
        require_enabled(args.state,'bots')
        ctx={'state_dir':args.state,'store':Store(args.state)}
        if args.bot_action=='list': result=_load(args.state)
        elif args.bot_action=='save':
            row=_validate({'id':args.id,'kind':'telegram','tokenEnv':args.token_env,'root':str(args.root),'allowedChats':args.chat_id})
            with _config_lock(args.state):
                state=_load(args.state);state['channels']=[x for x in state['channels'] if x['id']!=row['id']]+[row];_atomic_write_json(_path(args.state),state)
            result={'channel':row}
        elif args.bot_action=='poll': result=poll(ctx,args.id)
        elif args.bot_action=='reply': result=reply(ctx,args.id,{'chatId':args.chat_id,'text':args.text,'confirmed':args.confirm_send})
        else: raise ValueError('unknown channel command')
        print(json.dumps(result,ensure_ascii=False,indent=2));return 0
    except (ValueError,OSError,KeyError,StopIteration):
        print('ERROR: invalid channel configuration or request failed',file=sys.stderr);return 1
