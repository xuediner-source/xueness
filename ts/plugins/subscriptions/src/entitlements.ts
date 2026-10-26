/**
 * Optional-provider entitlement adapters (F13.03): a documented, public
 * account/subscription/quota/ticket contract any user-authorized entitlement
 * service can implement, plus an honest catalog of the vendor-private
 * interfaces that stay unreachable until external conditions exist.
 *
 * The client speaks real HTTP. Connectivity for the public contract is proven
 * against any implementation of it (tests run a real loopback service); the
 * private vendor items are listed as pending and are never claimed aligned.
 */
import { isDict, pySlice, pyStr, PyValueError } from "@xueness/contracts";
import { SubscriptionRequestError } from "./broker.ts";
import { publicQuota } from "./state.ts";

type Row = Record<string, unknown>;

/** Where each entitlement interface lives and whether it can be reached today. */
export interface EntitlementEndpoint {
  id: string;
  name: string;
  nameEn: string;
  /** Documented public endpoint; empty while the interface is pending. */
  baseUrl: string;
  auth: "user-token" | "oauth" | "account";
  status: "public" | "pending";
  pendingReason?: string;
  pendingReasonEn?: string;
}

/** The public contract's fixed paths; one shape every implementation speaks. */
export const ENTITLEMENT_PATHS = { account: "/entitlement/account", subscription: "/entitlement/subscription", quota: "/entitlement/quota", ticket: "/entitlement/tickets" } as const;

/**
 * The connectable surface: a user-authorized service implementing the public
 * contract above (any host the user configures). Vendor-private entitlement
 * interfaces follow as pending items — no public endpoint exists for them,
 * so they stay listed, not claimed.
 */
export const ENTITLEMENT_ENDPOINTS: readonly EntitlementEndpoint[] = [
  {
    id: "user-entitlement", name: "用户授权权益服务", nameEn: "User-authorized entitlement service",
    baseUrl: "", auth: "user-token", status: "public",
  },
  { id: "codex", name: "ChatGPT / Codex 权益接口", nameEn: "ChatGPT / Codex entitlement interface", baseUrl: "", auth: "oauth", status: "pending",
    pendingReason: "供应商未公开权益与票据接口，等待外部条件", pendingReasonEn: "The vendor publishes no entitlement or ticket interface; pending external conditions" },
  { id: "claude", name: "Claude 权益接口", nameEn: "Claude entitlement interface", baseUrl: "", auth: "oauth", status: "pending",
    pendingReason: "供应商未公开权益与票据接口，等待外部条件", pendingReasonEn: "The vendor publishes no entitlement or ticket interface; pending external conditions" },
  { id: "qwen", name: "Qwen Code 权益接口", nameEn: "Qwen Code entitlement interface", baseUrl: "", auth: "oauth", status: "pending",
    pendingReason: "模型接口可用，权益与票据接口未公开，等待外部条件", pendingReasonEn: "Model endpoints work; the entitlement and ticket interface is unpublished, pending external conditions" },
  { id: "commandcode", name: "Command Code Go 权益接口", nameEn: "Command Code Go entitlement interface", baseUrl: "", auth: "account", status: "pending",
    pendingReason: "本机 CLI 登录可用，权益与票据接口未公开，等待外部条件", pendingReasonEn: "Local CLI login works; the entitlement and ticket interface is unpublished, pending external conditions" },
  { id: "qoder", name: "Qoder 权益接口", nameEn: "Qoder entitlement interface", baseUrl: "", auth: "account", status: "pending",
    pendingReason: "账号授权可用，权益与票据接口未公开，等待外部条件", pendingReasonEn: "Account authorization works; the entitlement and ticket interface is unpublished, pending external conditions" },
];

export const entitlementEndpoint = (id: unknown): EntitlementEndpoint | null =>
  ENTITLEMENT_ENDPOINTS.find((endpoint) => endpoint.id === id && endpoint.status === "public") ?? null;

/** Private interfaces that remain unreachable; never presented as aligned. */
export function pendingExternalConditions(): Row[] {
  return ENTITLEMENT_ENDPOINTS.filter((endpoint) => endpoint.status === "pending").map((endpoint) => ({
    id: endpoint.id, name: endpoint.name, nameEn: endpoint.nameEn, auth: endpoint.auth,
    reason: endpoint.pendingReason ?? "", reasonEn: endpoint.pendingReasonEn ?? "", status: "pending",
  }));
}

/** A ticket issued by an entitlement service; sanitized before use. */
export interface EntitlementTicket {
  ticket: string;
  scope: string;
  /** Epoch milliseconds; null when the service issued no expiry. */
  expiresAt: number | null;
}

const HTTP_TIMEOUT_MS = 15_000;
const EXPIRY_SKEW_MS = 30_000;

export interface EntitlementClientOptions {
  /** Base URL of a service implementing the public contract (http/https). */
  base: string;
  /** The user's bearer token for that service. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

function cleanBase(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) throw new PyValueError("entitlement base URL must start with http:// or https://");
  return trimmed;
}

/** Map an entitlement response failure onto the shared error categories. */
function requestFailure(status: number): SubscriptionRequestError {
  const category = status === 401 || status === 403 ? "authentication_failed" : status === 404 ? "endpoint_not_found" : status === 429 ? "rate_limited" : status >= 500 ? "upstream_failure" : "request_rejected";
  return new SubscriptionRequestError(`entitlement service returned ${status}`, { category, status });
}

/** Real HTTP client for the public entitlement contract. */
export class EntitlementClient {
  readonly base: string;
  readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  readonly now: () => number;
  constructor(options: EntitlementClientOptions) {
    if (typeof options.base !== "string" || !options.base.trim()) throw new PyValueError("entitlement base URL is required");
    if (typeof options.token !== "string" || !options.token.trim()) throw new PyValueError("entitlement token is required");
    this.base = cleanBase(options.base);
    this.token = options.token.trim();
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  private async request(path: string, body?: Row): Promise<Row> {
    let response: Response;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      response = await this.fetcher(this.base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // Runtimes name abort differently; the signal itself is authoritative.
      if (signal.aborted) throw new SubscriptionRequestError("entitlement request timed out", { category: "timeout" });
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw new SubscriptionRequestError("entitlement request aborted", { category: "timeout" });
      throw new SubscriptionRequestError("entitlement service unreachable", { category: "connection_failed" });
    }
    if (!response.ok) { await response.arrayBuffer().catch(() => {}); throw requestFailure(response.status); }
    let value: unknown;
    try { value = await response.json(); } catch { throw new SubscriptionRequestError("entitlement response was not JSON", { category: "invalid_response" }); }
    if (!isDict(value)) throw new SubscriptionRequestError("entitlement response was not an object", { category: "invalid_response" });
    return value;
  }

  account(): Promise<Row> { return this.request(ENTITLEMENT_PATHS.account); }
  subscription(): Promise<Row> { return this.request(ENTITLEMENT_PATHS.subscription); }
  quota(): Promise<Row> { return this.request(ENTITLEMENT_PATHS.quota); }

  /** Issue a fresh ticket for `scope`; the service decides its lifetime. */
  async ticket(scope: string): Promise<EntitlementTicket> {
    const clean = pyStr(scope).trim();
    if (!clean || [...clean].length > 160) throw new PyValueError("invalid entitlement ticket scope");
    const value = await this.request(ENTITLEMENT_PATHS.ticket, { scope: clean });
    const ticket = value.ticket;
    if (typeof ticket !== "string" || !ticket.trim() || [...ticket].length > 4096) throw new SubscriptionRequestError("entitlement service issued no usable ticket", { category: "invalid_response" });
    const expiry = value.expiresAt;
    return { ticket: ticket.trim(), scope: clean, expiresAt: typeof expiry === "number" && Number.isFinite(expiry) && expiry >= 0 ? expiry : null };
  }
}

/** Cached ticket acquisition: one ticket per scope until shortly before expiry. */
export class EntitlementTickets {
  private readonly cache = new Map<string, EntitlementTicket>();
  private readonly now: () => number;
  /** In-flight acquisitions per scope: a ticket for one scope never serves another. */
  private readonly inFlight = new Map<string, Promise<EntitlementTicket>>();
  constructor(now: () => number = Date.now) { this.now = now; }

  private usable(cached: EntitlementTicket | undefined): boolean {
    return !!cached && (cached.expiresAt === null || cached.expiresAt - EXPIRY_SKEW_MS > this.now());
  }

  /** `acquire` is called only when no usable ticket is cached; shared in flight. */
  async get(scope: string, acquire: (scope: string) => Promise<EntitlementTicket>): Promise<EntitlementTicket> {
    const cached = this.cache.get(scope);
    if (this.usable(cached)) return cached!;
    let pending = this.inFlight.get(scope);
    if (pending === undefined) {
      // Keyed by scope: concurrent calls for different accounts never share one
      // issued ticket, so no request ever carries another account's entitlement.
      pending = acquire(scope).finally(() => { this.inFlight.delete(scope); });
      this.inFlight.set(scope, pending);
    }
    const fresh = await pending;
    if (fresh.scope !== scope) throw new PyValueError(`entitlement ticket was issued for another scope: ${fresh.scope}`);
    this.cache.set(scope, fresh);
    return fresh;
  }

  /** Drop cached tickets (plugin disabled, config changed). */
  clear(): void { this.cache.clear(); }
}

const bounded = (value: unknown, limit: number): string | null => typeof value === "string" && value.trim() ? pySlice(value.trim(), limit) : null;

/** Public account row: whitelisted fields only, bounded like `publicAccounts`; null when nothing survives. */
export function publicEntitlementAccount(value: unknown): Row | null {
  if (!isDict(value)) return null;
  const row: Row = {};
  const account = bounded(value.account, 160); if (account !== null) row.account = account;
  const plan = bounded(value.plan, 120); if (plan !== null) row.plan = plan;
  const region = bounded(value.region, 60); if (region !== null) row.region = region;
  if (value.verified === true) row.verified = true;
  return Object.keys(row).length ? row : null;
}

/** Public subscription row: status vocabulary is fixed, timestamps are epoch ms; null when nothing survives. */
export function publicEntitlementSubscription(value: unknown): Row | null {
  if (!isDict(value)) return null;
  const row: Row = {};
  if (["active", "trialing", "past_due", "expired", "unknown"].includes(value.status as string)) row.status = value.status;
  const plan = bounded(value.plan, 120); if (plan !== null) row.plan = plan;
  for (const key of ["renewsAt", "expiresAt", "startedAt"]) {
    const stamp = value[key];
    if (typeof stamp === "number" && Number.isFinite(stamp) && stamp >= 0) row[key] = stamp;
  }
  if (typeof value.seats === "number" && Number.isInteger(value.seats) && value.seats >= 0 && value.seats <= 1_000_000) row.seats = value.seats;
  return Object.keys(row).length ? row : null;
}

/** Public quota row reuses the subscription store's sanitizer. */
export function publicEntitlementQuota(value: unknown): Row | null { return publicQuota(value); }
