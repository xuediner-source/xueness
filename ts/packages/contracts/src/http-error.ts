/**
 * Shared HTTP error envelope, ported from `xueness/http_contract.py`.
 *
 * Every gateway failure is one JSON object: `error` (message existing clients
 * read), `code` (stable token) and `status` (repeats the HTTP status so a
 * proxy rewriting the status line cannot hide the failure).
 */

export const STATUS_CODES: Readonly<Record<number, string>> = Object.freeze({
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
});

export interface ErrorEnvelope {
  error: string;
  code: string;
  status: number;
  [extra: string]: unknown;
}

/** Build the shared error object. `extra` cannot replace the envelope. */
export function errorPayload(status: number, message: unknown, code?: unknown, extra: Record<string, unknown> = {}): ErrorEnvelope {
  const httpStatus = Math.trunc(status);
  const body: ErrorEnvelope = {
    error: typeof message === "string" && message ? message : "request failed",
    code: typeof code === "string" && code ? code : STATUS_CODES[httpStatus] ?? "error",
    status: httpStatus,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (!Object.hasOwn(body, key)) body[key] = value;
  }
  return body;
}

/** Add the envelope without dropping fields the caller already set. */
export function normalizeError(status: number, payload: unknown): ErrorEnvelope {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return errorPayload(status, "request failed");
  }
  const fields = payload as Record<string, unknown>;
  let code: unknown = fields.code;
  if (typeof code !== "string" || !code) {
    code = ["errorCode", "error_code"].map((key) => fields[key]).find((value) => typeof value === "string" && value);
  }
  const body = errorPayload(status, fields.error, code);
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(body, key)) body[key] = value;
  }
  return body;
}

/** Fixed protocol error phrases. They never echo the request line. */
export const PROTOCOL_ERRORS: Readonly<Record<number, readonly [string, string]>> = Object.freeze({
  400: ["bad_request", "bad request"],
  408: ["request_timeout", "request timed out"],
  411: ["length_required", "Content-Length is required"],
  413: ["payload_too_large", "request body is too large"],
  414: ["uri_too_long", "request uri too long"],
  417: ["expectation_failed", "Expect is not supported"],
  431: ["request_header_fields_too_large", "request headers are too large"],
  500: ["internal_error", "internal error"],
  501: ["not_implemented", "method not implemented"],
  505: ["http_version_not_supported", "http version not supported"],
});

/** Request body limits, matching `Handler._body_limit`. */
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_COMPOSER_BODY_BYTES = 6_000_000;

export function bodyLimitFor(pathname: string): number {
  return pathname === "/api/composer/prepare" ? MAX_COMPOSER_BODY_BYTES : MAX_BODY_BYTES;
}
