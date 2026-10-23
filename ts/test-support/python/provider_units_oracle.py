"""Evaluate pure provider helpers on a JSON corpus: {family: [input, ...]}.

Each outcome is {"ok": value} or {"err": [exception type name, message]}.
"""
import base64
import json
import sys
import urllib.parse

from xueness.bundled_plugins.providers import lightweight_config as L
from xueness.bundled_plugins.providers import provider as P
from xueness.bundled_plugins.providers import runtime_options as R
from xueness.bundled_plugins.providers import tool_protocol as T


def url_fields(text):
    url = urllib.parse.urlparse(text)
    return {"scheme": url.scheme, "username": url.username, "password": url.password,
            "query": url.query, "fragment": url.fragment, "hostname": url.hostname}


FAMILIES = {
    "b64": lambda s: base64.b64decode(s, validate=True).hex(),
    "retry": lambda raw: P._retry_after({"Retry-After": raw} if raw is not None else {}),
    "urls": url_fields,
    "loopback": P._is_loopback_literal,
    "lw_options": lambda item: L.validate_options(item[0], item[1]),
    "effective": lambda item: L.effective_options(value=item["value"], context=item.get("context"),
                                                  output=item.get("output")),
    "compat": R.validate_compatibility,
    "runtime": lambda item: R.resolve_runtime_options(item[0], item[1]),
    "native": lambda item: T.normalize_native(item[0], used_ids=item[1]),
    "envelope": T.envelope_text,
    "strict_json": T.strict_json,
    "usage": lambda item: P._with_reported_usage(item[0], item[1]),
}


def evaluate(family, value):
    try:
        return {"ok": FAMILIES[family](value)}
    except Exception as exc:  # the oracle reports every failure shape
        return {"err": [type(exc).__name__, str(exc)]}


corpus = json.loads(sys.stdin.read())
result = {family: [evaluate(family, value) for value in values] for family, values in corpus.items()}
sys.stdout.write(json.dumps(result, ensure_ascii=True, default=repr))
