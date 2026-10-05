"""Legacy MCP SSE discovery with same-origin POST endpoint enforcement."""
from __future__ import annotations
import json
import queue
import threading
import urllib.request
from urllib.parse import urljoin,urlsplit
from .mcp_http import HttpMcpClient
from .mcp import _McpTransportError
from ...provider import _NoRedirect,_is_loopback_literal

class SseMcpClient(HttpMcpClient):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);self.ready=threading.Event();self.endpoint=None;self.responses=queue.Queue(maxsize=256);self.response=None;self.reader=None;self.closed=threading.Event()
    def _read(self):
        event='message';data=[];size=0
        try:
            while not self.closed.is_set():
                line=self.response.readline(65537)
                if not line or len(line)>65536: break
                size+=len(line)
                if size>1_000_000: break
                text=line.decode().rstrip('\r\n')
                if text.startswith('event:'): event=text[6:].strip()
                elif text.startswith('data:'): data.append(text[5:].lstrip())
                elif not text:
                    value='\n'.join(data)
                    if data and event=='endpoint':
                        target=urljoin(self.server['url'],value);a=urlsplit(self.server['url']);b=urlsplit(target)
                        if (a.scheme,a.hostname,a.port)!=(b.scheme,b.hostname,b.port) or b.username or b.password or b.fragment: raise ValueError('cross-origin SSE endpoint')
                        self.endpoint=target;self.ready.set()
                    elif data and event=='message': self.responses.put_nowait(json.loads(value))
                    event='message';data=[];size=0
        except Exception: pass
        finally:
            self._started=False;self.ready.set()
    def start(self):
        self.closed.clear();self.ready.clear();self.endpoint=None
        try:
            u=urlsplit(self.server.get('url',''))
            if not u.hostname or u.username or u.password or u.fragment or u.query or not (u.scheme=='https' or u.scheme=='http' and self.server.get('allowLoopbackHttp') is True and _is_loopback_literal(u.hostname)): raise ValueError('invalid SSE URL')
            request=urllib.request.Request(self.server['url'],headers={**self._headers(),'Accept':'text/event-stream'})
            self.response=urllib.request.build_opener(_NoRedirect).open(request,timeout=self._transport_timeout())
            if 'text/event-stream' not in self.response.headers.get('Content-Type',''): raise ValueError('SSE content required')
            self.reader=threading.Thread(target=self._read,daemon=True);self.reader.start()
            if not self.ready.wait(self.timeout) or not self.endpoint: raise ValueError('SSE endpoint missing')
            super().start()
            if not self.active: self.close()
        except Exception:
            self.error='SSE MCP initialization failed';self.close()
    def _post_result(self,response):
        # Reply on the message endpoint, not the SSE URL, and do not log the body.
        if not self.endpoint or self.closed.is_set(): raise _McpTransportError('SSE MCP disconnected')
        req=urllib.request.Request(self.endpoint,data=json.dumps(response).encode(),headers=self._headers())
        with urllib.request.build_opener(_NoRedirect).open(req,timeout=self.timeout) as ack:
            if ack.status not in (200,202,204): raise ValueError()
            ack.read(65536)
    def _wait_sse_result(self,request_id):
        from .elicitation import is_server_request
        while True:
            row=self.responses.get(timeout=self.timeout)
            if isinstance(row,dict) and is_server_request(row):
                self._answer_server_request(row)
                continue
            if isinstance(row,dict) and row.get('id')==request_id: return self._result(row,request_id)
    def _exchange(self,payload):
        if not self.endpoint or self.closed.is_set(): raise _McpTransportError('SSE MCP disconnected')
        try:
            req=urllib.request.Request(self.endpoint,data=json.dumps(payload).encode(),headers=self._headers())
            with urllib.request.build_opener(_NoRedirect).open(req,timeout=self.timeout) as ack:
                if ack.status not in (200,202,204): raise ValueError()
                # POST is acknowledgement only; response comes on the SSE stream.
            if 'id' not in payload: return {}
            return self._wait_sse_result(payload['id'])
        except Exception:
            self.close();raise _McpTransportError('SSE MCP request failed (details suppressed)') from None
    def close(self):
        self.closed.set();self._started=False;self.endpoint=None
        if self.response is not None:
            try: self.response.close()
            except Exception: pass
            self.response=None
        if self.reader is not None and self.reader is not threading.current_thread(): self.reader.join(timeout=0.2)
