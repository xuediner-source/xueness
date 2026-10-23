/**
 * `_request`: one Telegram Bot API call. The token comes from the named
 * environment variable and never leaves this module; redirects, non-2xx
 * replies, oversized bodies and rejected results all report the same
 * suppressed error so neither the token nor the reply text is echoed.
 */
import { isDict, pyJsonDumps, pyJsonLoadsBytes, PyValueError } from "@xueness/contracts";

const TOKEN = /^[0-9]+:[A-Za-z0-9_-]{10,200}$/;
const MAX_RESPONSE = 1_000_000;

/** POSTs JSON and returns the status and at most `limit + 1` body bytes. */
export type BotTransport = (url: string, body: Uint8Array, limit: number) => Promise<{ status: number; body: Uint8Array }>;

export const fetchTransport: BotTransport = async (url, body, limit) => {
  const response = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  try {
    while (reader && size <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally { await reader?.cancel().catch(() => {}); }
  return { status: response.status, body: Buffer.concat(chunks).subarray(0, limit + 1) };
};

export async function botRequest(channel: Record<string, unknown>, method: string, body: unknown, env: NodeJS.ProcessEnv = process.env, transport: BotTransport = fetchTransport): Promise<unknown> {
  const name = channel.tokenEnv;
  const token = typeof name === "string" ? env[name] ?? "" : "";
  if (!TOKEN.test(token) || token.endsWith("\n")) throw new PyValueError("bot token unavailable");
  try {
    const reply = await transport("https://api.telegram.org/bot" + token + "/" + method, Buffer.from(pyJsonDumps(body, { ensureAscii: true }), "utf8"), MAX_RESPONSE);
    if (reply.status < 200 || reply.status >= 300 || reply.body.length > MAX_RESPONSE) throw new Error("refused");
    const result = pyJsonLoadsBytes(reply.body, { lossless: true });
    if (!isDict(result) || result.ok !== true) throw new Error("rejected");
    return Object.hasOwn(result, "result") ? result.result : null;
  } catch { throw new PyValueError("bot request failed (details suppressed)"); }
}
