/**
 * Execution-selection and request-authentication ports (F13.01): the narrow
 * execution context a request carries — its selection dependency, per-request
 * credentials with refresh, and same-provider fallback — as host-bindable
 * ports over the saved profile registry.
 *
 * No official account is ever baked in: the production port resolves
 * credentials from the host's profile store (or the process environment for
 * the default selection) at request time and fails before any network I/O
 * when they are absent. A locally registered mock port runs the same
 * production path through `executionRequestDependency`, and the off-peak
 * ticket rides along as one more composed header port (F13.02).
 */
import { PyValueError } from "@xueness/contracts";
import type { ExecutionModelScope, SelectionFallbackDeclaration } from "@xueness/agent";
import { providerExecutionModelScope, type ExecutionSelectionInput } from "./execution-selection.ts";
import { CONFIGURATION_GUIDANCE } from "./provider-config.ts";
import type { Dict, ProfileStore } from "./profile-store.ts";

// ------------------------------------------------------------------- the ports

/** What one request authenticates as: narrow execution context, never a second model config. */
export type RequestAuthPurpose = "interactive" | "off_peak" | "auxiliary";

export interface RequestAuthInput {
  providerId: string | null;
  modelId: string | null;
  purpose: RequestAuthPurpose;
}

/** The credential headers one request carries; the key never leaves this binding. */
export interface RequestAuthBinding { headers: Record<string, string> }

/** The provider-side facts of one failed request, as failure classification reports them. */
export interface RequestAuthFailure { statusCode?: number; providerErrorCode?: string }

export interface RequestAuthPort {
  readonly id: string;
  /**
   * Dynamic per-request credentials. Must fail (throw) before any network I/O
   * when they are absent; a successful binding is the only thing that may
   * reach the wire.
   */
  resolve(input: RequestAuthInput): RequestAuthBinding;
  /** Credential refresh after an authentication failure; absent when this port cannot refresh. */
  refresh?(input: RequestAuthInput, failure: RequestAuthFailure): RequestAuthBinding;
}

// -------------------------------------------------------------- host binding

/**
 * The host-private port binding (the Registry-backed resolver seam): the host
 * registers one port per state directory; production code resolves through
 * the binding and never through a hardcoded account.
 */
let boundPort: RequestAuthPort | null = null;

export function bindRequestAuthPort(port: RequestAuthPort | null): void { boundPort = port; }

export function boundRequestAuthPort(): RequestAuthPort | null { return boundPort; }

// ------------------------------------------------------------ saved profiles

/** The credential header one protocol carries; framing stays with the adapter. */
function credentialHeaders(protocol: string, key: string): Record<string, string> {
  return protocol === "anthropic" ? { "x-api-key": key } : { Authorization: `Bearer ${key}` };
}

function envCredentials(input: RequestAuthInput): RequestAuthBinding {
  const protocol = (process.env.XUENESS_PROVIDER ?? "").trim().toLowerCase();
  if (protocol === "anthropic") {
    const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
    if (key) return { headers: credentialHeaders("anthropic", key) };
  } else {
    const key = (process.env.XUENESS_API_KEY ?? "").trim();
    if (key) return { headers: credentialHeaders("openai", key) };
  }
  throw new PyValueError(`no credentials configured for the default selection. ${CONFIGURATION_GUIDANCE}`);
}

/**
 * The production port: credentials read from the saved profile registry at
 * request time, so a rotated key is picked up without rebuilding anything.
 * There is no default and no official account to fall back to — an empty
 * store and an empty environment fail before network I/O.
 */
export function savedProfileRequestAuth(store: ProfileStore): RequestAuthPort {
  const resolve = (input: RequestAuthInput): RequestAuthBinding => {
    if (input.providerId === null) return envCredentials(input);
    const record: Dict | null = store.read(input.providerId);
    if (record === null) throw new PyValueError(`provider profile not found: ${input.providerId}`);
    const key = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
    if (!key) throw new PyValueError(`provider profile has no credentials: ${input.providerId}`);
    return { headers: credentialHeaders(String(record.protocol ?? "openai"), key) };
  };
  return {
    id: "saved-profile",
    resolve,
    // A refresh re-reads the registry: the credential may have been rotated
    // since the request that just failed was signed.
    refresh: resolve,
  };
}

// ----------------------------------------------------------- refresh policy

/** Whether one reported failure is an authentication failure a refresh could cure. */
export function isAuthFailure(failure: RequestAuthFailure): boolean {
  if (failure.statusCode === 401 || failure.statusCode === 403) return true;
  const code = failure.providerErrorCode;
  // Prefix match: providers suffix their codes (`invalid_api_key`, `authentication_error`).
  return typeof code === "string" && /^(?:invalid(?:ated)?[_-]?(?:api[_-]?)?key|api[_-]?key[_-]?(?:expired|invalid)|authentication|unauthorized|token[_-]?(?:expired|invalid))/i.test(code.trim());
}

/**
 * Restricts a port's refresh to authentication failures: transport errors,
 * rate limits and business codes keep their own routes (F01 classification),
 * and only a curable credential failure re-signs the request.
 */
export function withCredentialRefresh(port: RequestAuthPort): RequestAuthPort {
  return {
    id: `${port.id}+refresh`,
    resolve: (input) => port.resolve(input),
    ...(port.refresh ? {
      refresh: (input: RequestAuthInput, failure: RequestAuthFailure): RequestAuthBinding => {
        if (!isAuthFailure(failure)) throw new PyValueError("credential refresh applies only to authentication failures");
        return port.refresh!(input, failure);
      },
    } : {}),
  };
}

// ------------------------------------------------------------- composition

/**
 * One resolver over several ports (the off-peak shape: credentials plus the
 * ticket header). `resolve` merges headers in declaration order — a later
 * port may override a header — and fails as a whole before any network I/O.
 * `refresh` refreshes every refreshable port and re-resolves the rest; with
 * no refreshable port there is no refresh.
 */
export function composeRequestAuth(ports: readonly RequestAuthPort[]): RequestAuthPort {
  if (ports.length === 0) throw new PyValueError("a composed request-auth port needs at least one port");
  const refreshable = ports.filter((port) => typeof port.refresh === "function");
  return {
    id: ports.map((port) => port.id).join("+"),
    resolve: (input) => {
      const headers: Record<string, string> = {};
      for (const port of ports) Object.assign(headers, port.resolve(input).headers);
      return { headers };
    },
    ...(refreshable.length ? {
      refresh: (input: RequestAuthInput, failure: RequestAuthFailure): RequestAuthBinding => {
        const headers: Record<string, string> = {};
        for (const port of ports) {
          const binding = typeof port.refresh === "function" ? port.refresh(input, failure) : port.resolve(input);
          Object.assign(headers, binding.headers);
        }
        return { headers };
      },
    } : {}),
  };
}

// ------------------------------------------------------- same-provider route

export interface SameProviderFallbackInput {
  /** The provider whose failure the rules watch — the same provider the target lives on. */
  providerId: string;
  /** The provider's other model the run continues on. */
  model: string;
  reason: string;
  providerErrorCode?: string;
}

/**
 * A same-provider fallback declaration for the F01 route: the target keeps
 * the declared provider and swaps in its other model, so the runtime's
 * fallback candidates admit it (`sameProvider: true`) while an identical
 * selection still never repeats.
 */
export function sameProviderFallback(input: SameProviderFallbackInput): SelectionFallbackDeclaration {
  const providerId = input.providerId?.trim();
  const model = input.model?.trim();
  const reason = input.reason?.trim();
  if (!providerId || !model) throw new PyValueError("a same-provider fallback needs a provider and a model");
  if (!reason) throw new PyValueError("a same-provider fallback needs a reason");
  return {
    providerId,
    rules: [{ reason, ...(input.providerErrorCode ? { providerErrorCode: input.providerErrorCode } : {}) }],
    target: { providerId, modelId: model },
    sameProvider: true,
  };
}

// ------------------------------------------------------- request dependency

export interface ExecutionDependencyInput extends ExecutionSelectionInput {
  /** Explicit authentication port; defaults to the host binding, then the saved profiles. */
  auth?: RequestAuthPort;
  /** Extra header ports composed into every request, e.g. an off-peak ticket. */
  authExtras?: readonly RequestAuthPort[];
}

/** What one request depends on: its execution selection scope and its request authentication. */
export interface ExecutionRequestDependency {
  readonly scope: ExecutionModelScope;
  readonly auth: RequestAuthPort;
}

/**
 * Binds one request's execution dependency: the selection scope (the F01
 * route, unchanged) plus the request-auth port it authenticates through. The
 * same production path serves saved profiles, a host-bound port and a local
 * mock — the difference is only which port is bound.
 */
export function executionRequestDependency(store: ProfileStore, input: ExecutionDependencyInput): ExecutionRequestDependency {
  const scope = providerExecutionModelScope(store, input);
  const base = input.auth ?? boundRequestAuthPort() ?? savedProfileRequestAuth(store);
  const extras = input.authExtras ?? [];
  const auth = extras.length > 0 ? composeRequestAuth([base, ...extras]) : base;
  return { scope, auth };
}
