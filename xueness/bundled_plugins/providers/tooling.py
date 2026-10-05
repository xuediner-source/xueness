"""Discover currently enabled tools and page this session's recorded results."""
import json
import re
from ...tool_contract import BuiltinTool, execution_context
from .lightweight_config import session_options


def _search(root, gate, args, session, call_id):
    gate.check('tool_search', '')
    query = args.get('query')
    if not isinstance(query, str) or not query.strip() or len(query) > 200:
        raise ValueError('query must contain 1..200 characters')
    catalog = execution_context().get('tool_catalog', [])
    terms = re.findall(r'[\w]+', query.casefold())
    matches = []
    for schema in catalog:
        fn = schema.get('function', {})
        name, description = fn.get('name', ''), fn.get('description', '')
        score = sum((8 if term in name.casefold() else 1 if term in description.casefold() else 0) for term in terms)
        if score:
            matches.append((score, name, description))
    matches.sort(key=lambda item: (-item[0], item[1]))
    options = session_options(session)
    maximum = options.get('maxDiscoveredTools', 6)
    if maximum == 0:
        raise PermissionError('optional tool discovery is disabled for this lightweight configuration')
    selected = matches[:min(options.get('toolSearchResults', 3), maximum)]
    if session is not None:
        previous = session.get('discovered_tools', [])
        previous = [n for n in previous if isinstance(n, str)] if isinstance(previous, list) else []
        for _, name, _ in selected:
            previous = [n for n in previous if n != name] + [name]
        session['discovered_tools'] = previous[-maximum:]
    return {'ok': True, 'tools': [{'name': n, 'description': d[:250]} for _, n, d in selected],
            'note': 'Matched schemas are available on the next turn. Discovery never grants permission.'}


def _read_result(root, gate, args, session, call_id):
    gate.check('tool_result_read', '')
    if 'read' in getattr(gate, 'disallow', ()):
        raise PermissionError('read disallowed')
    cid = args.get('tool_call_id')
    offset, limit = args.get('offset', 0), args.get('limit', session_options(session).get('resultPageChars', 1200))
    if (not isinstance(cid, str) or len(cid) > 200 or type(offset) is not int or offset < 0
            or type(limit) is not int or not 1 <= limit <= 4000):
        raise ValueError('invalid result page')
    result = (session or {}).get('results', {}).get(cid)
    if not isinstance(result, dict):
        raise ValueError('tool result not found in this session')
    text = json.dumps(result, ensure_ascii=False)
    page = text[offset:offset + limit]
    return {'ok': True, 'tool_call_id': cid, 'output_untrusted': page, 'offset': offset,
            'totalChars': len(text), 'nextOffset': offset + len(page) if offset + len(page) < len(text) else None}


REGISTRY = (
    BuiltinTool('tool_search', 'Discover optional enabled tools by name or purpose; matched tools become available next turn. Try keywords such as browser, workflow, MCP or todo.',
                {'query': {'type': 'string'}}, ('query',), 'tool_search', False, _search),
    BuiltinTool('tool_result_read', 'Read a bounded page of a full recorded tool result in the current session.',
                {'tool_call_id': {'type': 'string'}, 'offset': {'type': 'integer'}, 'limit': {'type': 'integer'}},
                ('tool_call_id',), 'tool_result_read', False, _read_result,
                concurrency_safe=True),
)
