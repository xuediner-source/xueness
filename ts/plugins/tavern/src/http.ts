/**
 * `/api/tavern`: the character and world-book library and the roleplay brief.
 *
 *   GET    /api/tavern                    library summaries and limits
 *   POST   /api/tavern/characters         { card, fileName? }   card is JSON text (the page extracts it from a PNG card)
 *   DELETE /api/tavern/characters/:id
 *   POST   /api/tavern/worldbooks         { book, fileName? }
 *   DELETE /api/tavern/worldbooks/:id
 *   POST   /api/tavern/brief              { characterId, userName?, greeting?, worldbooks? } → the opening message
 *
 * Refused imports answer 200 with `ok: false` and a stable code. No model request is made here.
 */
import { CardError, MAX_CARD_BYTES, parseCharacter, parseWorldBook, type Character, type WorldBook } from "./cards.ts";
import { roleplayBrief } from "./prompt.ts";
import { MAX_ITEMS, TavernStore } from "./store.ts";

export const TAVERN_ROUTES = ["GET /api/tavern", "POST /api/tavern/characters", "DELETE /api/tavern/characters/:id", "POST /api/tavern/worldbooks", "DELETE /api/tavern/worldbooks/:id", "POST /api/tavern/brief"] as const;
export interface TavernHttpOptions { stateDir: string; enabled(id: string): boolean; now?: () => string }
type Reply = [number, unknown];
type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const refuse = (code: string, message: string): Reply => [200, { ok: false, error: { code, message } }];
const clip = (text: string, max: number): string => text.length > max ? text.slice(0, max) + "…" : text;

const characterSummary = (item: Character) => ({
  id: item.id, name: item.name, creator: item.creator, tags: item.tags, spec: item.spec, importedAt: item.importedAt, fileName: item.fileName,
  description: clip(item.description.trim(), 400), scenario: clip(item.scenario.trim(), 300),
  greetings: [item.firstMessage, ...item.alternateGreetings].filter(text => text.trim()).map(text => clip(text.trim(), 240)),
  bookEntries: item.book.length, hasExamples: item.exampleMessages.trim() !== "", hasSystemPrompt: item.systemPrompt.trim() !== "",
});
const bookSummary = (item: WorldBook) => ({
  id: item.id, name: item.name, description: clip(item.description.trim(), 300), importedAt: item.importedAt, fileName: item.fileName,
  entries: item.entries.length, constant: item.entries.filter(entry => entry.enabled && entry.constant).length, disabled: item.entries.filter(entry => !entry.enabled).length,
});

export function createTavernHttp(options: TavernHttpOptions) {
  const store = new TavernStore(options.stateDir);
  const now = options.now ?? (() => new Date().toISOString());
  const owns = (_method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "tavern";
  const listing = () => ({
    characters: store.list<Character>("characters").map(characterSummary), worldbooks: store.list<WorldBook>("worldbooks").map(bookSummary),
    limits: { cardBytes: MAX_CARD_BYTES, items: MAX_ITEMS },
  });
  return {
    routes: TAVERN_ROUTES,
    owns,
    dispatch(method: string, parts: readonly string[], _query: Record<string, string[]>, data: unknown): Reply | null {
      if (!owns(method, parts)) return null;
      if (!options.enabled("tavern")) return [403, { error: "plugin disabled or dependency unavailable: tavern", plugin: "tavern" }];
      const body = isObject(data) ? data : {};
      try {
        if (method === "GET" && parts.length === 2) return [200, listing()];
        const kind = parts[2] === "characters" || parts[2] === "worldbooks" ? parts[2] : null;
        if (kind && method === "POST" && parts.length === 3) {
          if (store.list(kind).length >= MAX_ITEMS) return refuse("library_full", `the library holds at most ${MAX_ITEMS} ${kind}`);
          const item = kind === "characters" ? parseCharacter(body.card, body.fileName, now()) : parseWorldBook(body.book, body.fileName, now());
          const replaced = store.get(kind, item.id) !== null;
          store.put(kind, item);
          return [200, { ok: true, replaced, item: kind === "characters" ? characterSummary(item as Character) : bookSummary(item as WorldBook), ...listing() }];
        }
        if (kind && method === "DELETE" && parts.length === 4) {
          return store.remove(kind, parts[3]) ? [200, { ok: true, ...listing() }] : refuse("not_found", "that item is not in the library");
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "brief") {
          const character = store.get<Character>("characters", body.characterId);
          if (!character) return refuse("not_found", "that character is not in the library");
          const ids = Array.isArray(body.worldbooks) ? body.worldbooks.filter((id): id is string => typeof id === "string").slice(0, 16) : [];
          const books = ids.map(id => store.get<WorldBook>("worldbooks", id)).filter((book): book is WorldBook => book !== null);
          const brief = roleplayBrief({ character, books, userName: typeof body.userName === "string" ? body.userName : "", greeting: typeof body.greeting === "number" ? body.greeting : 0 });
          return [200, { ok: true, character: character.name, ...brief }];
        }
        return [405, { error: "method not allowed" }];
      } catch (error) {
        if (error instanceof CardError) return refuse(error.code, error.message);
        return refuse("storage_failed", "the tavern library could not complete the operation");
      }
    },
  };
}
