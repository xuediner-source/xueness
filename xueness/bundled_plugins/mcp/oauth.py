"""MCP OAuth authorization-code/PKCE and refresh-token persistence.

Endpoints/client/redirect URI are operator-configured. Redirects never receive
credentials; tokens live in mode-0600 files and public status omits them.
"""
from __future__ import annotations
import base64
import hashlib
import json
from pathlib import Path
import re
import secrets
import time
import urllib.request
from urllib.parse import urlsplit, urlencode
from ...provider import _NoRedirect
from ...resources import _atomic_write_json
from ...plugin_runtime import _config_lock

ID=re.compile(r'[A-Za-z0-9_-]{1,64}')

def _endpoint(url):
    if not isinstance(url,str) or len(url)>4096: raise ValueError('invalid OAuth endpoint')
    u=urlsplit(url)
    if u.scheme!='https' or not u.hostname or u.username or u.password or u.fragment or u.query: raise ValueError('OAuth endpoints require HTTPS without credentials or query')
    return url

def _config(server):
    c=server.get('oauth')
    if not isinstance(c,dict) or not isinstance(c.get('clientId'),str) or not c['clientId'] or len(c['clientId'])>500: raise ValueError('OAuth client configuration required')
    _endpoint(c.get('authorizationEndpoint'));_endpoint(c.get('tokenEndpoint'))
    uri=urlsplit(c.get('redirectUri',''))
    if not uri.hostname or uri.username or uri.password or uri.fragment or uri.query or not (uri.scheme=='https' or uri.scheme=='http' and uri.hostname in ('127.0.0.1','::1','localhost')): raise ValueError('invalid OAuth redirect URI')
    return c

def _path(state,sid):
    if not isinstance(sid,str) or not ID.fullmatch(sid): raise ValueError('invalid OAuth server id')
    directory=Path(state)/'mcp-oauth'
    if directory.is_symlink(): raise ValueError('OAuth directory cannot be a symlink')
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    path=directory/(sid+'.json')
    if path.is_symlink(): raise ValueError('OAuth state cannot be a symlink')
    return path

def _read(state,sid):
    try:
        raw=_path(state,sid).read_bytes()
        if len(raw)>32768: raise ValueError('OAuth state too large')
        row=json.loads(raw)
        if not isinstance(row,dict): raise ValueError('invalid OAuth state')
        return row
    except FileNotFoundError: return {}

def status(state,sid):
    row=_read(state,sid)
    return {'authorized':bool(row.get('access_token')),'expiresAt':row.get('expires_at'),'pending':row.get('pending_until',0)>time.time()}

def begin(state,server):
    c=_config(server);sid=server['id'];verifier=secrets.token_urlsafe(48);nonce=secrets.token_urlsafe(32)
    challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    with _config_lock(state):
        _atomic_write_json(_path(state,sid),{'verifier':verifier,'state':nonce,'pending_until':time.time()+600})
    params={'response_type':'code','client_id':c['clientId'],'redirect_uri':c['redirectUri'],'code_challenge':challenge,'code_challenge_method':'S256','state':nonce,'resource':server['url']}
    if c.get('scope'): params['scope']=str(c['scope'])[:2000]
    return {'authorizationUrl':c['authorizationEndpoint']+'?'+urlencode(params),'state':nonce,'expiresIn':600}

def _post(c,params):
    req=urllib.request.Request(c['tokenEndpoint'],data=urlencode(params).encode(),headers={'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'})
    try:
        with urllib.request.build_opener(_NoRedirect).open(req,timeout=15) as res:
            raw=res.read(32769)
            if len(raw)>32768: raise ValueError('OAuth response too large')
            row=json.loads(raw)
        token=row.get('access_token');kind=row.get('token_type','Bearer')
        if not isinstance(token,str) or not token or len(token)>16000 or any(x in token for x in '\r\n') or str(kind).lower()!='bearer': raise ValueError('invalid OAuth token')
        duration=row.get('expires_in',3600)
        if type(duration) not in (int,float) or not 0<duration<=365*86400: raise ValueError('invalid OAuth expiration')
        refresh=row.get('refresh_token')
        if refresh is not None and (not isinstance(refresh,str) or len(refresh)>16000): raise ValueError('invalid refresh token')
        return {'access_token':token,'refresh_token':refresh,'expires_at':time.time()+duration}
    except Exception: raise ValueError('OAuth token exchange failed (details suppressed)') from None

def finish(state,server,code,nonce):
    c=_config(server);sid=server['id']
    if not isinstance(code,str) or not code or len(code)>4000 or not isinstance(nonce,str): raise ValueError('code and state required')
    with _config_lock(state):
        row=_read(state,sid)
        if row.get('pending_until',0)<time.time() or not secrets.compare_digest(row.get('state',''),nonce): raise ValueError('OAuth state expired or mismatched')
        # Consume the one-time attempt before sending. An ambiguous network
        # failure cannot replay a code; start a fresh authorization instead.
        _atomic_write_json(_path(state,sid),{})
        token=_post(c,{'grant_type':'authorization_code','code':code,'client_id':c['clientId'],'redirect_uri':c['redirectUri'],'code_verifier':row['verifier'],'resource':server['url']})
        _atomic_write_json(_path(state,sid),token)
    return status(state,sid)

def bearer(state,server):
    c=_config(server);sid=server['id']
    with _config_lock(state):
        row=_read(state,sid)
        if not row.get('access_token'): raise ValueError('OAuth authorization required')
        if row.get('expires_at',0)<=time.time()+30:
            if not row.get('refresh_token'): raise ValueError('OAuth authorization expired')
            token=_post(c,{'grant_type':'refresh_token','refresh_token':row['refresh_token'],'client_id':c['clientId'],'resource':server['url']})
            token['refresh_token']=token.get('refresh_token') or row['refresh_token'];row=token
            _atomic_write_json(_path(state,sid),row)
        return row['access_token']

def revoke(state,sid):
    with _config_lock(state): _atomic_write_json(_path(state,sid),{})
    return status(state,sid)
