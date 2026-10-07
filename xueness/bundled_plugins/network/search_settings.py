"""State-scoped search and optional DoH settings for the network plugin.

Search credentials are stored separately from non-secret settings in
owner-private files (POSIX mode 0600 or a protected Windows DACL) and are never
included in API responses. Environment variables remain a backward-compatible
fallback for operator-managed deployments.
"""
from __future__ import annotations

import json
import ipaddress
import os
from pathlib import Path
import tempfile
import threading
from urllib.parse import urlsplit

from .transport import NetworkError, _parse_https_url
from ...resources import _is_link, _protect_private_file

_LOCK = threading.RLock()
_DEFAULT_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
_DEFAULT_IMAGE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/images/search"
_SETTINGS_FILE = "settings.json"
_SECRET_FILE = "search-key.json"
_MODEL_SECRET_FILE = "search-model-key.json"
_MAX_SETTINGS_BYTES = 16_384
_MAX_KEY_LENGTH = 4096


def _network_dir(state_dir, *, create=False) -> Path | None:
    if state_dir is None:
        return None
    root = Path(state_dir).expanduser().resolve()
    directory = root / "network"
    if _is_link(directory) or not directory.resolve().is_relative_to(root):
        raise ValueError("network settings path denied")
    if create:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if _is_link(directory) or not directory.resolve().is_relative_to(root):
            raise ValueError("network settings path denied")
        try:
            os.chmod(directory, 0o700)
        except OSError:
            pass
    elif not directory.exists():
        return None
    if not directory.is_dir():
        raise ValueError("network settings path denied")
    return directory


def _read_json(path: Path, *, allow_missing=True):
    if _is_link(path):
        raise ValueError("network settings file must not be a symlink, junction, or reparse point")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        if allow_missing:
            return {}
        raise
    except OSError:
        raise ValueError("network settings file is unavailable") from None
    try:
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read(_MAX_SETTINGS_BYTES + 1)
    except OSError:
        raise ValueError("network settings file is unavailable") from None
    if len(raw) > _MAX_SETTINGS_BYTES:
        raise ValueError("network settings file is too large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError):
        raise ValueError("network settings file is invalid") from None
    if not isinstance(value, dict):
        raise ValueError("network settings file is invalid")
    return value


def _write_json(path: Path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if _is_link(path.parent) or _is_link(path):
        raise ValueError("network settings path denied")
    fd, temporary = tempfile.mkstemp(prefix=".network-", dir=str(path.parent))
    try:
        try:
            _protect_private_file(fd)
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _settings_path(state_dir):
    directory = _network_dir(state_dir)
    return directory / _SETTINGS_FILE if directory else None


def _secret_path(state_dir, *, create=False):
    directory = _network_dir(state_dir, create=create)
    return directory / _SECRET_FILE if directory else None


def _model_secret_path(state_dir, *, create=False):
    directory = _network_dir(state_dir, create=create)
    return directory / _MODEL_SECRET_FILE if directory else None


def _valid_https_endpoint(value: str, *, doh=False) -> bool:
    try:
        _, host = _parse_https_url(value, allow_query=False)
    except NetworkError:
        return False
    parsed = urlsplit(value)
    if doh and not parsed.path:
        return False
    normalized_host = host.rstrip(".").lower()
    if normalized_host == "localhost" or normalized_host.endswith(".localhost"):
        return False
    try:
        address = ipaddress.ip_address(normalized_host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return False
    return True


def validate_endpoint(value, *, doh=False) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 2048:
        raise ValueError("请填写 HTTPS 服务地址。")
    endpoint = value.strip()
    if not _valid_https_endpoint(endpoint, doh=doh):
        if doh:
            raise ValueError("DoH 地址必须是无凭据、无查询参数的 HTTPS DNS JSON 服务地址，端口只能为 443。")
        raise ValueError("搜索地址必须是无凭据、无查询参数的 HTTPS 服务地址，端口只能为 443。")
    return endpoint


def _read_settings(state_dir):
    path = _settings_path(state_dir)
    if path is None:
        return {}
    return _read_json(path)


def _read_saved_key(state_dir):
    path = _secret_path(state_dir)
    if path is None:
        return ""
    value = _read_json(path)
    key = value.get("apiKey", "")
    return key if isinstance(key, str) and len(key) <= _MAX_KEY_LENGTH else ""


def _read_saved_model_key(state_dir):
    path = _model_secret_path(state_dir)
    if path is None:
        return ""
    value = _read_json(path)
    key = value.get("apiKey", "")
    return key if isinstance(key, str) and len(key) <= _MAX_KEY_LENGTH else ""


def _key_is_usable(value) -> bool:
    return isinstance(value, str) and bool(value) and len(value) <= _MAX_KEY_LENGTH and not any(
        character in value for character in "\r\n")


def get_settings(state_dir=None) -> dict:
    with _LOCK:
        stored = _read_settings(state_dir)
        endpoint = stored.get("searchEndpoint")
        if not isinstance(endpoint, str) or not endpoint:
            endpoint = os.environ.get("XUENESS_SEARCH_ENDPOINT", _DEFAULT_SEARCH_ENDPOINT)
        image_endpoint = stored.get("imageSearchEndpoint")
        if not isinstance(image_endpoint, str) or not image_endpoint:
            image_endpoint = os.environ.get("XUENESS_IMAGE_SEARCH_ENDPOINT", "")
        doh_endpoint = stored.get("dohEndpoint")
        if not isinstance(doh_endpoint, str):
            doh_endpoint = os.environ.get("XUENESS_DOH_ENDPOINT", "")
        saved_key = _read_saved_key(state_dir)
        environment_key = os.environ.get("XUENESS_SEARCH_KEY", "")
        source = "saved" if _key_is_usable(saved_key) else "environment" if _key_is_usable(environment_key) else "none"
        model_key = _read_saved_model_key(state_dir)
        mode = stored.get("searchMode") if stored.get("searchMode") in ("service", "model") else "service"
        model_endpoint = stored.get("searchModelEndpoint")
        model_name = stored.get("searchModel")
        return {
            "searchEndpoint": endpoint,
            "imageSearchEndpoint": image_endpoint,
            "dohEndpoint": doh_endpoint,
            "searchMode": mode,
            "searchModelEndpoint": model_endpoint if isinstance(model_endpoint, str) else "",
            "searchModel": model_name if isinstance(model_name, str) else "",
            "hasSearchKey": _key_is_usable(saved_key) or _key_is_usable(environment_key),
            "hasSavedSearchKey": _key_is_usable(saved_key),
            "hasEnvironmentSearchKey": _key_is_usable(environment_key),
            "searchKeySource": source,
            "hasSearchModelKey": _key_is_usable(model_key),
            "hasSavedSearchModelKey": _key_is_usable(model_key),
        }


def resolve_config(state_dir=None) -> tuple[str, str, str]:
    """Return search endpoint, credential and optional DoH resolver endpoint."""
    with _LOCK:
        settings = _read_settings(state_dir)
        endpoint = settings.get("searchEndpoint") or os.environ.get(
            "XUENESS_SEARCH_ENDPOINT", _DEFAULT_SEARCH_ENDPOINT)
        doh_endpoint = settings.get("dohEndpoint")
        if not isinstance(doh_endpoint, str):
            doh_endpoint = os.environ.get("XUENESS_DOH_ENDPOINT", "")
        saved_key = _read_saved_key(state_dir)
        key = saved_key if _key_is_usable(saved_key) else os.environ.get("XUENESS_SEARCH_KEY", "")
        if not isinstance(endpoint, str) or not _valid_https_endpoint(endpoint):
            raise NetworkError("search_endpoint_invalid", False,
                               "网页搜索服务地址无效。请在网络搜索设置中填写公开 HTTPS JSON 搜索服务地址。")
        if not _key_is_usable(key):
            raise NetworkError("search_key_missing", False,
                               "尚未配置网页搜索密钥。请在设置的网络搜索页保存服务密钥，或由管理员设置 XUENESS_SEARCH_KEY。")
        if doh_endpoint and (not isinstance(doh_endpoint, str) or not _valid_https_endpoint(doh_endpoint, doh=True)):
            raise NetworkError("doh_endpoint_invalid", False,
                               "DoH 解析服务地址无效。请清空该设置，或填写公开、无凭据的 HTTPS DNS JSON 地址。")
        return endpoint, key, doh_endpoint


def resolve_image_search_config(state_dir=None) -> tuple[str, str, str]:
    """Return a real image-search service endpoint, service key, and DoH.

    Image search never routes through the text-only SearchModel. In service
    mode, an unset endpoint uses Brave's official image-search API. In model
    mode, an explicitly configured image endpoint is required so the tool
    cannot imply that a text model returned verified image results.
    """
    with _LOCK:
        settings = _read_settings(state_dir)
        configured_endpoint = settings.get("imageSearchEndpoint")
        if not isinstance(configured_endpoint, str) or not configured_endpoint:
            configured_endpoint = os.environ.get("XUENESS_IMAGE_SEARCH_ENDPOINT", "")
        configured = isinstance(configured_endpoint, str) and bool(configured_endpoint.strip())
        mode = settings.get("searchMode", "service")
        if mode not in ("service", "model"):
            mode = "service"
        if mode == "model" and not configured:
            raise NetworkError("image_search_unsupported", False,
                               "当前搜索模型模式没有配置真实图片搜索服务。请在网络搜索设置中填写图片搜索 HTTPS 地址；"
                               "搜索模型不会生成或伪造图片搜索结果。")
        endpoint = configured_endpoint.strip() if configured else _DEFAULT_IMAGE_SEARCH_ENDPOINT
        if not isinstance(endpoint, str) or not _valid_https_endpoint(endpoint):
            raise NetworkError("image_search_endpoint_invalid", False,
                               "图片搜索服务地址无效。请在网络搜索设置中填写公开 HTTPS Brave Image Search 兼容地址。")
        saved_key = _read_saved_key(state_dir)
        key = saved_key if _key_is_usable(saved_key) else os.environ.get("XUENESS_SEARCH_KEY", "")
        if not _key_is_usable(key):
            raise NetworkError("image_search_key_missing", False,
                               "尚未配置图片搜索服务密钥。请在网络搜索设置中保存服务密钥，或由管理员设置 XUENESS_SEARCH_KEY。")
        doh_endpoint = settings.get("dohEndpoint")
        if not isinstance(doh_endpoint, str):
            doh_endpoint = os.environ.get("XUENESS_DOH_ENDPOINT", "")
        if doh_endpoint and (not isinstance(doh_endpoint, str)
                             or not _valid_https_endpoint(doh_endpoint, doh=True)):
            raise NetworkError("doh_endpoint_invalid", False,
                               "DoH 解析服务地址无效。请清空该设置，或填写公开、无凭据的 HTTPS DNS JSON 地址。")
        return endpoint, key, doh_endpoint


def get_search_mode(state_dir=None) -> str:
    with _LOCK:
        mode = _read_settings(state_dir).get("searchMode", "service")
        return mode if mode in ("service", "model") else "service"


def resolve_search_model_config(state_dir=None) -> tuple[str, str, str, str]:
    with _LOCK:
        settings = _read_settings(state_dir)
        endpoint = settings.get("searchModelEndpoint", "")
        model = settings.get("searchModel", "")
        key = _read_saved_model_key(state_dir)
        doh_endpoint = settings.get("dohEndpoint")
        if not isinstance(doh_endpoint, str):
            doh_endpoint = os.environ.get("XUENESS_DOH_ENDPOINT", "")
        if not isinstance(endpoint, str) or not _valid_https_endpoint(endpoint):
            raise NetworkError("search_model_endpoint_invalid", False,
                               "搜索模型接口地址无效。请填写公开 HTTPS OpenAI-compatible Chat Completions 地址；"
                               "暂不支持本机或私网模型地址。")
        if not isinstance(model, str) or not model.strip() or len(model) > 200 or any(ord(c) < 32 for c in model):
            raise NetworkError("search_model_missing", False,
                               "尚未填写搜索模型名称。请在网络搜索设置中填写服务商提供的 model ID。")
        if not key or len(key) > _MAX_KEY_LENGTH or any(c in key for c in "\r\n"):
            raise NetworkError("search_model_key_missing", False,
                               "尚未配置搜索模型密钥。请在网络搜索设置中保存独立的搜索模型 API 密钥。")
        if doh_endpoint and (not isinstance(doh_endpoint, str) or not _valid_https_endpoint(doh_endpoint, doh=True)):
            raise NetworkError("doh_endpoint_invalid", False,
                               "DoH 解析服务地址无效。请清空该设置，或填写公开、无凭据的 HTTPS DNS JSON 地址。")
        return endpoint, model.strip(), key, doh_endpoint


def update_settings(state_dir, data: dict) -> dict:
    """Validate and persist a partial update; credentials never leave storage."""
    if not isinstance(data, dict):
        raise ValueError("请求内容必须是对象。")
    allowed = {"searchEndpoint", "imageSearchEndpoint", "dohEndpoint", "searchMode", "searchKey", "clearSearchKey",
               "searchModelEndpoint", "searchModel", "searchModelKey", "clearSearchModelKey"}
    if set(data) - allowed:
        raise ValueError("包含不支持的网络搜索设置字段。")
    if "clearSearchKey" in data and type(data["clearSearchKey"]) is not bool:
        raise ValueError("clearSearchKey 必须是布尔值。")
    if "clearSearchModelKey" in data and type(data["clearSearchModelKey"]) is not bool:
        raise ValueError("clearSearchModelKey 必须是布尔值。")
    for field in ("searchKey", "searchModelKey"):
        if field in data and not isinstance(data[field], str):
            raise ValueError("API 密钥必须是文本。")
        if field in data and (len(data[field]) > _MAX_KEY_LENGTH or any(c in data[field] for c in "\r\n")):
            raise ValueError("API 密钥格式无效或超过长度限制。")
    if "searchMode" in data and data["searchMode"] not in ("service", "model"):
        raise ValueError("searchMode 必须是 service 或 model。")
    if "searchEndpoint" in data:
        data = {**data, "searchEndpoint": validate_endpoint(data["searchEndpoint"])}
    if "imageSearchEndpoint" in data:
        raw_endpoint = data["imageSearchEndpoint"]
        if not isinstance(raw_endpoint, str):
            raise ValueError("图片搜索服务地址必须是文本。")
        data = {**data, "imageSearchEndpoint": validate_endpoint(raw_endpoint) if raw_endpoint.strip() else ""}
    if "searchModelEndpoint" in data:
        raw_endpoint = data["searchModelEndpoint"]
        if not isinstance(raw_endpoint, str):
            raise ValueError("搜索模型接口地址必须是文本。")
        data = {**data, "searchModelEndpoint": validate_endpoint(raw_endpoint) if raw_endpoint.strip() else ""}
    if "searchModel" in data:
        model = data["searchModel"]
        if not isinstance(model, str) or len(model) > 200 or any(ord(c) < 32 for c in model):
            raise ValueError("搜索模型名称格式无效。")
        data = {**data, "searchModel": model.strip()}
    if "dohEndpoint" in data:
        raw_doh = data["dohEndpoint"]
        if not isinstance(raw_doh, str):
            raise ValueError("DoH 服务地址必须是文本。")
        data = {**data, "dohEndpoint": validate_endpoint(raw_doh, doh=True) if raw_doh.strip() else ""}

    with _LOCK:
        directory = _network_dir(state_dir, create=True)
        settings_path = directory / _SETTINGS_FILE
        current = _read_json(settings_path)
        settings = {key: current.get(key) for key in ("searchEndpoint", "imageSearchEndpoint", "dohEndpoint", "searchMode",
                                                       "searchModelEndpoint", "searchModel")
                    if isinstance(current.get(key), str)}
        for field in ("searchEndpoint", "imageSearchEndpoint", "dohEndpoint", "searchMode", "searchModelEndpoint", "searchModel"):
            if field in data:
                settings[field] = data[field]
        _write_json(settings_path, settings)

        if data.get("clearSearchKey") is True:
            secret_path = _secret_path(state_dir, create=True)
            if _is_link(secret_path):
                raise ValueError("network credential path denied")
            try:
                secret_path.unlink()
            except FileNotFoundError:
                pass
        elif data.get("searchKey"):
            secret_path = _secret_path(state_dir, create=True)
            if _is_link(secret_path):
                raise ValueError("network credential path denied")
            _write_json(secret_path, {"apiKey": data["searchKey"]})

        if data.get("clearSearchModelKey") is True:
            secret_path = _model_secret_path(state_dir, create=True)
            if _is_link(secret_path):
                raise ValueError("network credential path denied")
            try:
                secret_path.unlink()
            except FileNotFoundError:
                pass
        elif data.get("searchModelKey"):
            secret_path = _model_secret_path(state_dir, create=True)
            if _is_link(secret_path):
                raise ValueError("network credential path denied")
            _write_json(secret_path, {"apiKey": data["searchModelKey"]})

    return get_settings(state_dir)


def current_settings_path(state_dir):
    """Exposed for targeted tests and safe diagnostic file ownership checks."""
    return _settings_path(state_dir)
