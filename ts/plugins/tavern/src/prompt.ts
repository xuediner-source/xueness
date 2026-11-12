/**
 * The opening brief of a roleplay: the character, the scenario, the world information that applies at the
 * start, example dialogue and the greeting to open with. It is ordinary text that the person sends as the
 * first message of a new chat, so the session, its permissions and its model are the workbench's own.
 *
 * World information is chosen once, here: entries marked constant, plus entries whose keys occur in the
 * scenario or the chosen greeting. Entries are not re-evaluated on later turns.
 */
import type { BookEntry, Character, WorldBook } from "./cards.ts";

const MAX_WORLD_CHARS = 12_000, MAX_BRIEF_CHARS = 60_000;

/** `{{char}}` and `{{user}}` (and the older `<BOT>` / `<USER>`) as SillyTavern cards write them. */
export function applyMacros(text: string, character: string, user: string): string {
  return text.replace(/\{\{char\}\}|<BOT>/gi, character).replace(/\{\{user\}\}|<USER>/gi, user);
}

/** Entries that apply to `context`: constant ones, and those with a primary key (and, when given, a secondary key) in it. */
export function selectEntries(entries: readonly BookEntry[], context: string): BookEntry[] {
  const haystack = context.toLowerCase();
  const hit = (keys: readonly string[]): boolean => keys.some(key => key && haystack.includes(key.toLowerCase()));
  const chosen = entries.filter(entry => entry.enabled && (entry.constant || hit(entry.keys) && (!entry.secondary.length || hit(entry.secondary))));
  chosen.sort((a, b) => a.order - b.order);
  const kept: BookEntry[] = [];
  let used = 0;
  for (const entry of chosen) {
    if (used + entry.content.length > MAX_WORLD_CHARS) continue;
    kept.push(entry); used += entry.content.length;
  }
  return kept;
}

export interface BriefInput { character: Character; books: readonly WorldBook[]; userName: string; greeting: number }
export interface Brief { text: string; greeting: string; worldEntries: number; truncated: boolean }

export function roleplayBrief(input: BriefInput): Brief {
  const { character } = input;
  const user = input.userName.trim().slice(0, 60) || "User";
  const fill = (text: string): string => applyMacros(text, character.name, user).trim();
  const greetings = [character.firstMessage, ...character.alternateGreetings].filter(text => text.trim());
  const greeting = fill(greetings[Math.max(0, Math.min(greetings.length - 1, Math.trunc(input.greeting) || 0))] ?? "");
  const world = selectEntries([...character.book, ...input.books.flatMap(book => book.entries)], `${fill(character.scenario)}\n${greeting}`);
  const section = (title: string, body: string): string => body ? `## ${title}\n${body}` : "";
  const parts = [
    `# Roleplay: ${character.name}`,
    `You are playing ${character.name} in an interactive story with ${user}. Stay in character for the whole conversation. Write only ${character.name}'s words, actions and narration; never write ${user}'s lines or decide what ${user} does. This is a conversation, not a workspace task: do not call tools, read files or run commands unless ${user} explicitly asks for that.`,
    section("Instructions from the card", fill(character.systemPrompt)),
    section(`Who ${character.name} is`, fill(character.description)),
    section("Personality", fill(character.personality)),
    section("Scenario", fill(character.scenario)),
    section("World information", world.map(entry => fill(entry.content)).join("\n\n")),
    section("Example dialogue", fill(character.exampleMessages)),
    section("Keep in mind throughout", fill(character.postHistoryInstructions)),
    greeting ? `## Opening\nBegin the story now. Send the following opening message, in character, exactly as written, and then wait for ${user}:\n\n${greeting}`
      : `## Opening\nBegin the story now with a short opening message in character, and then wait for ${user}.`,
  ].filter(Boolean);
  const full = parts.join("\n\n");
  return { text: full.slice(0, MAX_BRIEF_CHARS), greeting, worldEntries: world.length, truncated: full.length > MAX_BRIEF_CHARS };
}
