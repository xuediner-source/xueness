"""Bounded HTTPS transport for the network plugin.

Every connection is pinned to an address which passed an all-record public-IP
check, while TLS still verifies the requested hostname. A configured DoH
resolver is used only when the system resolver returns the RFC 2544
198.18.0.0/15 FakeIP range; it is never used to override a private or mixed
system answer.
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import socket
import ssl
from html.parser import HTMLParser
from urllib.parse import urlencode, urlsplit

MAX_BYTES = 1_000_000
MAX_MODEL_REQUEST_BYTES = 65_536
MAX_MODEL_RESPONSE_BYTES = 512_000
MAX_DOH_BYTES = 65_536
MAX_DNS_ANSWERS = 32
REQUEST_TIMEOUT = 15
DNS_TIMEOUT = 5
_FAKE_IP_V4 = ipaddress.ip_network("198.18.0.0/15")


class NetworkError(Exception):
    """Safe, user-actionable network failure consumed by the tool loop."""

    def __init__(self, error_code: str, retryable: bool, user_reason: str,
                 *, http_status: int | None = None):
        super().__init__(user_reason)
        self.error = error_code
        self.error_code = error_code
        self.retryable = retryable
        self.user_reason = user_reason
        self.reason = user_reason
        self.http_status = http_status

    def as_result(self) -> dict:
        result = {
            "ok": False,
            "error": self.error_code,
            "error_code": self.error_code,
            "retryable": self.retryable,
            "user_reason": self.user_reason,
            "reason": self.user_reason,
        }
        if self.http_status is not None:
            result["http_status"] = self.http_status
        return result


class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, text):
        if not self.hidden and text.strip():
            self.parts.append(text.strip())


class _PinnedHTTPS(http.client.HTTPSConnection):
    """Connect to one checked address but verify TLS against ``host``."""

    def __init__(self, host, address, port=443, timeout=REQUEST_TIMEOUT):
        super().__init__(host, port=port, timeout=timeout,
                         context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def _error(code, retryable, reason, *, http_status=None):
    return NetworkError(code, retryable, reason, http_status=http_status)


def _parse_https_url(url: str, *, allow_query: bool):
    if not isinstance(url, str) or not url or len(url) > 4096:
        raise _error("invalid_url", False, "网址格式无效或超过长度限制，请检查后再试。")
    if "\\" in url or any(ord(character) <= 0x20 or ord(character) == 0x7F for character in url):
        raise _error("invalid_url", False,
                     "网址不能包含空格、控制字符或反斜杠；请使用标准 HTTPS 网址。")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except (TypeError, ValueError):
        raise _error("invalid_url", False, "网址中的主机名或端口无效，请填写标准 HTTPS 网址。") from None
    if (parsed.scheme.lower() != "https" or not parsed.hostname or "@" in parsed.netloc
            or parsed.password or parsed.fragment or "#" in url or port not in (None, 443)
            or parsed.netloc.endswith(":")
            or (not allow_query and (parsed.query or "?" in url or "#" in url))):
        reason = ("目标必须是 HTTPS 公网网址，不能含账号、密码、片段或非标准端口。"
                  if allow_query else
                  "服务地址必须是无凭据、无查询参数的 HTTPS 公网网址，端口只能为 443。")
        raise _error("invalid_url", False, reason)
    host = parsed.hostname
    if "%" in host:
        raise _error("invalid_url", False, "网址不能包含带区域标识的 IP 地址。")
    try:
        parsed.path.encode("ascii")
        parsed.query.encode("ascii")
    except UnicodeEncodeError:
        raise _error("invalid_url", False,
                     "网址路径和查询参数必须使用百分号编码的 ASCII 字符。") from None
    try:
        host_ascii = host.encode("idna").decode("ascii")
    except UnicodeError:
        raise _error("invalid_url", False, "网址中的主机名无效，请检查域名。") from None
    if not host_ascii or len(host_ascii) > 253:
        raise _error("invalid_url", False, "网址中的主机名无效，请检查域名。")
    return parsed, host_ascii


def _system_addresses(host: str) -> list[str]:
    try:
        records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        temporary_codes = {getattr(socket, "EAI_AGAIN", object()),
                           getattr(socket, "EAI_MEMORY", object()),
                           getattr(socket, "EAI_SYSTEM", object())}
        missing_codes = {getattr(socket, "EAI_NONAME", object()),
                         getattr(socket, "EAI_NODATA", object())}
        if exc.errno in temporary_codes:
            raise _error("dns_resolution_temporary", True,
                         "系统 DNS 暂时无法解析目标域名，请检查网络后重试。") from None
        if exc.errno in missing_codes:
            raise _error("dns_name_not_found", False,
                         "系统 DNS 没有该域名的地址记录，请检查网址或 DNS 配置。") from None
        raise _error("dns_resolution_failed", False,
                     "系统 DNS 无法解析目标域名，请检查网址或 DNS 配置。") from None
    except (OSError, OverflowError):
        raise _error("dns_resolution_failed", True,
                     "系统 DNS 查询暂时失败，请检查网络后重试。") from None
    addresses = sorted({record[4][0].split("%", 1)[0] for record in records})
    if not addresses:
        raise _error("dns_resolution_failed", True,
                     "系统 DNS 没有返回目标地址，请检查域名后重试。")
    return addresses


def _checked_public_addresses(addresses: list[str]) -> list[str]:
    if not addresses or len(addresses) > MAX_DNS_ANSWERS:
        raise _error("dns_answer_invalid", False,
                     "目标 DNS 应答为空或记录过多，已停止连接；请检查域名配置。")
    parsed = []
    for raw in addresses:
        try:
            address = ipaddress.ip_address(raw)
        except ValueError:
            raise _error("dns_answer_invalid", False,
                         "目标 DNS 返回了无法识别的地址，已停止连接。") from None
        if not address.is_global:
            raise _error("ssrf_blocked", False,
                         "目标解析到非公网地址，已按 SSRF 安全规则阻止请求。请改用公开网站；"
                         "只有确认代理使用 FakeIP 时，才配置公开 DoH 解析服务。")
        parsed.append(str(address))
    return sorted(set(parsed))


def _is_fakeip_only(addresses: list[str]) -> bool:
    if not addresses:
        return False
    try:
        return all((ip := ipaddress.ip_address(value)).version == 4 and ip in _FAKE_IP_V4
                   for value in addresses)
    except ValueError:
        return False


def _doh_addresses(host: str, endpoint: str) -> list[str]:
    """Resolve A and AAAA over an explicitly configured, public DoH endpoint."""
    parsed, resolver_host = _parse_https_url(endpoint, allow_query=False)
    resolver_addresses = _checked_public_addresses(_system_addresses(resolver_host))
    resolver_ip = resolver_addresses[0]
    base_path = parsed.path or "/dns-query"
    found = []
    for record_type in ("A", "AAAA"):
        query = urlencode({"name": host, "type": record_type})
        path = base_path + "?" + query
        connection = _PinnedHTTPS(resolver_host, resolver_ip, timeout=DNS_TIMEOUT)
        try:
            connection.request("GET", path, headers={
                "Accept": "application/dns-json",
                "User-Agent": "Xueness/1",
            })
            response = connection.getresponse()
            if response.status != 200:
                raise _error("doh_request_failed", response.status in (408, 425, 429) or response.status >= 500,
                             "配置的 DoH 服务未能完成 DNS 查询，请检查解析服务地址后重试。",
                             http_status=response.status)
            if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/dns-json":
                raise _error("doh_response_invalid", False,
                             "配置的 DoH 服务返回格式不受支持，请使用公开 DNS JSON-over-HTTPS 服务。")
            raw = response.read(MAX_DOH_BYTES + 1)
            if len(raw) > MAX_DOH_BYTES:
                raise _error("doh_response_invalid", False,
                             "配置的 DoH 服务返回内容过大，已停止查询。")
        except NetworkError:
            raise
        except (socket.timeout, TimeoutError):
            raise _error("doh_timeout", True,
                         "配置的 DoH 服务响应超时，请检查服务地址或稍后重试。") from None
        except (ssl.SSLError, http.client.HTTPException, OSError):
            raise _error("doh_request_failed", True,
                         "连接配置的 DoH 服务暂时失败，请检查网络后重试。") from None
        finally:
            connection.close()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeError, ValueError):
            raise _error("doh_response_invalid", False,
                         "配置的 DoH 服务返回了无效 JSON，应更换解析服务。") from None
        if not isinstance(payload, dict) or type(payload.get("Status")) is not int:
            raise _error("doh_response_invalid", False,
                         "配置的 DoH 服务返回了无效 DNS 状态码，请检查解析服务配置。")
        if payload["Status"] != 0:
            if payload["Status"] == 3:  # NXDOMAIN is not helped by retrying.
                raise _error("dns_name_not_found", False,
                             "DoH 服务确认该域名不存在，请检查网址或 DNS 配置。")
            if payload["Status"] == 2:  # SERVFAIL may be transient.
                raise _error("doh_lookup_failed", True,
                             "配置的 DoH 服务暂时无法完成 DNS 查询，请检查网络后重试。")
            raise _error("doh_lookup_failed", False,
                         "配置的 DoH 服务拒绝或无法解析此 DNS 查询，请检查域名和服务配置。")
        answers = payload.get("Answer", [])
        if not isinstance(answers, list) or len(answers) > MAX_DNS_ANSWERS:
            raise _error("doh_response_invalid", False,
                         "配置的 DoH 服务返回了无效或过多的 DNS 记录。")
        expected_type = 1 if record_type == "A" else 28
        for item in answers:
            if not isinstance(item, dict) or item.get("type") != expected_type:
                continue
            value = item.get("data")
            try:
                ip = ipaddress.ip_address(value)
            except (TypeError, ValueError):
                raise _error("doh_response_invalid", False,
                             "配置的 DoH 服务返回了无效地址，已停止连接。") from None
            found.append(str(ip))
    return _checked_public_addresses(found)


def resolve_public(host: str, doh_endpoint: str = "") -> tuple[list[str], str]:
    """Return the complete validated address set and its resolution source."""
    addresses = _system_addresses(host)
    if _is_fakeip_only(addresses):
        if not doh_endpoint:
            raise _error("fakeip_dns_blocked", False,
                         "系统 DNS 返回了 FakeIP 地址，已阻止请求。若代理使用 FakeIP，可在网络工具设置中"
                         "明确填写公开 DoH HTTPS 解析服务；否则请调整代理的 DNS 模式。")
        return _doh_addresses(host, doh_endpoint), "configured_doh"
    # A private, loopback, link-local, mixed FakeIP/public, or otherwise
    # non-global answer must not be hidden by a second resolver.
    return _checked_public_addresses(addresses), "system"


def _http_get(url: str, headers=None, *, doh_endpoint="", max_bytes=MAX_BYTES):
    parsed, host = _parse_https_url(url, allow_query=True)
    addresses, source = resolve_public(host, doh_endpoint)
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    connection = _PinnedHTTPS(host, addresses[0])
    try:
        connection.request("GET", path, headers={
            "Accept": "text/html, application/json, text/plain",
            "User-Agent": "Xueness/1",
            **(headers or {}),
        })
        response = connection.getresponse()
        if response.status != 200:
            retryable = response.status in (408, 425, 429) or response.status >= 500
            code = "http_temporary" if retryable else "http_permanent"
            reason = ("目标服务器暂时不可用，请稍后重试。" if retryable else
                      "目标服务器拒绝了请求或要求跳转；为保持安全，Xueness 不跟随重定向。请检查网址或服务配置。")
            raise _error(code, retryable, reason, http_status=response.status)
        kind = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        if kind not in ("text/html", "text/plain", "application/json", "application/xhtml+xml"):
            raise _error("unsupported_content", False,
                         "目标返回了不支持的内容类型，请改用 HTML、纯文本或 JSON 页面。")
        raw = response.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise _error("response_too_large", False,
                         "目标内容超过读取上限，请选择较小的公开页面。")
    except NetworkError:
        raise
    except (socket.timeout, TimeoutError):
        raise _error("network_timeout", True,
                     "连接目标服务器超时，请检查网络后重试。") from None
    except ssl.SSLCertVerificationError:
        raise _error("tls_certificate_invalid", False,
                     "目标 HTTPS 证书无法验证，连接已停止；请检查网址或系统证书。") from None
    except ssl.SSLError:
        raise _error("tls_handshake_failed", False,
                     "目标 HTTPS 安全握手失败，连接已停止；请检查网址或系统代理配置。") from None
    except (http.client.HTTPException, OSError):
        raise _error("network_unavailable", True,
                     "连接目标服务器暂时失败，请检查网络后重试。") from None
    finally:
        connection.close()
    text = raw.decode("utf-8", errors="replace")
    if kind in ("text/html", "application/xhtml+xml"):
        parser = _Text()
        parser.feed(text)
        text = "\n".join(parser.parts)
    return text, kind, source, len(text)


def fetch(url: str, headers=None, max_chars=16_000, *, doh_endpoint="") -> dict:
    text, kind, source, total_chars = _http_get(url, headers, doh_endpoint=doh_endpoint)
    return {
        "ok": True,
        "url": url,
        "contentType": kind,
        "output": text[:max_chars],
        "truncated": total_chars > max_chars,
        "untrusted": True,
        "dnsSource": source,
    }


def post_json(url: str, payload: dict, headers=None, *, doh_endpoint="") -> tuple[dict, str]:
    """POST bounded JSON to an explicitly configured public HTTPS endpoint."""
    parsed, host = _parse_https_url(url, allow_query=False)
    try:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError):
        raise _error("search_model_request_invalid", False,
                     "搜索模型请求内容无效，请检查查询后重试。") from None
    if len(body) > MAX_MODEL_REQUEST_BYTES:
        raise _error("search_model_request_too_large", False,
                     "搜索模型请求超过大小限制，请缩短查询内容。")
    addresses, source = resolve_public(host, doh_endpoint)
    path = parsed.path or "/"
    connection = _PinnedHTTPS(host, addresses[0])
    try:
        connection.request("POST", path, body=body, headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Xueness/1",
            **(headers or {}),
        })
        response = connection.getresponse()
        if response.status != 200:
            retryable = response.status in (408, 425, 429) or response.status >= 500
            code = "http_temporary" if retryable else "http_permanent"
            reason = ("搜索模型服务暂时不可用，请稍后重试。" if retryable else
                      "搜索模型服务拒绝了请求或要求跳转；为保持安全，Xueness 不跟随重定向。"
                      "请检查接口地址、模型 ID 和服务商权限。")
            raise _error(code, retryable, reason, http_status=response.status)
        kind = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        if kind != "application/json":
            raise _error("search_model_response_invalid", False,
                         "搜索模型服务未返回 application/json 响应，请检查 OpenAI-compatible 接口地址。")
        raw = response.read(MAX_MODEL_RESPONSE_BYTES + 1)
        if len(raw) > MAX_MODEL_RESPONSE_BYTES:
            raise _error("search_model_response_too_large", False,
                         "搜索模型响应超过大小限制，请限制服务端输出长度。")
    except NetworkError:
        raise
    except (socket.timeout, TimeoutError):
        raise _error("network_timeout", True,
                     "连接搜索模型服务超时，请检查网络后重试。") from None
    except ssl.SSLCertVerificationError:
        raise _error("tls_certificate_invalid", False,
                     "搜索模型服务的 HTTPS 证书无法验证，连接已停止。") from None
    except ssl.SSLError:
        raise _error("tls_handshake_failed", False,
                     "搜索模型服务 HTTPS 安全握手失败，连接已停止。") from None
    except (http.client.HTTPException, OSError):
        raise _error("network_unavailable", True,
                     "连接搜索模型服务暂时失败，请检查网络后重试。") from None
    finally:
        connection.close()
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError):
        raise _error("search_model_response_invalid", False,
                     "搜索模型服务返回了无效 JSON，请检查接口配置。") from None
    if not isinstance(result, dict):
        raise _error("search_model_response_invalid", False,
                     "搜索模型服务返回格式无效，请检查接口配置。")
    return result, source


def probe_dns(endpoint: str, doh_endpoint: str = "") -> dict:
    """Perform an explicit settings diagnostic for the endpoint's DNS only."""
    _, host = _parse_https_url(endpoint, allow_query=False)
    addresses, source = resolve_public(host, doh_endpoint)
    return {"ok": True, "host": host, "addressCount": len(addresses), "dnsSource": source}
