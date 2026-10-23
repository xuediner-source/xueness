/** Offering levels may fall back to the whitelist; validation never does. */
import { ProfileStore, reasoningLevels, REASONING_LEVELS } from "./profile-store.ts";
export function declaredReasoningLevels(store: ProfileStore, providerId?: string | null, model?: string | null): string[] {
  const record = providerId ? store.record(providerId) : null;
  const known = reasoningLevels(model || record?.model, record?.baseUrl, record && Object.hasOwn(record, "reasoningLevels") ? record.reasoningLevels : undefined);
  return record && Object.hasOwn(record, "reasoningLevels") ? known : known.length ? known : REASONING_LEVELS;
}
