"""Shared HTTP adapter response marker and error envelope.

`python -m xueness.web` loads the server as ``__main__``. Feature adapters may
later import ``xueness.web`` by its canonical name. The handled-response marker
stays here so both server instances share one object identity.

Gateway failures use one JSON object. ``error`` is the message existing
clients already read. ``code`` is a stable token. ``status`` repeats the HTTP
status so a proxy that rewrites the status line cannot hide which failure it
was. The shape follows the reference server's rule that a failed call keeps
its real status and a JSON body (``packages/server/src/http.ts``): invalid
input is 400, refusal is 401/403, and an unavailable dependency is 503. A
failure is never answered as success.
"""

# `python -m xueness.web` loads the server as __main__. Feature adapters may
# subsequently import xueness.web by its canonical name. Keeping the marker in
# this module preserves its identity in both server instances.
HANDLED_RESPONSE = object()

_STATUS_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    408: "request_timeout",
    409: "conflict",
    411: "length_required",
    413: "payload_too_large",
    414: "uri_too_long",
    415: "unsupported_media_type",
    417: "expectation_failed",
    431: "request_header_fields_too_large",
    500: "internal_error",
    501: "not_implemented",
    503: "unavailable",
    505: "http_version_not_supported",
}


def error_payload(status, message, code=None, **extra):
    """Build the shared error object. ``extra`` cannot replace the envelope."""
    if not isinstance(message, str) or not message:
        message = "request failed"
    if not isinstance(code, str) or not code:
        code = _STATUS_CODES.get(int(status), "error")
    body = {"error": message, "code": code, "status": int(status)}
    for key, value in extra.items():
        if key not in body:
            body[key] = value
    return body


def normalize_error(status, payload):
    """Add the shared envelope without dropping fields the caller already set.

    An existing ``code``, ``errorCode``, or ``error_code`` stays the machine
    token. ``status`` in the body is the HTTP status, not a business field.
    """
    if not isinstance(payload, dict):
        return error_payload(status, "request failed")
    message = payload.get("error")
    if not isinstance(message, str) or not message:
        message = "request failed"
    code = payload.get("code")
    if not isinstance(code, str) or not code:
        code = None
        for key in ("errorCode", "error_code"):
            candidate = payload.get(key)
            if isinstance(candidate, str) and candidate:
                code = candidate
                break
    body = error_payload(status, message, code)
    for key, value in payload.items():
        if key not in body:
            body[key] = value
    return body
