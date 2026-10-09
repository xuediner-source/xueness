"""Bounded web-search adapters; all services return the same source records."""
from __future__ import annotations

import json
from urllib.parse import unquote, urlencode

from .transport import NetworkError, _parse_https_url, fetch, post_json

PROVIDERS = ('brave', 'tavily', 'searxng')
DEFAULT_ENDPOINTS = {
    'brave': 'https://api.search.brave.com/res/v1/web/search',
    'tavily': 'https://api.tavily.com/search',
    'searxng': '',  # An instance is explicitly chosen by the operator.
}
MAX_RESULTS = 5


def _invalid():
    return NetworkError('search_response_invalid', False,
                        '搜索服务未返回有效的结果列表。请检查服务类型和接口地址；SearXNG 实例需要启用 JSON 输出。')


def normalize(payload, provider, query, key='', dns_source='system'):
    if not isinstance(payload, dict):
        raise _invalid()
    if provider == 'brave' and 'web' in payload:
        web = payload['web']
        rows = web.get('results') if isinstance(web, dict) else None
    else:
        rows = payload.get('results')
    if not isinstance(rows, list):
        raise _invalid()
    output = []
    for item in rows[:100]:
        if not isinstance(item, dict):
            continue
        url = item.get('url')
        if not isinstance(url, str) or len(url) > 4096:
            continue
        try:
            _parse_https_url(url, allow_query=True)
        except NetworkError:
            continue
        row = {'title': str(item.get('title', ''))[:300], 'url': url,
               'description': str(item.get('description' if provider == 'brave' else 'content', ''))[:1000]}
        if key and any(key in unquote(value) for value in row.values()):
            continue
        output.append(row)
        if len(output) >= MAX_RESULTS:
            break
    result = {'ok': True, 'query': query, 'sourceType': 'search_service', 'searchProvider': provider,
              'untrusted': True, 'output': output, 'dnsSource': dns_source,
              'provenance': {'kind': 'search_service', 'provider': provider,
                             'urlsVerified': False, 'dnsSource': dns_source}}
    credits = payload.get('usage', {}).get('credits') if isinstance(payload.get('usage'), dict) else None
    if provider == 'tavily' and type(credits) in (int, float) and 0 <= credits <= 100:
        result['usage'] = {'credits': credits}
    return result


def search(provider, endpoint, key, doh_endpoint, query):
    if not isinstance(query, str) or not query.strip() or len(query) > 1000:
        raise NetworkError('invalid_query', False, '搜索内容必须是 1 到 1000 个字符，请缩短后重试。')
    query = query.strip()
    try:
        if provider == 'tavily':
            payload, dns_source = post_json(endpoint, {
                'query': query, 'search_depth': 'basic', 'max_results': MAX_RESULTS,
                'topic': 'general', 'include_answer': False, 'include_raw_content': False,
                'include_images': False, 'auto_parameters': False, 'include_usage': True,
            }, {'Authorization': 'Bearer ' + key}, doh_endpoint=doh_endpoint)
        else:
            params = {'q': query, **({'format': 'json'} if provider == 'searxng' else {'count': MAX_RESULTS})}
            headers = {'Accept': 'application/json'}
            if provider == 'brave':
                headers['X-Subscription-Token'] = key
            elif provider != 'searxng':
                raise NetworkError('search_provider_invalid', False, '不支持的搜索服务类型。')
            response = fetch(endpoint + '?' + urlencode(params), headers,
                             max_chars=1_000_000, doh_endpoint=doh_endpoint)
            try:
                payload = json.loads(response['output'])
            except (KeyError, TypeError, ValueError):
                raise _invalid() from None
            dns_source = response.get('dnsSource', 'system')
    except NetworkError as exc:
        if exc.http_status in (401, 403):
            reason = ('SearXNG 拒绝了请求，请确认实例允许 JSON 搜索接口。' if provider == 'searxng' else
                      '搜索服务密钥无效或没有访问权限，请检查当前服务的密钥。')
            raise NetworkError('search_access_denied', False, reason, http_status=exc.http_status) from None
        if provider == 'tavily' and exc.http_status in (432, 433):
            raise NetworkError('search_quota_exhausted', False,
                               'Tavily 搜索额度已用完或达到用量上限。请等待额度重置或切换搜索服务。',
                               http_status=exc.http_status) from None
        if exc.error_code.startswith('search_model_'):
            raise _invalid() from None
        raise
    return normalize(payload, provider, query, key, dns_source)
