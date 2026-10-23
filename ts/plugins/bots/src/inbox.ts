/**
 * `poll` and `reply`. Polling turns allowlisted chat text into pending local
 * sessions (never a model or tool grant); a reply needs explicit confirmation
 * and an allowlisted chat. Each inbox key is `channel:update_id`, and the
 * session is saved before the inbox acknowledges it, so a retry reconciles.
 */
import { isDict, isPyIntValue, pyLen, PyValueError, pyStr } from "@xueness/contracts";
import type { FileLockProvider, SessionStore } from "@xueness/sessions";
import { loadState, withConfigLock, writeState } from "./store.ts";
import { botRequest, type BotTransport } from "./telegram.ts";

type Row = Record<string, unknown>;
export interface InboxOptions {
  stateDir: string;
  store: SessionStore;
  env?: NodeJS.ProcessEnv;
  transport?: BotTransport;
  locks?: FileLockProvider;
}
/** `next(...)` over the saved channels raises StopIteration; the HTTP layer reports it like a bad request. */
export class ChannelNotFound extends Error { override name = "StopIteration"; }

const big = (value: number | bigint): bigint => typeof value === "bigint" ? value : BigInt(value);
const plain = (value: bigint): number | bigint => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
const LIMIT = 2n ** 63n;

function channelOf(state: { channels: Row[] }, cid: string): Row {
  const channel = state.channels.find((item) => item.id === cid);
  if (!channel) throw new ChannelNotFound("channel not found");
  return channel;
}

async function sessionFor(store: SessionStore, key: string): Promise<Row | null> {
  for (const item of await store.list()) {
    const row = await store.load(String(item.id)) as Row;
    if (row.bot_source === key) return row;
  }
  return null;
}

export async function poll(o: InboxOptions, cid: string): Promise<Row> {
  return withConfigLock(o.stateDir, async () => {
    const state = loadState(o.stateDir);
    const channel = channelOf(state, cid);
    const offsetOf = (): bigint => big(Object.hasOwn(channel, "offset") ? channel.offset as number | bigint : 0);
    const rows = await botRequest(channel, "getUpdates", { offset: plain(offsetOf()), limit: 20, timeout: 0, allowed_updates: ["message"] }, o.env, o.transport);
    if (!Array.isArray(rows)) throw new PyValueError("invalid bot updates");
    const allowed = Array.isArray(channel.allowedChats) ? channel.allowedChats : [];
    for (const update of rows) {
      if (!isDict(update) || !isPyIntValue(update.update_id)) continue;
      const uid = big(update.update_id);
      if (uid < 0n || uid >= LIMIT) continue;
      const message = isDict(update.message) ? update.message : {};
      const chatRow = isDict(message.chat) ? message.chat : {};
      const chat = pyStr(Object.hasOwn(chatRow, "id") ? chatRow.id : ""), text = message.text;
      if (uid < offsetOf()) continue;
      if (allowed.includes(chat) && typeof text === "string" && pyLen(text) > 0 && pyLen(text) <= 4500) {
        const key = `${cid}:${uid}`;
        const session = await sessionFor(o.store, key) ?? await o.store.new("Channel message (untrusted external content):\n" + text, String(channel.root)) as Row;
        session.bot_source = key;
        await o.store.save(session as never);
        if (!state.inbox.some((item) => item.key === key)) state.inbox.push({ key, channel: cid, chatId: chat, sessionId: session.id });
      }
      channel.offset = plain(uid + 1n > offsetOf() ? uid + 1n : offsetOf());
    }
    state.inbox = state.inbox.slice(-200);
    writeState(o.stateDir, state);
    return { inbox: state.inbox.filter((item) => item.channel === cid) };
  }, o.locks);
}

export async function reply(o: InboxOptions, cid: string, data: unknown): Promise<Row> {
  const state = loadState(o.stateDir);
  const channel = channelOf(state, cid);
  const body = isDict(data) ? data : {};
  const text = body.text, chat = pyStr(Object.hasOwn(body, "chatId") ? body.chatId : "");
  const allowed = Array.isArray(channel.allowedChats) ? channel.allowedChats : [];
  if (body.confirmed !== true || !allowed.includes(chat) || typeof text !== "string" || pyLen(text) < 1 || pyLen(text) > 4000) throw new PyValueError("explicit reviewed reply to an allowed chat required");
  await botRequest(channel, "sendMessage", { chat_id: chat, text }, o.env, o.transport);
  return { sent: true };
}
