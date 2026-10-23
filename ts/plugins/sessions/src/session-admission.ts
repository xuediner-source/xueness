/** Read-only preflight: unsupported work must relay before a durable receipt. */
import { isPyOSError, isPyValueError } from "@xueness/sessions";
import type { SessionsApiOptions } from "./http-api.ts";
import { supportsMessageAction } from "./message-actions.ts";
type Row = Record<string, any>;
export function commandAdmission(options: SessionsApiOptions) {
  return async (type: string, payload: Row, sid: string): Promise<boolean> => {
    if (["queue", "edit_queue", "cancel_queue", "reorder_queue", "withdraw_queue"].includes(type)) return !Object.hasOwn(payload, "prepared_token") || !!options.consumePrepared;
    if (type === "create_session") return (!Object.hasOwn(payload, "prepared_token") || !!options.consumePrepared || !!options.create);
    if (type === "fork") return true;
    if (type === "edit_message") { try { return supportsMessageAction(await options.store.load(sid), payload, options); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return true; throw e; } }
    if (!options.lifecycle) return false;
    if (type === "send") {
      if (Object.hasOwn(payload, "prepared_token")) return !!options.consumePrepared || !!options.lifecycle.appendUserTurn;
      return !options.enabled("commands") || !!options.expandCommands || typeof payload.text !== "string" || !/^\/[A-Za-z0-9._:-]{1,64}(?:\s|$)/.test(payload.text.trim());
    }
    if (type !== "run") return true;
    // Missing/invalid sessions are handled by the normal writer as a rejection.
    let session;
    try { session = await options.store.load(sid); }
    catch (e) { if (isPyOSError(e) || isPyValueError(e)) return true; throw e; }
    if (options.lifecycle.supports && !options.lifecycle.supports(session, payload)) return false;
    return !(payload.continue_queue || payload.promotion_request_id || session.current_queue_item_id) || !!options.lifecycle.runQueue;
  };
}
