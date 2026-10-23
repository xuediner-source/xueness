/**
 * `history.page`: a bounded slice of revision records after `cursor`.
 *
 * Reading repairs a missing publication first (the snapshot is newer than
 * the log), under the same locks as a save, so a client cursor always refers
 * to a durable chain.
 */
import { isPyIntValue, pyDeepCopy, PyValueError } from "@xueness/contracts";
import { compareInts } from "./history-ops.ts";
import { commit, current, historyPath, prepare, SCHEMA, type HistoryRecord } from "./history.ts";
import type { SessionStore } from "./store.ts";

export interface HistoryPage {
  schema: string;
  sessionId: string;
  cursor: number | bigint;
  head: number | bigint;
  nextCursor: number | bigint;
  resync: boolean;
  records: HistoryRecord[];
  hasMore: boolean;
}

export async function historyPage(store: SessionStore, sid: string, cursor: unknown = 0, limit: unknown = 100): Promise<HistoryPage> {
  if (!isPyIntValue(cursor) || compareInts(cursor, 0) < 0 || !isPyIntValue(limit) || compareInts(limit, 1) < 0 || compareInts(limit, 500) > 0) {
    throw new PyValueError("invalid history cursor");
  }
  return store.withJournalLock(sid, () => {
    const session = store.readJournal(sid);
    const token = prepare(store, session);
    if (token !== null) {
      store.writeJournal(session);
      commit(token);
    }
    const { records } = current(historyPath(store, sid));
    const head = records.length ? records[records.length - 1]!.seq : 0;
    const selected = records.filter((row) => compareInts(row.seq, cursor) > 0).slice(0, Number(limit));
    const first = selected[0];
    const last = selected[selected.length - 1];
    return {
      schema: SCHEMA, sessionId: sid, cursor, head,
      nextCursor: last ? last.seq : head,
      resync: compareInts(cursor, head) > 0 || Boolean(first && compareInts(cursor, 0) !== 0 && compareInts(first.seq, BigInt(cursor) + 1n) !== 0),
      records: pyDeepCopy(selected),
      hasMore: Boolean(last && compareInts(last.seq, head) < 0),
    };
  });
}
