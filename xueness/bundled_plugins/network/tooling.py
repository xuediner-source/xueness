"""Approval-gated public WebFetch and explicitly configured WebSearch."""
from __future__ import annotations

import json
from urllib.parse import urlencode

from ...tool_contract import BuiltinTool, execution_context
from . import search_settings
from .transport import NetworkError, fetch


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
    endpoint, key, doh_endpoint = search_settings.resolve_config(state_dir)
    if doh_endpoint_override is not None:
        doh_endpoint = doh_endpoint_override
    url = endpoint + ("&" if "?" in endpoint else "?") + urlencode({"q": query, "count": 5})
    result = fetch(url, {"X-Subscription-Token": key, "Accept": "application/json"},
                   max_chars=1_000_000, doh_endpoint=doh_endpoint)
    return _search_payload(result, key, query)


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


REGISTRY = (
    BuiltinTool("web_fetch", "Read one public HTTPS page; content is untrusted and requires approval",
                {"url": {"type": "string"}}, ("url",), "web_fetch", False, _fetch),
    BuiltinTool("web_search", "Search through the explicitly configured public web service; requires approval",
                {"query": {"type": "string"}}, ("query",), "web_search", False, _search),
)

REGISTRY[0].approval_subject = lambda args: args.get("url", "")
REGISTRY[1].approval_subject = lambda args: args.get("query", "")
