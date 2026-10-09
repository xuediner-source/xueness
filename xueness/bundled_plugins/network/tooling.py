"""Approval-gated public WebFetch and explicitly configured WebSearch."""
from __future__ import annotations

import json
import re
import time
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit

from ...tool_contract import BuiltinTool, execution_context
from . import search_settings
from .transport import NetworkError, _parse_https_url, fetch, resolve_public

_MAX_IMAGE_RESULTS = 10
_MAX_IMAGE_ROWS_TO_CHECK = 20
_MAX_IMAGE_DNS_HOSTS = 20
_IMAGE_URL_VALIDATION_SECONDS = 15.0


def _state_dir():
    try:
        return execution_context().get("state_dir")
    except ValueError:
        # Compatibility for historical, unbound low-level calls. Production
        # dispatch binds state_dir and therefore observes persisted settings.
        return None


def _as_network_error(exc):
    if isinstance(exc, NetworkError):
        return exc.as_result()
    # Do not expose filesystem errors, paths, exception strings, or credentials.
    return NetworkError(
        "network_settings_unavailable", False,
        "网络工具设置无法读取。请检查插件设置文件权限，或在网络搜索设置中重新保存配置。",
    ).as_result()


def _fetch(root, gate, args, session, call_id):
    url = args.get("url")
    # Gate refusals deliberately propagate unchanged so the shared runner can
    # distinguish pending approval from a permanent network failure.
    gate.check("web_fetch", url, call_id) if getattr(gate, "web_approval_gate", False) else gate.check("web_fetch", url)
    try:
        settings = search_settings.get_settings(_state_dir())
        result = fetch(url, doh_endpoint=settings.get("dohEndpoint") or "")
        result.pop("dnsSource", None)
        return result
    except (NetworkError, ValueError, OSError) as exc:
        return _as_network_error(exc)


def _search_payload(result: dict, key: str, query: str) -> dict:
    try:
        payload = json.loads(result["output"])
    except (TypeError, ValueError, KeyError):
        raise NetworkError("search_response_invalid", False,
                           "搜索服务返回了无效 JSON，请检查所选服务是否兼容 Brave Web Search JSON 接口。") from None
    if not isinstance(payload, dict):
        raise NetworkError("search_response_invalid", False,
                           "搜索服务返回格式无效，请检查服务配置。")
    rows = payload.get("web", {}).get("results", payload.get("results", [])) if isinstance(payload.get("web", {}), dict) else payload.get("results", [])
    if not isinstance(rows, list):
        raise NetworkError("search_response_invalid", False,
                           "搜索服务的结果列表格式无效，请检查服务配置。")
    output = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        row = {
            "title": str(item.get("title", ""))[:300],
            "url": str(item.get("url", ""))[:4096],
            "description": str(item.get("description", ""))[:1000],
        }
        if any(key and key in value for value in row.values()):
            continue
        output.append(row)
        if len(output) >= 5:
            break
    return {"ok": True, "query": query, "sourceType": "search_service", "untrusted": True,
            "output": output, "dnsSource": result.get("dnsSource", "system"),
            "provenance": {"kind": "search_service", "urlsVerified": False,
                           "dnsSource": result.get("dnsSource", "system")}}


def search(query: str, *, state_dir=None, doh_endpoint_override=None) -> dict:
    """Perform one bounded search using saved settings or operator env values."""
    from . import search_services
    provider, endpoint, key, doh_endpoint = search_settings.resolve_service_config(state_dir)
    if doh_endpoint_override is not None:
        doh_endpoint = doh_endpoint_override
    return search_services.search(provider, endpoint, key, doh_endpoint, query)


def _image_text(value, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _image_dimension(*values):
    for value in values:
        if type(value) is int and 0 < value <= 100_000:
            return value
    return None


def _checked_image_url(value, *, doh_endpoint, search_key, validation_budget):
    """Keep only public HTTPS image metadata URLs; never request their content."""
    if not isinstance(value, str) or not value or len(value) > 4096:
        return None
    if search_key and (search_key in value or search_key in unquote(value)):
        return None
    sensitive_names = {"key", "token", "auth", "authorization", "signature", "sig",
                       "secret", "password", "credential"}
    try:
        query_names = (re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name).lower()
                       for name, _ in parse_qsl(urlsplit(value).query, keep_blank_values=True))
        if any(sensitive_names.intersection(re.split(r"[._-]+", name)) for name in query_names):
            return None
    except (TypeError, ValueError):
        return None
    try:
        _, host = _parse_https_url(value, allow_query=True)
    except NetworkError:
        return None
    dns_cache = validation_budget["dns_cache"]
    if host not in dns_cache:
        if (validation_budget["exhausted"]
                or len(dns_cache) >= _MAX_IMAGE_DNS_HOSTS
                or time.monotonic() >= validation_budget["deadline"]):
            validation_budget["exhausted"] = True
            validation_budget["truncated"] = True
            return None
        # Reserve a slot before the resolver call so failed hosts count toward
        # the same strict unique-host limit as successful ones.
        dns_cache[host] = None
        try:
            _, source = resolve_public(host, doh_endpoint)
            if time.monotonic() >= validation_budget["deadline"]:
                validation_budget["exhausted"] = True
                validation_budget["truncated"] = True
            else:
                dns_cache[host] = source
        except NetworkError:
            if time.monotonic() >= validation_budget["deadline"]:
                validation_budget["exhausted"] = True
                validation_budget["truncated"] = True
    if dns_cache[host] is None:
        return None
    return value


def _image_search_payload(result: dict, key: str, query: str, doh_endpoint: str) -> dict:
    try:
        payload = json.loads(result["output"])
    except (TypeError, ValueError, KeyError):
        raise NetworkError("image_search_response_invalid", False,
                           "图片搜索服务返回了无效 JSON，请检查服务是否兼容 Brave Image Search。") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise NetworkError("image_search_response_invalid", False,
                           "图片搜索服务返回格式无效，请检查 Brave Image Search 兼容配置。")

    validation_budget = {
        "dns_cache": {},
        "deadline": time.monotonic() + _IMAGE_URL_VALIDATION_SECONDS,
        "exhausted": False,
        "truncated": False,
    }
    output = []
    raw_rows = payload["results"]
    rows = raw_rows[:_MAX_IMAGE_ROWS_TO_CHECK]
    truncated = len(raw_rows) > len(rows)
    for index, item in enumerate(rows):
        if validation_budget["exhausted"]:
            truncated = True
            break
        if not isinstance(item, dict):
            continue
        properties = item.get("properties") if isinstance(item.get("properties"), dict) else {}
        thumbnail = item.get("thumbnail") if isinstance(item.get("thumbnail"), dict) else {}
        image_url = _checked_image_url(properties.get("url"), doh_endpoint=doh_endpoint,
                                       search_key=key, validation_budget=validation_budget)
        if not image_url:
            continue
        source_url = _checked_image_url(item.get("url"), doh_endpoint=doh_endpoint,
                                       search_key=key, validation_budget=validation_budget)
        thumbnail_url = _checked_image_url(thumbnail.get("src"), doh_endpoint=doh_endpoint,
                                           search_key=key, validation_budget=validation_budget)
        title = _image_text(item.get("title"), 300)
        if key and key in title:
            continue
        output.append({
            "title": title,
            "imageUrl": image_url,
            "sourceUrl": source_url,
            "thumbnailUrl": thumbnail_url,
            "width": _image_dimension(properties.get("width"), thumbnail.get("width")),
            "height": _image_dimension(properties.get("height"), thumbnail.get("height")),
            "urlCheck": "https_public_dns_only",
        })
        if len(output) >= _MAX_IMAGE_RESULTS:
            truncated = truncated or index + 1 < len(rows)
            break
    truncated = truncated or validation_budget["truncated"]
    dns_source = result.get("dnsSource", "system")
    return {
        "ok": True,
        "query": query,
        "sourceType": "image_search_service",
        "untrusted": True,
        "output": output,
        "truncated": truncated,
        "dnsSource": dns_source,
        "provenance": {
            "kind": "image_search_service",
            "urlsVerified": False,
            "urlCheck": "https_public_dns_only",
            "mediaFetched": False,
            "dnsSource": dns_source,
        },
        "notice": "图片及来源地址仅通过 HTTPS 和公网 DNS 检查；Xueness 未获取图片内容。",
    }


def image_search(query: str, *, state_dir=None, doh_endpoint_override=None) -> dict:
    """Search a configured real image service and return bounded URL metadata."""
    if not isinstance(query, str) or not query.strip() or len(query) > 400 or len(query.split()) > 50:
        raise NetworkError("invalid_query", False,
                           "图片搜索内容必须是 1 到 400 个字符且不超过 50 个词，请缩短后重试。")
    endpoint, key, doh_endpoint = search_settings.resolve_image_search_config(state_dir)
    if doh_endpoint_override is not None:
        doh_endpoint = doh_endpoint_override
    url = endpoint + "?" + urlencode({"q": query, "count": 10, "safesearch": "strict"})
    result = fetch(url, {"X-Subscription-Token": key, "Accept": "application/json"},
                   max_chars=1_000_000, doh_endpoint=doh_endpoint)
    return _image_search_payload(result, key, query, doh_endpoint)


def _search(root, gate, args, session, call_id):
    query = args.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > 1000:
        return NetworkError("invalid_query", False,
                           "搜索内容必须是 1 到 1000 个字符，请缩短后重试。").as_result()
    gate.check("web_search", query, call_id) if getattr(gate, "web_approval_gate", False) else gate.check("web_search", query)
    try:
        state_dir = _state_dir()
        if search_settings.get_search_mode(state_dir) == "model":
            from .search_model import search as search_with_model
            return search_with_model(query, state_dir=state_dir)
        return search(query, state_dir=state_dir)
    except (NetworkError, ValueError, OSError) as exc:
        return _as_network_error(exc)


def _image_search(root, gate, args, session, call_id):
    query = args.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > 400 or len(query.split()) > 50:
        return NetworkError("invalid_query", False,
                            "图片搜索内容必须是 1 到 400 个字符且不超过 50 个词，请缩短后重试。").as_result()
    gate.check("web_search", query, call_id) if getattr(gate, "web_approval_gate", False) else gate.check("web_search", query)
    try:
        return image_search(query, state_dir=_state_dir())
    except (NetworkError, ValueError, OSError) as exc:
        return _as_network_error(exc)


REGISTRY = (
    BuiltinTool("web_fetch", "Read one public HTTPS page; content is untrusted and requires approval",
                {"url": {"type": "string"}}, ("url",), "web_fetch", False, _fetch),
    BuiltinTool("web_search", "Search through the explicitly configured public web service; requires approval",
                {"query": {"type": "string"}}, ("query",), "web_search", False, _search),
    BuiltinTool("image_search", "Search a configured public image service for image URLs; requires approval",
                {"query": {"type": "string"}}, ("query",), "web_search", False, _image_search),
)

REGISTRY[0].approval_subject = lambda args: args.get("url", "")
REGISTRY[1].approval_subject = lambda args: args.get("query", "")
REGISTRY[2].approval_subject = lambda args: args.get("query", "")
