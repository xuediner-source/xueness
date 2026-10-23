/**
 * Provider business codes, ported from ZCode
 * `adapters/model/failure-provider-business-codes.ts`.
 *
 * Only the bounded `code` / `type` token of an error body is consulted
 * (`ProviderRequestError.providerCode`); provider messages never are.
 */
export type BusinessCodeKind = "server" | "auth_refresh" | "rejected" | "model_not_found" | "invalid_request" | "invalid_auth"
  | "rate_limited_terminal" | "rate_limited" | "overloaded" | "network" | "context" | "terminal";

const TABLE: Record<string, BusinessCodeKind> = {
  // ZCode's explicit entries (Z.AI / BigModel and gateway codes).
  "500": "server", "1006": "auth_refresh", "1005": "rejected", "3006": "model_not_found", "3001": "invalid_request",
  "3007": "invalid_auth", "3008": "rate_limited_terminal", "3009": "rate_limited_terminal", "3010": "rate_limited_terminal",
  "1120": "server", "1230": "server", "1234": "network", "1261": "context", "1113": "terminal",
  "1302": "rate_limited", "1303": "rate_limited", "1305": "rate_limited", "1304": "rate_limited_terminal",
  "1308": "rate_limited_terminal", "1309": "terminal", "1310": "rate_limited_terminal", "1311": "terminal",
  "1312": "overloaded", "1313": "rate_limited_terminal", "3002": "rate_limited", "2007": "server",
  // Long-term quota, plan and spend limits: the user must top up or wait for a reset.
  insufficient_quota: "rate_limited_terminal", credit_balance_exhausted: "rate_limited_terminal",
  organization_spend_limit_exceeded: "rate_limited_terminal", project_spend_limit_exceeded: "rate_limited_terminal",
  organization_usage_limit_exceeded: "rate_limited_terminal", exceeded_current_quota_error: "rate_limited_terminal",
  "2056": "rate_limited_terminal", "20097": "rate_limited_terminal", "1316": "rate_limited_terminal",
  "1317": "rate_limited_terminal", "1318": "rate_limited_terminal", "1319": "rate_limited_terminal",
  "1320": "rate_limited_terminal", "1321": "rate_limited_terminal",
  "1008": "terminal", "1314": "terminal", "1315": "terminal",
  rate_limit_reached_error: "rate_limited", rate_limit_error: "rate_limited",
  engine_overloaded_error: "overloaded", overloaded_error: "overloaded",
  // Xueness' own quota markers (transport.ts QUOTA_ERROR_CODES) are terminal as well.
  AccountQuotaExceeded: "rate_limited_terminal", QUOTA_EXCEEDED: "rate_limited_terminal",
};

const CONTEXT_CODES = new Set(["context_length_exceeded", "context_window_exceeded", "model_context_exceeded", "model_context_window_exceeded", "prompt_too_long"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/** A bounded, content-free code token: what an error body may contribute. */
export function sanitizeProviderCode(value: unknown): string | null {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : value;
  return typeof text === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : null;
}

/** `getProviderBusinessCodeMapping` plus ZCode's network / context code checks. */
export function businessCodeKind(code: string | null | undefined): BusinessCodeKind | null {
  if (!code) return null;
  if (Object.hasOwn(TABLE, code)) return TABLE[code] as BusinessCodeKind;
  if (CONTEXT_CODES.has(code.toLowerCase())) return "context";
  const upper = code.toUpperCase();
  if (NETWORK_CODES.has(upper) || upper === "NETWORK_ERROR" || upper === "NETWORK_ERROR_RETRYABLE") return "network";
  return null;
}

/** `isNetworkFailure` (failure-inspection.ts). */
export function isNetworkCode(code: string | null | undefined): boolean {
  return typeof code === "string" && NETWORK_CODES.has(code.toUpperCase());
}

/** `isTlsFailure` (failure-tls.ts). */
export function isTlsCode(code: string | null | undefined): boolean {
  const upper = typeof code === "string" ? code.toUpperCase() : "";
  return upper.includes("CERT") || upper.includes("TLS") || upper === "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
}

/** `isProxyFailure` (failure-inspection.ts). */
export function isProxyCode(code: string | null | undefined): boolean {
  return typeof code === "string" && code.toUpperCase().includes("PROXY");
}
