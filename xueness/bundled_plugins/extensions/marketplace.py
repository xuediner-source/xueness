"""Manifest marketplace for trusted built-in capability adapters.

The catalog may be shipped or set by XUENESS_MARKETPLACE_URL (public HTTPS).
Downloads are manifests only, with digest/version checks, disabled on install;
no downloaded module, command entrypoint or JavaScript is ever imported.
"""
import hashlib
import json
import os
from ... import plugin_sdk
from ..network.tooling import fetch


def _digest(manifest): return hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def catalog(state):
    url=os.environ.get('XUENESS_MARKETPLACE_URL','')
    if url:
        raw=fetch(url)
        if raw.get('truncated'): raise ValueError('marketplace catalog too large')
        rows=json.loads(raw['output']).get('items')
    else:
        rows=[{'id':f'xueness-{kind}','name':kind.title(),'description':'Trusted '+kind+' capability adapter','manifest':{'id':f'xueness-{kind}','version':'1.0.0','apiVersion':1,'builtin':kind,'capabilities':[],'enabled':False}} for kind in ('skills','hooks','mcp','subagents')]
    if not isinstance(rows,list) or len(rows)>100: raise ValueError('invalid marketplace catalog')
    installed={x.get('id'):x for x in plugin_sdk.load_manifests(state)}
    output=[];seen=set()
    for row in rows:
        if not isinstance(row,dict): raise ValueError('invalid marketplace item')
        manifest,errors=plugin_sdk.validate_manifest(row.get('manifest'))
        if errors or manifest is None or row.get('id')!=manifest['id'] or manifest['id'] in seen: raise ValueError('invalid marketplace manifest')
        seen.add(manifest['id']);digest=_digest(row['manifest'])
        if row.get('sha256',digest)!=digest: raise ValueError('marketplace digest mismatch')
        current=installed.get(manifest['id'])
        output.append({'id':manifest['id'],'name':str(row.get('name',manifest['id']))[:120],'description':str(row.get('description',''))[:500],'version':manifest['version'],'sha256':digest,'installedVersion':current.get('version') if current else None,'manifest':row['manifest'],'source':url or 'bundled'})
    return output

def install(state,pid,expected,update=False):
    item=next((x for x in catalog(state) if x['id']==pid),None)
    if item is None or expected!=item['sha256']: raise ValueError('catalog changed; review the package again')
    if bool(item['installedVersion'])!=bool(update): raise ValueError('use update for an installed package')
    if update:
        version=lambda value:tuple(int(x) for x in value.split('.'))
        if version(item['version'])<=version(item['installedVersion']): raise ValueError('no newer version available')
    manifest={**item['manifest'],'enabled':False}
    result=plugin_sdk.install_all(state,[manifest])
    if not result['ok']: raise ValueError('manifest installation failed')
    return result

def dispatch(method,parts,query,data,ctx):
    if parts[:3]!=['api','plugins','marketplace']: return None
    try:
        if len(parts)==3 and method=='GET': return 200,{'marketplace':catalog(ctx['state_dir'])}
        if len(parts)==5 and method=='POST' and parts[4] in ('install','update'):
            result=install(ctx['state_dir'],parts[3],data.get('sha256'),parts[4]=='update')
            return 200,{**result,'marketplace':catalog(ctx['state_dir'])}
        return 405,{'error':'method not allowed'}
    except (ValueError,OSError,KeyError): return 400,{'error':'marketplace validation or installation failed'}
