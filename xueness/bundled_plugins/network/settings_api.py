"""State-scoped configuration and explicit diagnostics for network tools."""
from __future__ import annotations

from . import search_settings
from .tooling import search
from .transport import NetworkError, probe_dns


def dispatch(method, parts, query, data, ctx):
    if parts not in (["api", "network", "settings"], ["api", "network", "diagnostics"]):
        return None
    method = (method or "").upper()
    route = parts[2]
    if route == "settings":
        if method == "GET":
            try:
                return 200, {"settings": search_settings.get_settings(ctx["state_dir"])}
            except (OSError, ValueError):
                return 500, {"error": "网络工具设置无法读取，请检查本地设置文件权限。"}
        if method == "POST":
            try:
                settings = search_settings.update_settings(ctx["state_dir"], data)
            except (OSError, ValueError) as exc:
                # Validation messages are local and credential-free. Do not echo
                # serialized bodies or filesystem exception strings.
                return 400, {"error": str(exc) if isinstance(exc, ValueError)
                             else "无法保存网络工具设置，请检查本地目录权限。"}
            return 200, {"settings": settings}
        return 405, {"error": "仅支持 GET 和 POST。"}

    if method != "POST":
        return 405, {"error": "仅支持 POST。"}
    if not isinstance(data, dict) or set(data) != {"operation"}:
        return 400, {"error": "请提供 operation: dns 或 search。"}
    operation = data.get("operation")
    if operation not in ("dns", "search"):
        return 400, {"error": "operation 必须是 dns 或 search。"}
    try:
        values = search_settings.get_settings(ctx["state_dir"])
        if operation == "dns":
            endpoint = (values["searchModelEndpoint"] if values["searchMode"] == "model"
                        else values["searchEndpoint"])
            result = probe_dns(endpoint, values.get("dohEndpoint") or "")
            return 200, {"ok": True, "operation": "dns", "host": result["host"],
                         "addressCount": result["addressCount"], "dnsSource": result["dnsSource"],
                         "message": "目标 DNS 解析正常；未连接搜索服务或模型接口。"}
        # This request is intentionally available only behind a user-clicked
        # diagnostic button. It sends one fixed, minimal query and never returns
        # provider response text or search snippets.
        if values["searchMode"] == "model":
            from .search_model import search as search_with_model
            result = search_with_model("xueness network service diagnostic", state_dir=ctx["state_dir"])
            message = "搜索模型接口返回了有效结构化结果；这不能证明模型具有联网搜索能力。"
        else:
            result = search("xueness network service diagnostic", state_dir=ctx["state_dir"])
            message = "搜索服务已响应一次诊断请求。"
        return 200, {"ok": True, "operation": "search", "dnsSource": result.get("dnsSource", "system"),
                     "sourceType": result.get("sourceType", "search_model"), "message": message}
    except NetworkError as exc:
        return 200, {"operation": operation, **exc.as_result()}
    except (OSError, ValueError):
        return 200, {"operation": operation, **NetworkError(
            "network_settings_unavailable", False,
            "网络工具设置无法读取。请检查设置文件权限，或重新保存网络搜索配置。",
        ).as_result()}
