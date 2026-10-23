/**
 * The workspace-hook feature switch, the digest trust store (read side) and
 * admission (Python `workspace_hooks.py`: `feature_status`, `load_trust`,
 * `admitted`, `_note_pending_trust`, `extend_for_runner`). Granting and
 * revoking stay with the settings HTTP/CLI (Python); a run only reads.
 *
 * Off by default: `<state>/workspace-hooks.json` must hold exactly
 * `{"enabled": true}`. While it is off no workspace file is read. A corrupt
 * trust store trusts nothing.
 */
import { join } from "node:path";
import { isDict, isPyIntValue, pyJsonLoads } from "@xueness/contracts";
import { isLink, lexists, readCapped, utf8 } from "./files.ts";
import type { Row } from "./load.ts";
import { canonicalWorkspace, discover, displayCommand, type Diagnostic } from "./workspace.ts";
import { WORKSPACE_HOOK_ORIGIN, type WorkspaceHookOrigin } from "./origin.ts";

export const FEATURE_FILENAME = "workspace-hooks.json";
export const FEATURE_MAX_BYTES = 4096;
export const TRUST_FILENAME = "hook-trust.json";
export const TRUST_SCHEMA_VERSION = 1;
export const MAX_TRUST_BYTES = 256 * 1024;
export const MAX_TRUST_RECORDS = 512;
export const MAX_DIAGNOSTICS = 50;
const REQUIRED = ["workspace", "digest", "decision", "grantedAt"];
const OPTIONAL = ["eventAtGrant", "displayCommandAtGrant", "sourcePathAtGrant"];
const HEX64 = /^[0-9a-f]{64}$/;

function readDocument(path: string, max: number): { status: "absent" | "corrupt" } | { status: "ok"; document: unknown } {
  if (isLink(path)) return { status: "corrupt" };
  if (!lexists(path)) return { status: "absent" };
  const raw = readCapped(path, max);
  if (raw === null || raw.length > max) return { status: "corrupt" };
  const text = utf8(raw);
  if (text === null) return { status: "corrupt" };
  try { return { status: "ok", document: pyJsonLoads(text, { lossless: true }) }; } catch { return { status: "corrupt" }; }
}

export function featureStatus(stateDir: string): { enabled: boolean; status: string } {
  const read = readDocument(join(stateDir, FEATURE_FILENAME), FEATURE_MAX_BYTES);
  if (read.status !== "ok") return { enabled: false, status: read.status };
  const document = read.document;
  if (!isDict(document) || Object.keys(document).length !== 1 || typeof document.enabled !== "boolean") return { enabled: false, status: "corrupt" };
  return { enabled: document.enabled, status: "ok" };
}

function validRecord(record: unknown): boolean {
  if (!isDict(record)) return false;
  const keys = Object.keys(record);
  if (!REQUIRED.every((key) => keys.includes(key)) || keys.some((key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key))) return false;
  if (typeof record.workspace !== "string" || !record.workspace) return false;
  if (typeof record.digest !== "string" || !HEX64.test(record.digest)) return false;
  if (record.decision !== "trusted") return false;
  if (typeof record.grantedAt !== "string" || !record.grantedAt) return false;
  return OPTIONAL.every((key) => !keys.includes(key) || typeof record[key] === "string" && !!record[key]);
}

export interface TrustState { status: "ok" | "absent" | "corrupt"; records: Row[]; corruptPath: string | null }
export function loadTrust(stateDir: string): TrustState {
  const path = join(stateDir, TRUST_FILENAME);
  const corrupt: TrustState = { status: "corrupt", records: [], corruptPath: path };
  const read = readDocument(path, MAX_TRUST_BYTES);
  if (read.status === "absent") return { status: "absent", records: [], corruptPath: null };
  if (read.status !== "ok") return corrupt;
  const document = read.document;
  if (!isDict(document) || Object.keys(document).length !== 2 || !Object.hasOwn(document, "schemaVersion") || !Object.hasOwn(document, "records")) return corrupt;
  if (!isPyIntValue(document.schemaVersion) || Number(document.schemaVersion) !== TRUST_SCHEMA_VERSION) return corrupt;
  const records = document.records;
  if (!Array.isArray(records) || records.length > MAX_TRUST_RECORDS || !records.every(validRecord)) return corrupt;
  const keys = new Set((records as Row[]).map((record) => JSON.stringify([record.workspace, record.digest])));
  if (keys.size !== records.length) return corrupt;
  return { status: "ok", records: records as Row[], corruptPath: null };
}

/** One bounded, deduplicated `hook_diagnostics` entry per pending hook. */
export function notePendingTrust(session: Row | null | undefined, pending: readonly Row[]): void {
  if (!isDict(session) || !pending.length) return;
  if (!Object.hasOwn(session, "hook_diagnostics")) session.hook_diagnostics = [];
  const log = session.hook_diagnostics;
  if (!Array.isArray(log)) return;
  const seen = new Set(log.filter((entry) => isDict(entry) && entry.kind === "pending_trust").map((entry) => (entry as Row).digest));
  for (const row of pending) {
    if (seen.has(row.digest)) continue;
    seen.add(row.digest);
    log.push({ kind: "pending_trust", id: row.id, event: row.event, source: row.source, sourcePath: row.sourceRelative, digest: row.digest, message: "workspace hook is pending trust and was not run" });
  }
  if (log.length > MAX_DIAGNOSTICS) log.splice(0, log.length - MAX_DIAGNOSTICS);
}

export interface Admission { hooks: Row[]; pending: Row[]; reason: string; diagnostics: Diagnostic[]; bundleDigest: string | null; trustStatus?: string; corruptPath?: string | null; featureStatus?: string }

/** Which workspace hooks may run, which are pending, and why. */
export function admitted(stateDir: string, root: unknown, session?: Row | null): Admission {
  const empty: Admission = { hooks: [], pending: [], reason: "feature_disabled", diagnostics: [], bundleDigest: null };
  const feature = featureStatus(stateDir);
  if (!feature.enabled) return empty;
  const workspace = canonicalWorkspace(root);
  if (workspace === null) return { ...empty, reason: "no_workspace" };
  const found = discover(workspace);
  const trust = loadTrust(stateDir);
  const trusted = new Set(trust.status === "ok" ? trust.records.filter((record) => record.workspace === workspace).map((record) => record.digest) : []);
  const hooks: Row[] = []; const pending: Row[] = [];
  for (const row of found.hooks) { if (!row.enabled) continue; (trusted.has(row.digest) ? hooks : pending).push(row); }
  const reason = trust.status === "corrupt" ? "trust_store_corrupt" : !found.hooks.length ? "no_workspace_hooks" : pending.length ? "pending_trust" : hooks.length ? "trusted" : "no_enabled_hooks";
  notePendingTrust(session, pending);
  return { hooks, pending, reason, diagnostics: found.diagnostics, bundleDigest: found.bundleDigest, trustStatus: trust.status, corruptPath: trust.corruptPath, featureStatus: feature.status };
}

/** The minimal hook row the runner understands. */
export function runnerRow(row: Row): Row {
  const hook: Row = { id: row.id, event: row.event, command: row.command };
  if (row.matcher) hook.matcher = row.matcher;
  if (Array.isArray(row.args) && row.args.length) hook.args = [...row.args];
  if (row.timeout !== undefined && row.timeout !== null) hook.timeout = row.timeout;
  if (row.pipeline) hook.pipeline = true;
  if (typeof row.workspace === "string" && typeof row.digest === "string" && typeof row.sourcePath === "string") {
    Object.defineProperty(hook, WORKSPACE_HOOK_ORIGIN, { value: { workspace: row.workspace, digest: row.digest, path: row.sourcePath } satisfies WorkspaceHookOrigin });
  }
  return hook;
}

/** User hooks first, admitted workspace hooks after; never throws. */
export function extendForRunner(stateDir: string, root: unknown, userHooks: readonly Row[], session?: Row | null): Row[] {
  const user = [...userHooks];
  try { return [...user, ...admitted(stateDir, root, session).hooks.map(runnerRow)]; } catch { return user; }
}

/** Python `status_document`: every declaration, its digest and trust state. Granting stays with the CLI. */
export function statusDocument(stateDir: string, root: unknown): Row {
  const workspace = canonicalWorkspace(root);
  const feature = featureStatus(stateDir);
  if (!feature.enabled || workspace === null) return { workspace, featureEnabled: false, featureStatus: feature.status, bundleDigest: null,
    reason: feature.enabled ? "no_workspace" : "feature_disabled", trustStatus: "unknown", corruptPath: null, items: [], diagnostics: [] };
  const found = discover(workspace);
  const trust = loadTrust(stateDir);
  const trusted = new Set(trust.status === "ok" ? trust.records.filter((record) => record.workspace === workspace).map((record) => record.digest) : []);
  const items = found.hooks.map((row) => ({ id: row.id, event: row.event, matcher: row.matcher ?? null, command: displayCommand(row), source: row.source,
    sourcePath: row.sourceRelative, enabled: row.enabled, digest: row.digest, trustState: trusted.has(row.digest) ? "trusted" : "pending_trust" }));
  const enabledItems = items.filter((item) => item.enabled);
  const reason = trust.status === "corrupt" ? "trust_store_corrupt" : !items.length ? "no_workspace_hooks" : !enabledItems.length ? "no_enabled_hooks"
    : enabledItems.some((item) => item.trustState !== "trusted") ? "pending_trust" : "trusted";
  return { workspace, featureEnabled: true, featureStatus: feature.status, bundleDigest: found.bundleDigest, reason, trustStatus: trust.status,
    corruptPath: trust.corruptPath, items, diagnostics: found.diagnostics };
}
