// Small protocol compatibility layer for the MIT transports in vendor/.
// This file has no model requests, host tool execution or downloaded modules.
import { join } from 'node:path';
export class LlmAdapter {}
export class LlmError extends Error {
  constructor(message, code = 'SERVER', options) {
    super(message, options); this.code = code;
    if (Number.isInteger(options?.status) && options.status >= 100 && options.status <= 599) this.status = options.status;
    if (Number.isFinite(options?.providerRetryAfterMs) && options.providerRetryAfterMs >= 0) this.providerRetryAfterMs = options.providerRetryAfterMs;
  }
}
export const ToolCallId = String, ReasoningEffortId = String;
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED';
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE', QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';
export const attributionHeaders = () => ({});
export const errorChain = error => error?.code || error?.name || 'provider error';
export const isContextWindowExceededError = error => /context.{0,20}(exceed|length|window)|too many tokens/i.test(String(error?.message ?? error));
const QUOTA_ERROR_CODES = new Set(['AccountQuotaExceeded', QUOTA_EXCEEDED_CODE, 'insufficient_quota']);
export function isQuotaExceededError(error) {
  if (typeof error === 'string') {
    try { return isQuotaExceededError(JSON.parse(error)); }
    catch { return false; }
  }
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const details = error.error && typeof error.error === 'object' ? error.error : error;
  return [details.code, details.type].some(code => typeof code === 'string' && QUOTA_ERROR_CODES.has(code));
}
export const resolveRetryPolicy = () => ({ maxRetries: 0 });
export function dshHomePath(...parts) {
  if (!process.env.XUENESS_SUBSCRIPTIONS_STORE) throw new Error('Subscription store is not bound');
  return join(process.env.XUENESS_SUBSCRIPTIONS_STORE, ...parts);
}
