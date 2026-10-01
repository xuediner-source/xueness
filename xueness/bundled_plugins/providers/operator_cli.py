"""CLI commands owned by the providers plugin."""
import argparse
import json
import os

from . import providers_api


def _reject_json_constant(value):
    raise ValueError("non-finite JSON number: " + value)


def _json_object(value):
    try:
        parsed = json.loads(value, parse_constant=_reject_json_constant)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("expected a JSON object with finite numbers") from None
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("expected a JSON object")
    return parsed


def add_parsers(commands):
    provider = commands.add_parser(
        "providers", help="manage saved model profiles; keys are never printed")
    sub = provider.add_subparsers(dest="action", required=True)
    sub.add_parser("list")

    save = sub.add_parser("save")
    save.add_argument("id")
    save.add_argument("--name")
    save.add_argument("--base-url", required=True)
    save.add_argument("--model", required=True)
    save.add_argument("--protocol", choices=("openai", "anthropic"), default=None,
                      help="messages protocol; defaults to the existing profile or OpenAI-compatible")
    save.add_argument("--capabilities", default=None, metavar="LIST",
                      help="optional comma-separated model input capabilities: image,pdf,video")
    save.add_argument("--reasoning-levels", default=None, metavar="LIST",
                      help="optional comma-separated OpenAI reasoning levels: none,minimal,low,medium,high,xhigh")
    save.add_argument("--runtime-profile", choices=("standard", "lightweight"), default=None,
                      help="runtime resource profile; lightweight is intended for local/small models")
    save.add_argument("--context-window", type=int, default=None,
                      help="model context window in tokens (2048..262144)")
    save.add_argument("--max-output-tokens", type=int, default=None,
                      help="maximum generated tokens (128..32768, at most half the context window)")
    save.add_argument("--tool-calling", choices=("native", "json"), default=None,
                      help="native API tools or lightweight JSON tool protocol")
    save.add_argument("--lightweight-options", type=_json_object, default=None, metavar="JSON",
                      help="complete lightweight settings object; replaces prior values, use '{}' to clear")
    save.add_argument("--no-stream-usage", action="store_true",
                      help="omit stream_options.include_usage for compatibility")
    save.add_argument("--key-env", help="environment variable holding the API key; omit to keep existing key")

    discover = sub.add_parser(
        "discover", help="explicitly list model IDs exposed by a saved OpenAI-compatible profile")
    discover.add_argument("id")


def execute(args):
    """Run a provider profile command; discovery is explicit and read-only."""
    if args.action == "list":
        status, result = providers_api.dispatch(
            "GET", ["api", "providers"], {}, {}, {"state_dir": args.state})
    elif args.action == "save":
        data = {
            "id": args.id,
            "name": args.name or args.id,
            "baseUrl": args.base_url,
            "model": args.model,
        }
        if args.protocol:
            data["protocol"] = args.protocol
        if args.capabilities is not None:
            data["capabilities"] = [value.strip() for value in args.capabilities.split(",") if value.strip()]
        if args.reasoning_levels is not None:
            data["reasoningLevels"] = [value.strip() for value in args.reasoning_levels.split(",") if value.strip()]
        if args.runtime_profile is not None:
            data["runtimeProfile"] = args.runtime_profile
        if args.context_window is not None:
            data["contextWindow"] = args.context_window
        if args.max_output_tokens is not None:
            data["maxOutputTokens"] = args.max_output_tokens
        if args.tool_calling is not None:
            data["toolCalling"] = args.tool_calling
        if args.lightweight_options is not None:
            data["lightweightOptions"] = args.lightweight_options
        if args.no_stream_usage:
            data["compatibility"] = {"streamUsage": False}
        if args.key_env:
            if not os.environ.get(args.key_env):
                raise ValueError("key environment variable is empty")
            data["apiKey"] = os.environ[args.key_env]
        status, result = providers_api.dispatch(
            "POST", ["api", "providers"], {}, data, {"state_dir": args.state})
    elif args.action == "discover":
        # The command itself is the operator's explicit opt-in to a bounded
        # GET /models request. Web requests continue to use the server gate.
        status, result = providers_api.dispatch(
            "POST", ["api", "providers", "discover"], {}, {"id": args.id},
            {"state_dir": args.state, "allow_real": True})
    else:
        raise ValueError("unknown provider command")

    if status != 200:
        raise ValueError(result["error"])
    return result
