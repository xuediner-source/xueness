/**
 * Unified execution-mode capability announcement and degradation (F13.04).
 *
 * One contract answers, for any selectable model record: which execution
 * modes (runtime profiles) it supports, whether requests really carry an
 * entitlement ticket, why an interface is missing, and what a requested but
 * unsupported mode degrades to — the model keeps running either way.
 *
 * Pure data in, pure announcement out: callers pass the provider record plus
 * availability flags they own (the front door knows which optional plugins
 * are installed), so plugins never import each other.
 */

type Dict = Record<string, unknown>;

export type ExecutionMode = "standard" | "lightweight";
export const EXECUTION_MODES: readonly ExecutionMode[] = ["standard", "lightweight"];

export interface CapabilityReason {
  /** Stable machine code (`subscriptions.standard_only`); UIs and tests key on it. */
  code: string;
  detail: string;
}

export interface ModeAnnouncement {
  mode: ExecutionMode;
  /** Selectable for this record right now. */
  available: boolean;
  /** Requests on this mode really acquire and carry an entitlement ticket. */
  ticketPath: boolean;
  /** Every missing interface, each with its own explanation. */
  reasons: CapabilityReason[];
}

export interface FallbackNotice {
  from: ExecutionMode;
  to: ExecutionMode;
  reason: string;
}

export interface ExecutionAnnouncement {
  providerId: string;
  model: string;
  source: string;
  modes: ModeAnnouncement[];
  /** The mode the caller asked about, before degradation. */
  requested: ExecutionMode | null;
  /** The mode a run would actually use. */
  effective: ExecutionMode;
  /** Set when the request was answered by a fallback rather than the ask. */
  fallback: FallbackNotice | null;
  /** User-facing sentences explaining every missing interface. */
  notes: string[];
}

export interface CapabilityFlags {
  /** The subscriptions plugin is installed, enabled and its marketplace marker present. */
  subscriptionsAvailable?: boolean;
  /** A user-authorized entitlement service is configured for this account. */
  entitlementsConfigured?: boolean;
  /** Vendor interfaces known to be pending external conditions (ids only). */
  pendingEntitlements?: readonly string[];
}

const isMode = (value: unknown): value is ExecutionMode => value === "standard" || value === "lightweight";

function standardAnnouncement(): ModeAnnouncement {
  return { mode: "standard", available: true, ticketPath: false, reasons: [] };
}

/**
 * Account-backed records (`source: "subscription"`) resolve only on the
 * standard runtime — `resolveSubscription` and the WorkBuddy view both
 * reject anything else — so lightweight is announced unavailable with the
 * exact reason instead of failing a run later.
 */
function lightweightAnnouncement(record: Dict): ModeAnnouncement {
  if (record.source !== "subscription") return { mode: "lightweight", available: true, ticketPath: false, reasons: [] };
  return {
    mode: "lightweight", available: false, ticketPath: false,
    reasons: [{ code: "subscriptions.standard_only", detail: "subscription-backed models run on the standard runtime profile only" }],
  };
}

/**
 * The ticket path is real only when every condition holds: an account-backed
 * subscription record, the subscriptions plugin available, and a configured
 * user-authorized entitlement service. Anything else states its reason.
 */
function ticketPath(record: Dict, flags: CapabilityFlags): { ticketPath: boolean; reasons: CapabilityReason[] } {
  const subscription = record.source === "subscription";
  const workbuddy = subscription && record.subscriptionId === "workbuddy";
  const pending = (flags.pendingEntitlements ?? []).includes(String(record.subscriptionId ?? ""));
  if (!subscription) {
    return { ticketPath: false, reasons: [{ code: "entitlements.not_account_backed", detail: "saved provider profiles authenticate with their own API key; no entitlement ticket is involved" }] };
  }
  if (workbuddy) {
    return { ticketPath: false, reasons: [{ code: "workbuddy.pool_gateway", detail: "WorkBuddy pool models go through the local pool gateway, which has no ticket interface" }] };
  }
  if (!flags.subscriptionsAvailable) {
    return { ticketPath: false, reasons: [{ code: "subscriptions.unavailable", detail: "the subscriptions plugin is disabled or not installed from the marketplace" }] };
  }
  if (!flags.entitlementsConfigured) {
    return { ticketPath: false, reasons: pending
      ? [{ code: "entitlements.pending_external", detail: `the ${String(record.subscriptionId)} entitlement interface is pending external conditions and is not claimed as aligned` }]
      : [{ code: "entitlements.not_configured", detail: "no user-authorized entitlement service is configured for this account" }] };
  }
  return { ticketPath: true, reasons: [] };
}

/**
 * Announce the capability surface of one provider record. `requested` is the
 * mode the user asked about; the announcement reports what a run would
 * actually use and why, never inventing support.
 */
export function announceExecutionCapabilities(record: Dict, flags: CapabilityFlags = {}, requested: ExecutionMode | null = null): ExecutionAnnouncement {
  const ticket = ticketPath(record, flags);
  const modes: ModeAnnouncement[] = [standardAnnouncement(), lightweightAnnouncement(record)].map((mode) =>
    mode.mode === "standard" ? { ...mode, ticketPath: ticket.ticketPath, reasons: [...mode.reasons, ...ticket.reasons] } : mode,
  );
  const asked = isMode(requested) ? requested : null;
  const wanted = asked ?? "standard";
  const chosen = modes.find((mode) => mode.mode === wanted);
  const effective = chosen?.available ? wanted : "standard";
  const fallback: FallbackNotice | null = asked !== null && asked !== effective && chosen && !chosen.available
    ? { from: asked, to: effective, reason: chosen.reasons[0]?.detail ?? `${asked} is not available for this model` }
    : null;
  const notes: string[] = [];
  for (const mode of modes) for (const reason of mode.reasons) if (!notes.includes(reason.detail)) notes.push(reason.detail);
  if (fallback) notes.unshift(`the ${fallback.from} execution mode is unavailable here; runs continue on ${fallback.to}: ${fallback.reason}`);
  return {
    providerId: String(record.id ?? ""), model: String(record.model ?? ""), source: String(record.source ?? "saved"),
    modes, requested: asked, effective, fallback, notes,
  };
}

/**
 * Resolve a user selection against an announcement: keep the requested mode
 * when it is available, otherwise degrade to the announced effective mode so
 * the model still runs — the choice and its explanation travel together.
 */
export function degradeSelection(requested: unknown, announcement: ExecutionAnnouncement): { effective: ExecutionMode; fallback: FallbackNotice | null } {
  if (!isMode(requested)) return { effective: announcement.effective, fallback: announcement.fallback };
  if (requested === announcement.effective) return { effective: announcement.effective, fallback: announcement.fallback };
  const mode = announcement.modes.find((entry) => entry.mode === requested);
  if (mode?.available) return { effective: requested, fallback: null };
  return {
    effective: announcement.effective,
    fallback: { from: requested, to: announcement.effective, reason: mode?.reasons[0]?.detail ?? `${requested} is not available for this model` },
  };
}

/** Rows for a settings surface: one per mode, reasons flattened for display. */
export function capabilityRows(announcement: ExecutionAnnouncement): Dict[] {
  return announcement.modes.map((mode) => ({
    mode: mode.mode, available: mode.available, ticketPath: mode.ticketPath,
    reasons: mode.reasons.map((reason) => ({ code: reason.code, detail: reason.detail })),
  }));
}
