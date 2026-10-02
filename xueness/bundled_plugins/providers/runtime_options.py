"""Validation and request payload construction for provider runtime profiles.

This module keeps the saved-profile contract separate from the HTTP adapters so
both normal calls and connection checks send the same compatible payload.
"""

RUNTIME_PROFILES = frozenset({"standard", "lightweight"})
TOOL_CALLING_MODES = frozenset({"native", "json"})
MAX_TOKENS_FIELDS = frozenset({"max_tokens", "max_completion_tokens"})
COMPATIBILITY_KEYS = frozenset({
    "streamUsage", "parallelToolCalls", "maxTokensField", "toolChoice", "think",
})
from .lightweight_config import validate_options, effective_options

LIGHTWEIGHT_CONTEXT_WINDOW = 8192
LIGHTWEIGHT_MAX_OUTPUT_TOKENS = 1024
MIN_CONTEXT_WINDOW = 2048
MAX_CONTEXT_WINDOW = 262144
MIN_MAX_OUTPUT_TOKENS = 128
MAX_MAX_OUTPUT_TOKENS = 32768


def _bounded_integer(value, field, minimum, maximum):
    # bool is an int subclass in Python. Treating True as a one-token limit is
    # surprising and would make JSON schema validation inconsistent.
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{field} must be an integer from {minimum} to {maximum}")
    return value


def validate_compatibility(value):
    """Return a fresh compatibility mapping or reject unknown/invalid values."""
    if not isinstance(value, dict):
        raise ValueError("compatibility must be an object")
    unknown = set(value) - COMPATIBILITY_KEYS
    if unknown:
        raise ValueError("compatibility contains an unsupported option")
    clean = {}
    for key in ("streamUsage", "parallelToolCalls"):
        if key in value:
            if not isinstance(value[key], bool):
                raise ValueError(f"compatibility.{key} must be a boolean")
            clean[key] = value[key]
    if "maxTokensField" in value:
        if (not isinstance(value["maxTokensField"], str)
                or value["maxTokensField"] not in MAX_TOKENS_FIELDS):
            raise ValueError("compatibility.maxTokensField is unsupported")
        clean["maxTokensField"] = value["maxTokensField"]
    if "toolChoice" in value:
        if value["toolChoice"] not in ("auto", "required"):
            raise ValueError("compatibility.toolChoice must be auto or required")
        clean["toolChoice"] = value["toolChoice"]
    if "think" in value:
        if not isinstance(value["think"], bool):
            raise ValueError("compatibility.think must be a boolean")
        clean["think"] = value["think"]
    return clean


def resolve_runtime_options(record, protocol="openai"):
    """Validate stored metadata and return runtime values with profile defaults.

    Standard profiles without token limits return ``None`` for those limits,
    which preserves the historic request body. Lightweight profiles receive
    their local-model defaults.
    """
    if not isinstance(record, dict):
        raise ValueError("provider profile must be an object")
    profile = record.get("runtimeProfile", "standard")
    if not isinstance(profile, str) or profile not in RUNTIME_PROFILES:
        raise ValueError("runtimeProfile must be standard or lightweight")

    if "contextWindow" in record:
        context_window = _bounded_integer(
            record["contextWindow"], "contextWindow", MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)
    else:
        context_window = LIGHTWEIGHT_CONTEXT_WINDOW if profile == "lightweight" else None

    if "maxOutputTokens" in record:
        max_output_tokens = _bounded_integer(
            record["maxOutputTokens"], "maxOutputTokens",
            MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS)
    else:
        max_output_tokens = (min(LIGHTWEIGHT_MAX_OUTPUT_TOKENS, context_window // 4)
                             if profile == "lightweight" else None)

    if (max_output_tokens is not None and context_window is not None
            and max_output_tokens > context_window // 2):
        raise ValueError("maxOutputTokens must be no greater than half of contextWindow")

    tool_calling = record.get("toolCalling", "native")
    if not isinstance(tool_calling, str) or tool_calling not in TOOL_CALLING_MODES:
        raise ValueError("toolCalling must be native or json")
    if tool_calling == "json" and (protocol != "openai" or profile != "lightweight"):
        raise ValueError("toolCalling=json requires an OpenAI-compatible lightweight profile")

    compatibility = validate_compatibility(record.get("compatibility", {}))
    if protocol != "openai" and compatibility:
        raise ValueError("compatibility options are supported only for OpenAI-compatible providers")

    lightweight_options = validate_options(record.get('lightweightOptions', {}), protocol)
    if profile == 'lightweight':
        effective_options(value=lightweight_options, context=context_window, output=max_output_tokens)

    return {
        "runtime_profile": profile,
        "context_window": context_window,
        "max_output_tokens": max_output_tokens,
        "tool_calling": tool_calling,
        "compatibility": compatibility,
        "lightweight_options": lightweight_options,
    }


def public_runtime_options(record):
    """Whitelist new metadata while preserving the legacy default response shape."""
    options = resolve_runtime_options(record, record.get("protocol", "openai"))
    result = {}
    profile = options["runtime_profile"]
    # A lightweight profile is itself an explicit, non-default selection. Its
    # effective token defaults are included so clients can edit the profile.
    if "runtimeProfile" in record or profile != "standard":
        result["runtimeProfile"] = profile
    if "contextWindow" in record or profile == "lightweight":
        result["contextWindow"] = options["context_window"]
    if "maxOutputTokens" in record or profile == "lightweight":
        result["maxOutputTokens"] = options["max_output_tokens"]
    if "toolCalling" in record or options["tool_calling"] != "native":
        result["toolCalling"] = options["tool_calling"]
    if "compatibility" in record or options["compatibility"]:
        result["compatibility"] = dict(options["compatibility"])
    if 'lightweightOptions' in record:
        result['lightweightOptions'] = dict(options['lightweight_options'])
    return result


def _default_max_tokens_field(model, runtime_profile, compatibility, fallback):
    if "maxTokensField" in compatibility:
        return compatibility["maxTokensField"]
    if runtime_profile == "lightweight":
        return "max_tokens"
    return fallback


def build_openai_payload(
    *, model, messages, tools, runtime_profile="standard", context_window=None,
    max_output_tokens=None, tool_calling="native", compatibility=None,
    stream=False, reasoning_effort=None, test_connection=False,
    default_max_tokens_field="max_tokens", lightweight_options=None,
    test_max_tokens=8,
):
    """Build one OpenAI-compatible payload for inference or connection tests.

    ``tools`` and parallel-tool fields are completely omitted in JSON tool mode;
    its caller owns conversion of tool instructions into the messages.
    """
    compatibility = validate_compatibility({} if compatibility is None else compatibility)
    if not isinstance(runtime_profile, str) or runtime_profile not in RUNTIME_PROFILES:
        raise ValueError("runtimeProfile must be standard or lightweight")
    if not isinstance(tool_calling, str) or tool_calling not in TOOL_CALLING_MODES:
        if tool_calling != "plain":
            raise ValueError("toolCalling must be native, json or plain")
    if tool_calling == "json" and runtime_profile != "lightweight":
        raise ValueError("toolCalling=json requires a lightweight profile")
    if (isinstance(test_max_tokens, bool) or not isinstance(test_max_tokens, int)
            or not 1 <= test_max_tokens <= 128):
        raise ValueError("test_max_tokens must be an integer from 1 to 128")

    if context_window is not None:
        context_window = _bounded_integer(
            context_window, "contextWindow", MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)
    if max_output_tokens is None and runtime_profile == "lightweight":
        effective_context_window = context_window or LIGHTWEIGHT_CONTEXT_WINDOW
        max_output_tokens = min(LIGHTWEIGHT_MAX_OUTPUT_TOKENS, effective_context_window // 4)
    if max_output_tokens is not None:
        max_output_tokens = _bounded_integer(
            max_output_tokens, "maxOutputTokens",
            MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS)
    if (max_output_tokens is not None and context_window is not None
            and max_output_tokens > context_window // 2):
        raise ValueError("maxOutputTokens must be no greater than half of contextWindow")

    body = {"model": model, "messages": messages}
    if tool_calling == "native":
        body["tools"] = tools

    if stream:
        body["stream"] = True
        include_usage = compatibility.get(
            "streamUsage", runtime_profile == "standard")
        if include_usage:
            body["stream_options"] = {"include_usage": True}

    if tool_calling == "native":
        if "parallelToolCalls" in compatibility:
            body["parallel_tool_calls"] = compatibility["parallelToolCalls"]
        if "toolChoice" in compatibility:
            body["tool_choice"] = compatibility["toolChoice"]
    if "think" in compatibility:
        body["think"] = compatibility["think"]

    token_field = _default_max_tokens_field(
        model, runtime_profile, compatibility, default_max_tokens_field)
    token_limit = None
    if test_connection:
        # Keep the connection probe small regardless of a profile's larger cap.
        token_limit = (min(test_max_tokens, max_output_tokens)
                       if max_output_tokens is not None else test_max_tokens)
    elif max_output_tokens is not None:
        token_limit = max_output_tokens
    if token_limit is not None:
        body[token_field] = token_limit

    if reasoning_effort is not None and "think" not in compatibility:
        body["reasoning_effort"] = reasoning_effort
    options = validate_options({} if lightweight_options is None else lightweight_options)
    if runtime_profile == 'lightweight' and not test_connection:
        for key, field in (('temperature', 'temperature'), ('topP', 'top_p'), ('seed', 'seed')):
            if key in options:
                body[field] = options[key]
    return body
