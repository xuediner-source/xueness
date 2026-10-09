"""Discover currently enabled tools and page this session's recorded results."""
import json
import re
from ...tool_contract import BuiltinTool, execution_context
from .lightweight_config import session_options

RESULT_PAGE_MAX_CHARS = 4000


def _page_error(error_code, user_reason, **metadata):
    return {'ok': False, 'error': 'invalid result page' if error_code == 'invalid_result_page'
            else 'tool result not found in this session', 'error_code': error_code,
            'retryable': True, 'user_reason': user_reason, **metadata}


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
    options = session_options(session)
    default_limit = min(options.get('resultPageChars', 1200), RESULT_PAGE_MAX_CHARS)
    cid = args.get('tool_call_id')
    offset, limit = args.get('offset', 0), args.get('limit', default_limit)
    if (not isinstance(cid, str) or not cid or len(cid) > 200
            or type(offset) is not int or offset < 0
            or type(limit) is not int or not 1 <= limit <= RESULT_PAGE_MAX_CHARS):
        return _page_error(
            'invalid_result_page',
            f'Use a non-empty tool_call_id, integer offset >= 0, and integer limit 1..{RESULT_PAGE_MAX_CHARS}. '
            f'The configured default page size is {default_limit}; max_limit={RESULT_PAGE_MAX_CHARS}.',
            max_limit=RESULT_PAGE_MAX_CHARS, default_limit=default_limit)
    result_map = (session or {}).get('results')
    result = result_map.get(cid) if isinstance(result_map, dict) else None
    if not isinstance(result, dict):
        return _page_error(
            'tool_result_not_found',
            'Use the exact full_result_tool_call_id from a tool result recorded in this session; '
            'tool_result_read cannot access another session.',
            max_limit=RESULT_PAGE_MAX_CHARS, default_limit=default_limit)
    text = json.dumps(result, ensure_ascii=False)
    if offset > len(text):
        return _page_error(
            'invalid_result_page',
            f'offset={offset} is beyond this stored result totalChars={len(text)}. '
            f'Use an integer offset from 0 through {len(text)}; offset={len(text)} is EOF.',
            max_limit=RESULT_PAGE_MAX_CHARS, default_limit=default_limit,
            total_chars=len(text))
    page = text[offset:offset + limit]
    next_offset = offset + len(page) if offset + len(page) < len(text) else None
    return {'ok': True, 'tool_call_id': cid, 'output_untrusted': page, 'offset': offset,
            'totalChars': len(text), 'nextOffset': next_offset, 'pageComplete': next_offset is None}


REGISTRY = (
    BuiltinTool('tool_search', 'Discover optional enabled tools by name or purpose; matched tools become available next turn. Try keywords such as browser, workflow, MCP or todo.',
                {'query': {'type': 'string'}}, ('query',), 'tool_search', False, _search),
    BuiltinTool('tool_result_read', 'Read a bounded page of the stored JSON text of a full recorded tool result in this session. Its offset is not a source-file offset.',
                {'tool_call_id': {'type': 'string', 'minLength': 1, 'maxLength': 200,
                                  'description': 'Exact full_result_tool_call_id from this session.'},
                 'offset': {'type': 'integer', 'minimum': 0,
                            'description': 'Character offset within the stored result JSON text, not within a source file.'},
                 'limit': {'type': 'integer', 'minimum': 1, 'maximum': RESULT_PAGE_MAX_CHARS,
                           'description': 'Maximum 4000 characters per page; default is configured page size.'}},
                ('tool_call_id',), 'tool_result_read', False, _read_result,
                concurrency_safe=True),
)
