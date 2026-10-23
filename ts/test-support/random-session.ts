/**
 * Seeded generator of messy session journals for differential tests.
 *
 * It deliberately produces the irregular data real journals contain: missing
 * keys, nulls, numbers where strings are expected, nested containers, emoji
 * that cross truncation limits, Python-only whitespace, quotes for `repr`.
 * It avoids inputs where Python itself raises (e.g. unhashable turn ids).
 */

export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ATOMS = ["a", "Z", " ", "\t", "\n", "'", '"', "\\", "中", "文", "😀", "👨‍👩‍👧", "\u00a0", "\u200b", "\u2028", "\u001c", "\u0085", "\ufeff", "é", "\u007f", "\u0001"];
const ERRORS = ["", "denied", "Denied by policy", " DENIED ", "cancelled", "user canceled", "file not found: a.txt", "No such file",
  "invalid path", "path is required", "boom", "\u001cdenied", "\ufeffdenied", "\u0085cancel"];
const NAMES = ["read", "list", "write", "edit", "glob", "grep", "exec", "mcp", "", "task"];

export class SessionFactory {
  readonly #next: () => number;

  constructor(seed: number) {
    this.#next = rng(seed);
  }

  int(max: number): number {
    return Math.floor(this.#next() * max);
  }

  chance(p: number): boolean {
    return this.#next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  text(maxLength = 12): string {
    let out = "";
    const length = this.int(maxLength + 1);
    for (let i = 0; i < length; i += 1) out += this.pick(ATOMS);
    return out;
  }

  /** Long text so code point truncation (120/200/500/1000) is exercised. */
  longText(): string {
    const unit = this.pick(["x", "中", "😀", "ab", "'\""]);
    return unit.repeat(this.int(700)) + this.text(4);
  }

  scalar(): Json {
    switch (this.int(7)) {
      case 0: return null;
      case 1: return this.chance(0.5);
      case 2: return this.int(2000) - 1000;
      case 3: return this.pick([0.5, -1.25, 1e-7, 123.456, 3.14159]);
      default: return this.text();
    }
  }

  value(depth = 0): Json {
    if (depth > 2 || this.chance(0.6)) return this.scalar();
    if (this.chance(0.5)) return Array.from({ length: this.int(3) }, () => this.value(depth + 1));
    const out: Record<string, Json> = {};
    for (let i = 0; i < this.int(3); i += 1) out[this.text(3) || "k"] = this.value(depth + 1);
    return out;
  }

  maybe(fill: () => Json): Json | undefined {
    return this.chance(0.15) ? undefined : fill();
  }

  arguments(name: string): Json | undefined {
    const roll = this.int(10);
    if (roll === 0) return this.maybe(() => this.pick<Json>(["", null, 0, [], {}, 5, ["x"]]));
    if (roll === 1) return "{not json";
    if (roll === 2) return JSON.stringify(this.value());
    const args: Record<string, Json> = {};
    if (this.chance(0.8)) args.path = this.chance(0.7) ? (this.chance(0.2) ? this.longText() : this.text()) : this.value();
    if (name === "exec" || this.chance(0.1)) {
      args.argv = this.chance(0.7) ? Array.from({ length: this.int(4) }, () => this.text(6)) : this.value();
    }
    return JSON.stringify(args);
  }

  message(): Json {
    const role = this.pick(["assistant", "assistant", "tool", "user", "user", "system", null, 7]);
    const message: Record<string, Json> = {};
    if (role !== null) message.role = role;
    if (role === "assistant") {
      if (this.chance(0.7)) {
        message.tool_calls = Array.from({ length: this.int(3) }, () => {
          const name = this.pick(NAMES);
          const fn: Record<string, Json> = { name };
          const args = this.arguments(name);
          if (args !== undefined) fn.arguments = args;
          return this.chance(0.05) ? this.scalar() : { id: this.pick(["c1", "c2", "c3", "constructor", "__proto__", ""]), function: fn };
        });
      }
      const content = this.maybe(() => (this.chance(0.3) ? this.longText() : this.chance(0.2) ? this.value() : this.text()));
      if (content !== undefined) message.content = content;
    } else if (role === "tool") {
      message.tool_call_id = this.pick<Json>(["c1", "c2", "c3", "constructor", "missing", 3]);
      message.content = this.text();
    } else if (role === "user") {
      const content = this.chance(0.3)
        ? Array.from({ length: this.int(4) }, () => (this.chance(0.7) ? { type: "text", text: this.text() } : this.value()))
        : this.chance(0.2) ? this.longText() : this.value();
      message.content = content;
      if (this.chance(0.3)) message._turn_id = this.pick<Json>(["turn-1", "turn-3", "turn-12", "turn-0", "turn-x", "turn-99999999999999999999", 4]);
      if (this.chance(0.2)) message._input_kind = this.pick<Json>(["guide", "steer", null]);
    }
    return message;
  }

  completion(): Record<string, Json> {
    const record: Record<string, Json> = {};
    if (this.chance(0.8)) record.verified = this.pick<Json>([true, false, 1, "true", null]);
    if (this.chance(0.8)) record.summary = this.chance(0.2) ? this.longText() : (this.value() as Json);
    if (this.chance(0.5)) record.evidence = this.chance(0.7) ? Array.from({ length: this.int(4) }, () => ({ tool_call_id: "c1" })) : this.value();
    if (this.chance(0.4)) record.evidence_count = this.pick<Json>([0, 2, 7, -1, true, "3", 1.5]);
    if (this.chance(0.4)) record.status = this.pick<Json>(["verified", "unverified", "not_applicable", "incomplete", "bogus", 1]);
    if (this.chance(0.3)) record.tool_execution_status = this.pick<Json>(["succeeded", "failed", "incomplete", "not_applicable", "x"]);
    if (this.chance(0.3)) record.delivery_status = this.pick<Json>(["passed", "failed", "not_assessed", "nope"]);
    if (this.chance(0.6)) record.turn_id = this.pick<Json>(["turn-1", "turn-2", "turn-3", "turn-12", "turn-0", "x", 5, null]);
    return record;
  }

  session(): Record<string, Json> {
    const session: Record<string, Json> = {};
    if (this.chance(0.9)) session.id = this.chance(0.9) ? "80a6e495ec6243cc88b503521e93ff6e" : this.scalar();
    if (this.chance(0.9)) session.status = this.pick<Json>(["completed", "running", "needs_review", null, 3]);
    if (this.chance(0.8)) session.steps = this.pick<Json>([0, 4, 17, null, "5", 2.5]);
    if (this.chance(0.8)) session.mode = this.pick<Json>(["build", "plan", "", 0, null, ["x"], {}]);
    if (this.chance(0.9)) {
      const results: Record<string, Json> = {};
      for (const id of ["c1", "c2", "c3", "constructor", "3"]) {
        if (!this.chance(0.7)) continue;
        results[id] = this.chance(0.1) ? this.scalar() : {
          ok: this.pick<Json>([true, false, 0, 1, "", "x", null, [], [0], {}]),
          error: this.chance(0.8) ? (this.chance(0.2) ? this.longText() : this.pick(ERRORS)) : this.value(),
        };
      }
      session.results = this.chance(0.05) ? this.scalar() : results;
    }
    session.messages = Array.from({ length: this.int(14) }, () => this.message());
    if (this.chance(0.4)) session.completion_history = Array.from({ length: this.int(5) }, () => this.completion());
    if (this.chance(0.6)) session.completion = this.chance(0.1) ? {} : this.completion();
    if (this.chance(0.3)) session.pending_question = this.chance(0.3) ? this.longText() : this.value();
    return session;
  }
}
