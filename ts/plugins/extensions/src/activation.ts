/**
 * Activating an imported package: its declarative text contributions become
 * ordinary resources of the plugins that own those kinds.
 *
 * A skill becomes a skill resource, a prompt template a command resource
 * and a hook a hook resource, written through the owning plugin's own handler, so each one
 * works only while that plugin is effective and is listed, edited, switched
 * off and gated exactly like a resource the person created by hand. Every
 * resource written here carries `sourcePackage`; activation never overwrites
 * a resource without that tag, and deactivation removes only tagged ones.
 *
 * Importing is not activating: nothing is written until the person asks.
 * A hook names a command to run, so activating one only registers it,
 * switched off; the person reads the command on the hooks page and enables
 * each hook there. Tools and verifier commands are never contributions.
 */
import { isDict } from "@xueness/contracts";
import { resourceDispatch, validResourceId } from "@xueness/sessions";

type Row = Record<string, unknown>;
export const ACTIVATION_KINDS = ["skills", "commands", "hooks"] as const;
export type ActivationKind = (typeof ACTIVATION_KINDS)[number];
/**
 * One thing a package offers: a skill body, a prompt template, or a hook. For a hook, `body` is the command it
 * would run and `hook` says when. A hook is registered switched off: the person reads the command on the hooks
 * page and enables each one there. Text kinds take effect as soon as they are written.
 */
export interface PackageContribution { kind: ActivationKind; id: string; name: string; description: string; body: string; hook?: { event: string; matcher?: string; timeout?: number } }
/** The owning plugin's resource handler (`/api/resources/<kind>`), which enforces that plugin's switch. */
export type ResourceWriter = (kind: ActivationKind, data: Row) => Promise<[number, unknown] | null> | [number, unknown] | null;

const MAX_BODY_CHARS = 128 * 1024;
export const packageTag = (type: string, id: string): string => `${type}:${id}`;
/** Resource ids are file stems; a package's items live under `<package>.<item>`. */
export const contributionResourceId = (packageId: string, itemId: string): string => `${packageId}.${itemId}`;

function stored(stateDir: string, kind: ActivationKind): Row[] {
  const reply = resourceDispatch(stateDir, "GET", ["api", "resources", kind], {});
  return reply && reply[0] === 200 && Array.isArray(reply[1].items) ? reply[1].items.filter(isDict) : [];
}

/** `review` counts registered hooks that are still switched off, waiting for the person to enable them. */
export interface ActivationState { state: "none" | "inactive" | "partial" | "active"; total: number; active: number; review: number; kinds: { kind: ActivationKind; total: number; active: number }[] }

/** Read from the store itself, so it stays truthful while an owning plugin is switched off. */
export function activationState(stateDir: string, type: string, packageId: string, contributions: readonly PackageContribution[]): ActivationState {
  const tag = packageTag(type, packageId);
  let review = 0;
  const kinds = ACTIVATION_KINDS.map((kind) => {
    const wanted = new Set(contributions.filter((item) => item.kind === kind).map((item) => contributionResourceId(packageId, item.id)));
    const present = stored(stateDir, kind).filter((row) => row.sourcePackage === tag && typeof row.id === "string" && wanted.has(row.id));
    if (kind === "hooks") review = present.filter((row) => row.enabled !== true).length;
    return { kind, total: wanted.size, active: present.length };
  }).filter((row) => row.total > 0);
  const total = kinds.reduce((sum, row) => sum + row.total, 0), active = kinds.reduce((sum, row) => sum + row.active, 0);
  return { state: total === 0 ? "none" : active === 0 ? "inactive" : active < total ? "partial" : "active", total, active, review, kinds };
}

export interface ActivationResult { ok: boolean; written: { kind: ActivationKind; id: string }[]; skipped: { kind: ActivationKind; id: string; reason: string }[]; removed: number }

/** Write every contribution whose owning plugin is effective, then drop tagged resources the package no longer offers. */
export async function activatePackage(options: { stateDir: string; enabled(id: string): boolean; write: ResourceWriter }, type: string, packageId: string, version: string,
  contributions: readonly PackageContribution[]): Promise<ActivationResult> {
  const tag = packageTag(type, packageId);
  const result: ActivationResult = { ok: false, written: [], skipped: [], removed: 0 };
  const keep = new Set<string>();
  for (const kind of ACTIVATION_KINDS) {
    const mine = contributions.filter((item) => item.kind === kind);
    if (!mine.length) continue;
    const existing = new Map(stored(options.stateDir, kind).map((row) => [String(row.id), row]));
    for (const item of mine) {
      const id = contributionResourceId(packageId, item.id);
      const skip = (reason: string) => { result.skipped.push({ kind, id: item.id, reason }); };
      // The plugin that owns the kind decides whether it takes effect; its switch is the person's.
      if (!options.enabled(kind)) { skip("plugin_disabled"); continue; }
      if (!validResourceId(id) || id.endsWith("\n")) { skip("invalid_id"); continue; }
      if (!item.body.trim() || item.body.length > MAX_BODY_CHARS) { skip(item.body.trim() ? "too_large" : "empty"); continue; }
      const current = existing.get(id);
      if (current && current.sourcePackage !== tag) { skip("name_taken"); continue; }
      const base = { id, name: item.name, description: item.description, enabled: true, sourcePackage: tag, sourceVersion: version };
      let document: Row;
      if (kind === "hooks") {
        if (!item.hook) { skip("invalid_hook"); continue; }
        const hook = { event: item.hook.event, command: item.body, ...(item.hook.matcher ? { matcher: item.hook.matcher } : {}), ...(item.hook.timeout ? { timeout: item.hook.timeout } : {}) };
        // A hook runs a command, so it starts switched off. One the person already enabled stays on only while
        // what it runs, and when, is unchanged; any change sends it back for review.
        const unchanged = current?.enabled === true && current.event === hook.event && current.command === hook.command && (current.matcher ?? "") === (hook.matcher ?? "");
        document = { ...base, ...hook, enabled: unchanged };
      } else document = kind === "skills" ? { ...base, body: item.body } : { ...base, prompt: item.body };
      const reply = await options.write(kind, document);
      if (reply && reply[0] === 200) { result.written.push({ kind, id: item.id }); keep.add(`${kind}/${id}`); } else skip(reply?.[0] === 403 ? "plugin_disabled" : "write_failed");
    }
  }
  result.removed = removeTagged(options.stateDir, tag, keep);
  result.ok = result.written.length > 0;
  return result;
}

/** Delete this package's tagged resources (all of them, or all but `keep`). The package's own data, so no plugin switch applies. */
function removeTagged(stateDir: string, tag: string, keep: ReadonlySet<string> = new Set()): number {
  let removed = 0;
  for (const kind of ACTIVATION_KINDS) {
    for (const row of stored(stateDir, kind)) {
      if (row.sourcePackage !== tag || typeof row.id !== "string" || keep.has(`${kind}/${row.id}`)) continue;
      const reply = resourceDispatch(stateDir, "DELETE", ["api", "resources", kind, row.id], {});
      if (reply && reply[0] === 200) removed += 1;
    }
  }
  return removed;
}

export const deactivatePackage = (stateDir: string, type: string, packageId: string): number => removeTagged(stateDir, packageTag(type, packageId));
