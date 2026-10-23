/** Shared generators for the session store differential tests. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDict, JsonFloat, pyDeepCopy, setOwn } from "@xueness/contracts";
import { SessionFactory } from "../../../test-support/random-session.ts";

export type Row = Record<string, unknown>;
const HEX = "0123456789abcdef";
const INDEX_KEY = /^(0|[1-9][0-9]{0,8})$/;

export function hexId(f: SessionFactory): string {
  return Array.from({ length: 32 }, () => HEX[f.int(16)]).join("");
}

export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `xueness-${label}-`));
}

/**
 * JavaScript objects list integer-like keys first, so a key such as "3"
 * would not keep its insertion order; rename those keys for byte-level
 * comparisons (the reordering itself is covered by a dedicated test).
 */
export function plainKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(plainKeys) as T;
  if (!isDict(value)) return value;
  const out: Row = {};
  for (const [key, item] of Object.entries(value)) setOwn(out, INDEX_KEY.test(key) ? `k${key}` : key, plainKeys(item));
  return out as T;
}

/** Values whose Python encoding is easy to get wrong. */
export const EDGE_VALUES: readonly unknown[] = [
  new JsonFloat(-0), new JsonFloat(0), new JsonFloat(2), new JsonFloat(1e16), new JsonFloat(1e-7), new JsonFloat(Number.NaN),
  new JsonFloat(Infinity), new JsonFloat(-Infinity), 2n ** 70n, -(2n ** 64n), 9007199254740993n, 0.1, 1e300, 123456.789,
  "\u2028\u0085\u007f", "😀👨‍👩‍👧中", "", true, null, [], {},
];

/** Type changes that Python's `==` cannot see (1 == 1.0 == True, 0.0 == -0.0). */
export const FLIPS: readonly unknown[] = [0, 1, true, false, new JsonFloat(1), new JsonFloat(0), new JsonFloat(-0), 2n ** 64n, "1"];

/** A random session with a valid id and lossless edge values. */
export function storeSession(f: SessionFactory, id: string): Row {
  const session = plainKeys(f.session()) as Row;
  session.id = id;
  if (f.chance(0.7)) session.task = f.text();
  if (f.chance(0.5)) session.edge = Array.from({ length: 1 + f.int(4) }, () => f.pick(EDGE_VALUES));
  return session;
}

/** One random edit: growth, shrinkage, deletion, replacement or a hidden type flip. */
export function mutate(f: SessionFactory, session: Row, { flips = true } = {}): void {
  if (!Array.isArray(session.messages)) session.messages = [];
  const messages = session.messages as unknown[];
  switch (f.int(10)) {
    case 0:
      messages.push(plainKeys(f.message()));
      break;
    case 1: {
      const target = messages.find((message) => isDict(message) && typeof message.content === "string") as Row | undefined;
      if (target) target.content = `${target.content as string}${f.text(5) || "x"}`;
      else messages.push({ role: "user", content: f.text() });
      break;
    }
    case 2:
      session.status = f.pick(["running", "completed", "needs_review", "pending"]);
      break;
    case 3: {
      const keys = Object.keys(session).filter((key) => key !== "id" && key !== "messages");
      if (keys.length) delete session[f.pick(keys)];
      break;
    }
    case 4:
      session.steps = flips ? f.pick(FLIPS) : f.int(50);
      break;
    case 5:
      session.todos = plainKeys(f.value());
      break;
    case 6:
      if (messages.length) messages.splice(f.int(messages.length), 1);
      break;
    case 7:
      session.edge = Array.from({ length: f.int(4) }, () => (flips ? f.pick(EDGE_VALUES) : f.text()));
      break;
    default:
      session[`x${f.int(5)}`] = plainKeys(f.value());
  }
}

/** Freshly generated message ids are random on both sides; kept ids must match exactly. */
export function maskNewIds(before: Row, after: Row): Row {
  const out = pyDeepCopy(after);
  const original = Array.isArray(before.messages) ? before.messages : [];
  if (!Array.isArray(out.messages)) return out;
  out.messages.forEach((message: unknown, index: number) => {
    const previous = original[index];
    if (isDict(message) && (!isDict(previous) || message._message_id !== previous._message_id)) message._message_id = "<new>";
  });
  return out;
}
