/**
 * Composer HTTP owner (Python `composer_api.dispatch`): the catalogue, one-shot
 * draft preparation and workspace branch switches, plus the in-process
 * handoffs session admission uses (`consume_prepared`, `/command` expansion).
 */
import { pyLen, pyStrip, PyValueError } from "@xueness/contracts";
import { realish } from "@xueness/sessions";
import { AttachmentError } from "./attachment-types.ts";
import { checkKeys } from "./composer-attachments.ts";
import { composerCatalog } from "./composer-catalog.ts";
import { consumePrepared, PreparedCache, prepareInput, type ComposerOptions } from "./composer-prepare.ts";
import { ComposerError, oneQuery, readSession, requestRoot, requireEnabled, resolveRoot } from "./composer-roots.ts";
import type { SessionReply } from "./http-api.ts";

type Row = Record<string, unknown>;
const MAX_TEXT = 5000;
export interface ComposerApiOptions extends ComposerOptions {
  /** `_switch_branch` after the active-run check; failures throw `ComposerError`. */
  switchBranch?(root: string, branch: unknown): Promise<Row>;
  cache?: PreparedCache;
}

/** `_running_same_root`: an unreadable running session conservatively blocks the switch. */
function runningSameRoot(o: ComposerOptions, root: string): boolean {
  for (const sid of [...o.running]) {
    const session = readSession(o, sid);
    if (!session || typeof session.root !== "string") return true;
    try { if (realish(session.root) === root) return true; } catch { return true; }
  }
  return false;
}

const action = (parts: readonly string[]): string | null => {
  if (parts[0] !== "api" || parts[1] !== "composer") return null;
  if (parts.length === 2) return "";
  return parts.length === 3 && (parts[2] === "prepare" || parts[2] === "branch") ? parts[2] : null;
};
const refusal = (error: unknown): SessionReply | null => error instanceof ComposerError || error instanceof AttachmentError ? [error.status, { error: error.message }] : null;

export function createComposerApi(o: ComposerApiOptions) {
  const cache = o.cache ?? new PreparedCache();
  async function branch(data: unknown): Promise<Row> {
    const body = checkKeys(data, ["root", "branch"], "branch request");
    requireEnabled(o, "git");
    const root = resolveRoot(o, body.root);
    if (runningSameRoot(o, root)) throw new ComposerError(409, "workspace has an active run");
    if (!o.switchBranch) throw new ComposerError(403, "plugin disabled or dependency unavailable: git");
    return o.switchBranch(root, body.branch);
  }
  return {
    routes: ["GET /api/composer", "POST /api/composer/prepare", "POST /api/composer/branch"],
    owns: (_method: string, parts: readonly string[]): boolean => action(parts) !== null,
    async dispatch(method: string, parts: readonly string[], query: Record<string, unknown>, data: unknown): Promise<SessionReply | null> {
      const name = action(parts);
      if (name === null) return null;
      // The `composer` HTTP family belongs to the sessions plugin (`web.py` route gate).
      if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions", code: "plugin_disabled" }];
      if (name === "") {
        if (method !== "GET") return [405, { error: "method not allowed" }];
        try { return [200, await composerCatalog(o, requestRoot(o, oneQuery(query, "root"), oneQuery(query, "session_id")))]; }
        catch (error) { return refusal(error) ?? [500, { error: "composer catalog unavailable" }]; }
      }
      if (method !== "POST") return [405, { error: "method not allowed" }];
      if (name === "prepare") {
        try { return [200, await prepareInput(o, cache, data)]; }
        catch (error) { return refusal(error) ?? [400, { error: "invalid composer input" }]; }
      }
      try { return [200, await branch(data)]; }
      catch (error) { return refusal(error) ?? [400, { error: "invalid branch selection" }]; }
    },
    /** `consume_prepared`: one trusted use, for the root the draft was prepared for. */
    async consumePrepared(token: string, root: string): Promise<Row> {
      try { requireEnabled(o, "sessions"); return consumePrepared(o, cache, token, root); }
      catch { throw new PyValueError("prepared input invalid or expired"); }
    },
    /** `POST /api/composer/expand-command`: read-only `/command` substitution, never a shell. */
    async expandCommands(text: string, root: string): Promise<{ text: string; invocation: Row | null }> {
      if (typeof text !== "string" || !pyStrip(text) || pyLen(text) > MAX_TEXT) throw new PyValueError("message must be 1..5000 characters");
      try {
        requireEnabled(o, "sessions");
        const resolved = resolveRoot(o, root), stripped = pyStrip(text);
        if (!o.enabled("commands")) return { text: stripped, invocation: null };
        if (!o.expand) throw new Error("unavailable");
        return o.expand(stripped, resolved, null);
      } catch (error) { throw new PyValueError(error instanceof ComposerError ? error.message : "command expansion unavailable"); }
    },
  };
}
