/**
 * Prepared-turn binding (Python `sessions/http_routes._remote_connection` and
 * `_prepared_remote`): a draft pins `{id, digest}`; the turn is accepted only
 * while that exact saved configuration is still present.
 */
import { isDict, pyLen, PyValueError } from "@xueness/contracts";
import { pluginEnabled } from "./connection-state.ts";
import { publicConnections } from "./http.ts";

export function remoteConnection(stateDir: string, remoteId: unknown, expectedDigest?: unknown): { id: string; digest: string } {
  if (typeof remoteId !== "string" || !remoteId || pyLen(remoteId) > 64) throw new PyValueError("remote connection selection is invalid");
  if (!pluginEnabled(stateDir, "remote")) throw new PyValueError("remote plugin disabled or unavailable");
  let rows: Record<string, unknown>[] = [];
  try { rows = publicConnections(stateDir); } catch { rows = []; }
  const row = rows.find((item) => item.id === remoteId);
  const digest = row?.digest;
  if (typeof digest !== "string" || digest.length !== 64) throw new PyValueError("remote connection unavailable; inspect the saved configuration");
  if (expectedDigest !== undefined && expectedDigest !== null && digest !== expectedDigest) throw new PyValueError("remote connection changed; inspect the saved configuration and prepare again");
  return { id: remoteId, digest };
}

export function preparedRemote(stateDir: string, prepared: unknown): { id: string; digest: string } | null {
  const metadata = isDict(prepared) ? prepared.metadata : null;
  const remote = isDict(metadata) ? metadata.remote : null;
  if (remote === undefined || remote === null) return null;
  if (!isDict(remote) || Object.keys(remote).length !== 2 || typeof remote.id !== "string" || typeof remote.digest !== "string" || remote.digest.length !== 64) throw new PyValueError("prepared remote selection is invalid");
  return remoteConnection(stateDir, remote.id, remote.digest);
}
