"""Explicit operator memory editing with optimistic conflict checks."""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import tempfile
from ...resources import replace_file
from .memory_api import memory_root, resolve_cwd, TRACK_NAMES
from .memory import track_paths


def _path(ctx,name):
    root=memory_root()
    if root is None or name not in TRACK_NAMES: raise ValueError('memory track unavailable')
    base=root.resolve();target=track_paths(base,resolve_cwd(ctx))[name]
    if base.is_symlink() or target.is_symlink() or not target.resolve().is_relative_to(base): raise ValueError('memory track path denied')
    if any(parent.is_symlink() for parent in target.parents if parent.is_relative_to(base)): raise ValueError('memory track parent denied')
    return target

def read(ctx,name):
    target=_path(ctx,name)
    try:
        raw=target.read_bytes()
    except FileNotFoundError: raw=b''
    if len(raw)>100_000: raise ValueError('memory track too large to edit')
    return {'name':name,'content':raw.decode('utf-8'),'digest':hashlib.sha256(raw).hexdigest()}

def write(ctx,name,data):
    content=data.get('content')
    if data.get('confirmed') is not True or not isinstance(content,str) or len(content.encode())>100_000: raise ValueError('confirmed content required (max 100KB)')
    from ...plugin_runtime import _config_lock
    with _config_lock(ctx['state_dir']):
        current=read(ctx,name)
        if data.get('digest')!=current['digest']: raise LookupError('memory changed; reload before saving')
        target=_path(ctx,name);target.parent.mkdir(parents=True,exist_ok=True)
        _path(ctx,name)
        fd,name_tmp=tempfile.mkstemp(prefix='.memory-',dir=target.parent)
        try:
            with os.fdopen(fd,'w',encoding='utf-8',newline='\n') as stream: stream.write(content);stream.flush();os.fsync(stream.fileno())
            replace_file(name_tmp,target)
        finally:
            if os.path.exists(name_tmp): os.unlink(name_tmp)
    return read(ctx,name)

def dispatch(method,parts,query,data,ctx):
    if len(parts)!=4 or parts[:3]!=['api','memory','tracks']: return None
    try:
        from .catalog import scoped_context
        ctx = scoped_context(ctx, query)
        if method=='GET': return 200,read(ctx,parts[3])
        if method=='POST': return 200,write(ctx,parts[3],data)
        return 405,{'error':'method not allowed'}
    except LookupError: return 409,{'error':'memory changed; reload before saving'}
    except (ValueError,OSError,UnicodeError): return 400,{'error':'memory track unavailable or invalid'}
