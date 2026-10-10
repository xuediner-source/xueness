import { get } from "../../xuenessApi";
import type { SessionSummary } from "../../xuenessWorkbench";

export type TranscriptHit = { session: SessionSummary; snippet: string; messageIndex: number; role: "user" | "assistant"; compacted: boolean };
export type TranscriptSearchState = { query: string; matches: TranscriptHit[]; scanned: number; skipped: number; truncated: boolean };
type SearchPage = { query: string; matches: TranscriptHit[]; nextCursor: string | null; scanned: number; skipped: number };

export function parseSearchPage(value: unknown, query: string): SearchPage {
  const raw = value as Partial<SearchPage> | null;
  if (!raw || raw.query !== query || !Array.isArray(raw.matches) || raw.matches.length > 20
    || (raw.nextCursor !== null && (typeof raw.nextCursor !== "string" || !/^[a-f0-9]{32}$/.test(raw.nextCursor)))
    || !Number.isInteger(raw.scanned) || raw.scanned! < 0 || !Number.isInteger(raw.skipped) || raw.skipped! < 0) throw new Error("Invalid conversation search response");
  for (const item of raw.matches) {
    if (!item || typeof item !== "object" || !item.session || !/^[a-f0-9]{32}$/.test(item.session.id)
      || typeof item.session.task !== "string" || typeof item.session.status !== "string"
      || typeof item.snippet !== "string" || !Number.isInteger(item.messageIndex) || item.messageIndex < 0
      || !["user", "assistant"].includes(item.role) || typeof item.compacted !== "boolean") throw new Error("Invalid conversation search match");
  }
  return raw as SearchPage;
}

/** Progressive pages avoid holding navigation or rendering hostage to history size. */
export async function searchTranscripts(query: string, signal: AbortSignal, onPage: (state: TranscriptSearchState) => void): Promise<void> {
  const state: TranscriptSearchState = { query, matches: [], scanned: 0, skipped: 0, truncated: false };
  let cursor: string | null = null;
  const seen = new Set<string>();
  const cursors = new Set<string>();
  do {
    if (signal.aborted) return;
    const path = `/api/sessions/search?q=${encodeURIComponent(query)}${cursor ? `&after=${cursor}` : ""}`;
    const page = parseSearchPage(await get<unknown>(path, signal), query);
    if (signal.aborted) return;
    for (const hit of page.matches) if (!seen.has(hit.session.id)) { seen.add(hit.session.id); state.matches.push(hit); }
    state.scanned += page.scanned;
    state.skipped += page.skipped;
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("Conversation search cursor did not advance");
    if (cursor) cursors.add(cursor);
    state.truncated = Boolean(cursor && (state.matches.length >= 100 || state.scanned >= 5000));
    onPage({ ...state, matches: [...state.matches] });
  } while (cursor && !state.truncated);
}
