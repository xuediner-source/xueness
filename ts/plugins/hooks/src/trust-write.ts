/**
 * The write side of workspace-hook trust (Python `workspace_hooks.set_feature`,
 * `grant_trust`, `revoke_trust`): only the operator CLI and settings call it;
 * a corrupt store is never rewritten.
 */
import { join } from "node:path";
import { pyUtcNow, PyValueError } from "@xueness/contracts";
import { atomicWriteJson } from "@xueness/sessions";
import { isLink } from "./files.ts";
import type { Row } from "./load.ts";
import { FEATURE_FILENAME, loadTrust, MAX_TRUST_RECORDS, TRUST_FILENAME, TRUST_SCHEMA_VERSION } from "./trust.ts";
import { authorizationRevision } from "./revision.ts";
import { displayCommand } from "./workspace.ts";

export function setFeature(stateDir: string, enabled: unknown): Row {
  if (typeof enabled !== "boolean") throw new PyValueError("enabled must be a boolean");
  const path = join(stateDir, FEATURE_FILENAME);
  if (isLink(path)) throw new PyValueError("workspace hook settings must not be a symlink");
  atomicWriteJson(path, { enabled });
  return { enabled, status: "ok" };
}

function writeTrust(path: string, records: Row[]): boolean {
  if (isLink(path)) return false;
  try { atomicWriteJson(path, { schemaVersion: TRUST_SCHEMA_VERSION, records }); return true; } catch { return false; }
}

export function grantTrust(stateDir: string, workspace: string, rows: readonly Row[], now?: string): Row {
  const loaded = loadTrust(stateDir);
  if (loaded.status === "corrupt") return { ok: false, reason: "trust_store_corrupt", trustStatus: "corrupt", corruptPath: loaded.corruptPath };
  const records = [...loaded.records];
  const existing = new Map(records.map((record, index) => [JSON.stringify([record.workspace, record.digest]), index]));
  const stamp = now || pyUtcNow();
  // F07.03: each grant is bound to the configuration revision it was reviewed against.
  const revision = authorizationRevision(stateDir, workspace);
  let granted = 0;
  let added = 0;
  for (const row of rows) {
    const key = JSON.stringify([workspace, row.digest]);
    const fresh = { workspace, digest: row.digest, decision: "trusted", grantedAt: stamp, eventAtGrant: row.event,
      displayCommandAtGrant: displayCommand(row), sourcePathAtGrant: row.sourceRelative, configRevisionAtGrant: revision };
    const index = existing.get(key);
    if (index === undefined) {
      existing.set(key, records.length);
      records.push(fresh);
      granted += 1; added += 1;
      continue;
    }
    // A record reviewed under an earlier revision is re-stamped in place: the
    // user just re-reviewed this declaration, so keeping the old revision
    // would leave the hook pending forever (re-granting could never restore it).
    const record = records[index]!;
    if (record.configRevisionAtGrant === revision) continue;
    records[index] = fresh;
    granted += 1;
  }
  if (added && records.length > MAX_TRUST_RECORDS) return { ok: false, reason: "trust_store_full", trustStatus: "ok", corruptPath: null };
  if (granted && !writeTrust(join(stateDir, TRUST_FILENAME), records)) return { ok: false, reason: "trust_store_write_failed", trustStatus: loaded.status, corruptPath: null };
  return { ok: true, granted, records, trustStatus: "ok", corruptPath: null };
}

export function revokeTrust(stateDir: string, workspace: string, digests: readonly string[] = [], revokeAll = false): Row {
  const loaded = loadTrust(stateDir);
  if (loaded.status === "corrupt") return { ok: false, reason: "trust_store_corrupt", trustStatus: "corrupt", corruptPath: loaded.corruptPath };
  const wanted = new Set(digests);
  const kept = loaded.records.filter((record) => revokeAll ? record.workspace !== workspace : !(record.workspace === workspace && wanted.has(String(record.digest))));
  const removed = loaded.records.length - kept.length;
  if (removed && !writeTrust(join(stateDir, TRUST_FILENAME), kept)) return { ok: false, reason: "trust_store_write_failed", trustStatus: loaded.status, corruptPath: null };
  return { ok: true, removed, records: kept, trustStatus: "ok", corruptPath: null };
}
