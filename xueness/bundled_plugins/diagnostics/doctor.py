"""Read-only health report: ``xueness doctor [--json] [--ping]``.

Aggregates bounded, local-only checks and prints a redacted summary:

* version information (Xueness, Python, platform),
* plugin catalog state (installed, effective, blocked dependencies),
* state-directory and workspace writability (a transient probe file is
  created and removed; nothing else is written and missing directories are
  reported rather than created),
* model configuration resolvability. The default path performs **no network
  request**: it validates that a provider profile or environment configuration
  resolves into a client. ``--ping`` is the operator's explicit opt-in to one
  bounded ``GET /models`` model-discovery request through the providers
  plugin's existing transport.

No credential value is ever printed: provider records are summarized through
the providers plugin's public redacted view, and errors are phrased with the
same credential-safe configuration guidance that run startup uses.
"""
from __future__ import annotations

import json
import os
import platform
import sys
import tempfile
import time
from pathlib import Path

SCHEMA = "xueness.doctor.v1"
PING_TIMEOUT_SECONDS = 5.0

LABELS = {
    "zh": {
        "title": "Xueness doctor（只读体检）",
        "version": "版本",
        "plugins": "插件",
        "effective": "生效",
        "blocked": "未生效",
        "storage": "存储",
        "writable": "可写",
        "not_writable": "不可写",
        "missing": "不存在",
        "symlink": "符号链接",
        "model": "模型",
        "profiles": "个 profile",
        "resolvable": "解析通过",
        "unresolvable": "解析失败",
        "env": "环境变量配置",
        "no_default": "未设默认",
        "ping_ok": "ping 通过",
        "ping_fail": "ping 失败",
        "overall": "整体",
        "pass": "通过",
        "fail": "存在问题",
    },
    "en": {
        "title": "Xueness doctor (read-only)",
        "version": "version",
        "plugins": "plugins",
        "effective": "effective",
        "blocked": "not effective",
        "storage": "storage",
        "writable": "writable",
        "not_writable": "not writable",
        "missing": "missing",
        "symlink": "symlink",
        "model": "model",
        "profiles": "profiles",
        "resolvable": "resolves",
        "unresolvable": "does not resolve",
        "env": "environment configuration",
        "no_default": "no default",
        "ping_ok": "ping ok",
        "ping_fail": "ping failed",
        "overall": "overall",
        "pass": "pass",
        "fail": "problems found",
    },
}


def _labels(language) -> dict:
    return LABELS["en"] if language == "en" else LABELS["zh"]


def _probe_directory(directory) -> dict:
    """Writability of one existing directory via a transient probe file."""
    path = Path(directory)
    result = {"path": str(path), "exists": path.is_dir(), "writable": False,
              "symlink": False, "freeBytes": None}
    from ...resources import _is_link
    if _is_link(path):
        result["symlink"] = True
        return result
    if not result["exists"]:
        return result
    try:
        import shutil
        result["freeBytes"] = shutil.disk_usage(path).free
    except OSError:
        pass
    fd = temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".xueness-doctor-", dir=path)
        remaining = memoryview(b"ok")
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0:
                raise OSError("writability probe made no progress")
            remaining = remaining[written:]
        os.close(fd)
        fd = None
        os.unlink(temporary)
        temporary = None
        result["writable"] = True
    except OSError:
        result["writable"] = False
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass
    return result


def plugins_check(state_dir) -> dict:
    """Catalog state; blocked plugins are reported, not treated as failures."""
    from ...plugin_runtime import catalog
    try:
        items = catalog(state_dir)
    except (OSError, ValueError):
        return {"installed": 0, "effective": 0, "blocked": [],
                "configurationError": "plugin catalog is unavailable"}
    blocked = [{"id": item["id"], "enabled": item["enabled"],
                "blockedBy": list(item.get("blockedBy") or ())}
               for item in items if not item["effective"]]
    error = next((item.get("configurationError") for item in items
                  if item.get("configurationError")), None)
    return {"installed": len(items), "effective": sum(1 for item in items if item["effective"]),
            "blocked": blocked, "configurationError": error}


def _resolve_target(state_dir, profiles, provider_config, env_configured) -> object:
    """Resolve the configuration a run would use; never performs a request.

    Order: a saved default selection (the resolver also falls back to the
    environment), then — when nothing is selected — the first saved profile,
    so a configured-but-unselected setup still reads as healthy. With nothing
    configured at all the friendly, credential-safe guidance is raised instead
    of the raw client-constructor validation error.
    """
    from ..providers import default_selection
    selection = default_selection.load(state_dir) or {}
    if selection:
        return provider_config.resolve(state_dir)
    if profiles:
        return provider_config.resolve(state_dir, profiles[0]["id"])
    if env_configured:
        return provider_config.resolve(state_dir)
    raise ValueError("XUENESS_MODEL and XUENESS_API_KEY must be set")


def model_check(state_dir, ping=False) -> dict:
    """Provider configuration resolvability; no network request by default."""
    from ...plugin_runtime import is_enabled
    from ..providers import provider_config, providers_api
    try:
        profiles = providers_api._list({"state_dir": state_dir})
    except (OSError, ValueError):
        profiles = []
    result = {
        "profiles": [{"id": item.get("id"), "model": item.get("model"),
                      "protocol": item.get("protocol", "openai"),
                      "hasKey": bool(item.get("hasKey"))} for item in profiles],
        "default": None,
        "envConfigured": bool(os.environ.get("XUENESS_API_BASE"))
                         and bool(os.environ.get("XUENESS_MODEL")),
        "ping": None,
    }
    try:
        from ..providers import default_selection
        result["default"] = default_selection.load(state_dir) or None
        provider = _resolve_target(state_dir, profiles, provider_config,
                                   result["envConfigured"])
        result["resolvable"] = True
        result["error"] = None
    except (ValueError, OSError, KeyError, TypeError) as exc:
        provider = None
        result["resolvable"] = False
        result["error"] = provider_config.configuration_error(exc)
    if ping:
        result["ping"] = _ping(state_dir, is_enabled, provider=provider)
    return result


def _ping(state_dir, is_enabled, provider=None) -> dict:
    """One bounded model-discovery request; the flag itself is the opt-in."""
    from ..providers import provider_config
    try:
        if not is_enabled(state_dir, "providers"):
            return {"ok": False, "error": "providers plugin is disabled"}
    except (OSError, ValueError):
        return {"ok": False, "error": "providers plugin is disabled"}
    if provider is None:
        try:
            env_configured = (bool(os.environ.get("XUENESS_API_BASE"))
                              and bool(os.environ.get("XUENESS_MODEL")))
            provider = _resolve_target(state_dir, [], provider_config, env_configured)
        except (ValueError, OSError, KeyError, TypeError) as exc:
            return {"ok": False, "error": provider_config.configuration_error(exc)}
    discover = getattr(provider, "discover_models", None)
    if not callable(discover):
        return {"ok": False,
                "error": "model discovery is not supported for this protocol"}
    try:
        models = discover(timeout=PING_TIMEOUT_SECONDS)
        return {"ok": True, "models": len(models) if isinstance(models, list) else None}
    except Exception:
        # Adapter failures suppress remote bodies, URLs and credentials.
        return {"ok": False, "error": "provider model discovery failed (details suppressed)"}


def report(state_dir, root=None, ping=False) -> dict:
    """The full read-only report as one redacted JSON document."""
    from ... import __version__
    state = _probe_directory(state_dir)
    workspace = _probe_directory(root if root is not None else Path.cwd())
    plugins = plugins_check(state_dir)
    model = model_check(state_dir, ping=ping)
    ping_ok = model["ping"] is None or model["ping"].get("ok") is True
    ok = bool(state["writable"] and workspace["writable"] and model["resolvable"]
              and ping_ok and not plugins["configurationError"])
    return {"schema": SCHEMA, "createdAt": time.time(),
            "version": {"xueness": __version__, "python": platform.python_version(),
                        "system": platform.system(), "machine": platform.machine()},
            "plugins": plugins,
            "storage": {"stateDir": state, "workspace": workspace},
            "model": model, "ok": ok}


def format_report(document, language=None) -> str:
    label = _labels(language)
    lines = [label["title"]]
    version = document["version"]
    lines.append("%s: xueness %s（Python %s, %s/%s）" % (
        label["version"], version["xueness"], version["python"],
        version["system"], version["machine"]))
    plugins = document["plugins"]
    lines.append("%s: %d，%s %d" % (label["plugins"], plugins["installed"],
                                   label["effective"], plugins["effective"]))
    for row in plugins["blocked"]:
        reason = "enabled=False" if not row["enabled"] else "blockedBy=%s" % ",".join(row["blockedBy"])
        lines.append("  %s: %s（%s）" % (label["blocked"], row["id"], reason))
    if plugins["configurationError"]:
        lines.append("  configurationError: %s" % plugins["configurationError"])
    storage = document["storage"]
    lines.append("%s: %s %s；%s %s" % (
        label["storage"],
        storage["stateDir"]["path"], _state_label(storage["stateDir"], label),
        storage["workspace"]["path"], _state_label(storage["workspace"], label)))
    model = document["model"]
    default = model["default"]
    default_text = "%s / %s" % (default.get("providerId") or label["no_default"],
                                default.get("model") or "") if default else label["no_default"]
    lines.append("%s: %d %s；%s；%s" % (
        label["model"], len(model["profiles"]), label["profiles"], default_text,
        label["resolvable"] if model["resolvable"] else "%s: %s" % (
            label["unresolvable"], model["error"] or "")))
    if not model["profiles"] and model["envConfigured"]:
        lines.append("  %s" % label["env"])
    ping = model.get("ping")
    if ping is not None:
        lines.append("  %s" % (label["ping_ok"] if ping["ok"] else
                               "%s (%s)" % (label["ping_fail"], ping.get("error") or "")))
    lines.append("%s: %s" % (label["overall"], label["pass"] if document["ok"] else label["fail"]))
    return "\n".join(lines)


def _state_label(probe, label) -> str:
    if probe["symlink"]:
        return label["symlink"]
    if not probe["exists"]:
        return label["missing"]
    return label["writable"] if probe["writable"] else label["not_writable"]


# --- CLI --------------------------------------------------------------------

def add_parser(commands):
    command = commands.add_parser(
        "doctor", help="read-only health report: plugins, storage, model configuration")
    command.add_argument("--root", type=Path, default=None,
                         help="workspace directory to probe (default: current directory)")
    command.add_argument("--ping", action="store_true",
                         help="explicitly send one bounded model-discovery request to the "
                              "configured provider (the default report sends no request)")
    command.add_argument("--json", action="store_true", help="machine-readable output on stdout")


def execute(args) -> int:
    """``xueness doctor``; the plugin switch is enforced by the CLI host."""
    language = getattr(args, "language", None)
    try:
        document = report(args.state, root=getattr(args, "root", None),
                          ping=bool(getattr(args, "ping", False)))
    except (OSError, ValueError) as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return 1
    print(json.dumps(document, ensure_ascii=False, indent=2) if getattr(args, "json", False)
          else format_report(document, language))
    return 0 if document["ok"] else 1
