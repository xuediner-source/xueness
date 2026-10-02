"""OpenAI-compatible SearchModel calls with explicitly unverified provenance."""
from __future__ import annotations

import json

from .search_settings import resolve_search_model_config
from .transport import NetworkError, _parse_https_url, post_json

MAX_QUERY_CHARS = 1000
MAX_SUMMARY_CHARS = 1200
MAX_RESULT_CHARS = 1000
MAX_RESULTS = 5

_SYSTEM_PROMPT = """Find useful sources for the user's query. If this endpoint has an enabled web search capability, use it; if it does not, do not invent source claims. Return only one JSON object with this shape: {\"summary\": string, \"sources\": [{\"title\": string, \"url\": string, \"snippet\": string}]}. Sources must be URLs you can provide; an empty sources array is better than invented URLs. Keep summary concise."""


def _content(response: dict) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise NetworkError("search_model_response_invalid", False,
                           "搜索模型响应中没有 OpenAI-compatible assistant message。")
    message = choices[0].get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise NetworkError("search_model_response_invalid", False,
                           "搜索模型没有返回 JSON assistant 内容；不会把自由文本当成搜索结果。")
    return message["content"]


def _source_url(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        return None
    try:
        parsed, host = _parse_https_url(value, allow_query=True)
    except NetworkError:
        return None
    # A numeric host can be checked without DNS. Domain answers are deliberately
    # not fetched here; web_fetch applies full DNS validation if the user later
    # approves opening the link.
    import ipaddress
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return None
    return value


def search(query: str, *, state_dir=None) -> dict:
    if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY_CHARS:
        raise NetworkError("invalid_query", False,
                           "搜索内容必须是 1 到 1000 个字符，请缩短后重试。")
    endpoint, model, key, doh_endpoint = resolve_search_model_config(state_dir)
    if any(c in key for c in "\r\n"):
        raise NetworkError("search_model_key_invalid", False,
                           "搜索模型密钥格式无效，请重新保存密钥。")
    payload = {
        "model": model,
        "temperature": 0,
        "max_tokens": 1200,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": query.strip()},
        ],
    }
    response, dns_source = post_json(endpoint, payload,
                                     {"Authorization": "Bearer " + key},
                                     doh_endpoint=doh_endpoint)
    try:
        decoded = json.loads(_content(response))
    except NetworkError:
        raise
    except (TypeError, ValueError):
        raise NetworkError("search_model_response_invalid", False,
                           "搜索模型没有返回所需 JSON 结果；不会把自由文本当成已验证网页搜索。") from None
    if not isinstance(decoded, dict) or not isinstance(decoded.get("sources"), list):
        raise NetworkError("search_model_response_invalid", False,
                           "搜索模型 JSON 必须包含 sources 数组；请检查模型是否遵循输出格式。")
    summary = decoded.get("summary", "")
    if not isinstance(summary, str):
        summary = ""
    if key in summary:
        summary = "[已隐藏包含密钥的模型输出]"
    output = []
    for item in decoded["sources"][:20]:
        if not isinstance(item, dict):
            continue
        url = _source_url(item.get("url"))
        if not url:
            continue
        title = str(item.get("title", ""))[:300]
        description = str(item.get("snippet", ""))[:MAX_RESULT_CHARS]
        if any(key and key in value for value in (url, title, description)):
            continue
        output.append({
            "title": title,
            "url": url,
            "description": description,
            "verified": False,
            "urlCheck": "https_syntax_only",
        })
        if len(output) >= MAX_RESULTS:
            break
    return {
        "ok": True,
        "query": query.strip(),
        "sourceType": "search_model",
        "dnsSource": dns_source,
        "untrusted": True,
        "summary": summary[:MAX_SUMMARY_CHARS],
        "output": output,
        "provenance": {
            "kind": "search_model",
            "model": model,
            "networkAccess": "unverified",
            "urlsVerified": False,
            "dnsSource": dns_source,
        },
        "notice": "搜索摘要和来源由模型生成；Xueness 未验证模型是否访问互联网或这些网页。网址仅做 HTTPS 结构检查。",
    }
