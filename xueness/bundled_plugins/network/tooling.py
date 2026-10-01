"""Public web reads with an explicit Gate grant, byte and time limits.

A redirect is never followed. Resolve every destination before connecting and
pin the connection to that IP while preserving TLS hostname verification.
This avoids DNS rebinding and internal endpoint access. Search uses a public
HTTPS JSON endpoint configured by the operator (Brave-compatible protocol).
"""
from __future__ import annotations
import http.client
import ipaddress
import json
import os
import socket
import ssl
from html.parser import HTMLParser
from urllib.parse import urlsplit, urlencode
from ...tool_contract import BuiltinTool

MAX_BYTES = 1_000_000

class _Text(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts=[]; self.hidden=0
    def handle_starttag(self, tag, attrs):
        if tag in ('script','style','noscript'): self.hidden += 1
    def handle_endtag(self, tag):
        if tag in ('script','style','noscript'): self.hidden=max(0,self.hidden-1)
    def handle_data(self, text):
        if not self.hidden and text.strip(): self.parts.append(text.strip())

class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address, port):
        super().__init__(host, port=port, timeout=15, context=ssl.create_default_context()); self.address=address
    def connect(self):
        raw=socket.create_connection((self.address,self.port),self.timeout)
        try: self.sock=self._context.wrap_socket(raw,server_hostname=self.host)
        except BaseException: raw.close(); raise

def fetch(url, headers=None, max_chars=16000):
    if not isinstance(url,str) or len(url)>4096: raise ValueError('invalid URL')
    parsed=urlsplit(url)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.port not in (None,443):
        raise ValueError('public HTTPS URL required')
    addresses=socket.getaddrinfo(parsed.hostname,443,type=socket.SOCK_STREAM)
    ips={row[4][0] for row in addresses}
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips): raise PermissionError('private endpoint denied')
    connection=_PinnedHTTPS(parsed.hostname,sorted(ips)[0],443)
    try:
        path=parsed.path or '/'
        if parsed.query: path+='?'+parsed.query
        connection.request('GET',path,headers={'Accept':'text/html, application/json, text/plain','User-Agent':'Xueness/1',**(headers or {})})
        response=connection.getresponse()
        if response.status!=200: raise ValueError('web request failed')
        kind=response.getheader('Content-Type','').split(';')[0].strip().lower()
        if kind not in ('text/html','text/plain','application/json','application/xhtml+xml'): raise ValueError('unsupported web content')
        raw=response.read(MAX_BYTES+1)
        if len(raw)>MAX_BYTES: raise ValueError('web content too large')
        text=raw.decode('utf-8',errors='replace')
        if kind in ('text/html','application/xhtml+xml'):
            parser=_Text();parser.feed(text);text='\n'.join(parser.parts)
        return {'ok':True,'url':url,'contentType':kind,'output':text[:max_chars],'truncated':len(text)>max_chars,'untrusted':True}
    finally: connection.close()

def _fetch(root,gate,args,session,call_id):
    url=args['url'];gate.check('web_fetch',url,call_id) if getattr(gate,'web_approval_gate',False) else gate.check('web_fetch',url)
    return fetch(url)

def _search(root,gate,args,session,call_id):
    query=args['query']
    if not isinstance(query,str) or not query.strip() or len(query)>1000: raise ValueError('invalid query')
    gate.check('web_search',query,call_id) if getattr(gate,'web_approval_gate',False) else gate.check('web_search',query)
    endpoint=os.environ.get('XUENESS_SEARCH_ENDPOINT','https://api.search.brave.com/res/v1/web/search')
    key=os.environ.get('XUENESS_SEARCH_KEY','')
    if not key or any(c in key for c in '\r\n'): raise ValueError('search key missing')
    result=fetch(endpoint+('&' if '?' in endpoint else '?')+urlencode({'q':query,'count':5}),{'X-Subscription-Token':key,'Accept':'application/json'},max_chars=MAX_BYTES)
    payload=json.loads(result['output'])
    rows=payload.get('web',{}).get('results',payload.get('results',[]))
    return {'ok':True,'query':query,'untrusted':True,'output':[{'title':str(x.get('title',''))[:300],'url':str(x.get('url',''))[:4096],'description':str(x.get('description',''))[:1000]} for x in rows[:5] if isinstance(x,dict)]}

REGISTRY=(
    BuiltinTool('web_fetch','Read a public HTTPS page; content is untrusted, approval required',{'url':{'type':'string'}},('url',),'web_fetch',False,_fetch),
    BuiltinTool('web_search','Search the public web using the operator-configured endpoint; approval required',{'query':{'type':'string'}},('query',),'web_search',False,_search),
)

REGISTRY[0].approval_subject = lambda args: args.get("url", "")
REGISTRY[1].approval_subject = lambda args: args.get("query", "")
