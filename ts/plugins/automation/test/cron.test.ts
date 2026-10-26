import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/**
 * `cron.ts` and `store.ts` against values captured from the Python oracle
 * (`automation/scheduler.py`: `_field`, `cron`, `next_run`, `Automations`).
 *
 * Every literal below is Python's own output, captured once and hard-coded so
 * the suite still runs where Python is absent. The digest case rebuilds
 * Python's `json.dumps(..., sort_keys=True)` text with a serializer written
 * here, so it never reuses the implementation's own encoder.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDict, numericValue, pyJsonLoads } from "@xueness/contracts";
import { cron, cronField, nextRun, validZone } from "../src/cron.ts";
import { Automations, type WorkflowBridge } from "../src/store.ts";

/** A plan the default (structural) validator accepts. */
const plan = (name = "Fixture"): Record<string, unknown> =>
  ({ name, nodes: [{ id: "one", kind: "command", argv: ["echo", "hi"] }], concurrency: 1 });

/** The document a schedule needs, with an overridable subset. */
const document = (root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ name: "Nightly", schedule: "0 3 * * *", timezone: "UTC", enabled: true, workflow: { root, ...plan() }, ...overrides });

/** ISO text of a seconds value, for readable zone assertions. */
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** `json.dumps(value, sort_keys=True)`: `ensure_ascii=True`, separators `(', ', ': ')`. */
function pythonDumps(value: unknown): string {
  const text = (item: string): string => `"${Array.from(item).map((char) => {
    const code = char.codePointAt(0) as number;
    if (char === '"') return '\\"';
    if (char === "\\") return "\\\\";
    if (code === 0x0a) return "\\n";
    if (code === 0x0d) return "\\r";
    if (code === 0x09) return "\\t";
    if (code >= 0x20 && code < 0x7f) return char;
    if (code <= 0xffff) return "\\u" + code.toString(16).padStart(4, "0");
    const shifted = code - 0x10000;
    return "\\u" + (0xd800 + (shifted >> 10)).toString(16).padStart(4, "0")
      + "\\u" + (0xdc00 + (shifted & 0x3ff)).toString(16).padStart(4, "0");
  }).join("")}"`;
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return "[" + value.map(pythonDumps).join(", ") + "]";
  if (isDict(value)) return "{" + Object.keys(value).sort().map((key) => text(key) + ": " + pythonDumps(value[key])).join(", ") + "}";
  throw new TypeError("unsupported value");
}

/** A state directory plus an existing workspace root, removed after `body`. */
function withFixture(body: (state: string, root: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "xueness-automation-"));
  const state = join(base, "state"), root = join(base, "workspace");
  mkdirSync(root, { recursive: true });
  try { body(state, root); } finally { rmSync(base, { recursive: true, force: true }); }
}

describe("cron fields", () => {
  const sorted = (text: string, lo: number, hi: number): number[] => [...cronField(text, lo, hi)].sort((a, b) => a - b);

  it("expands *, single values, ranges, steps and comma lists", () => {
    assert.deepEqual(sorted("*", 0, 59), Array.from({ length: 60 }, (_, i) => i));
    assert.deepEqual(sorted("*/15", 0, 59), [0, 15, 30, 45]);
    assert.deepEqual(sorted("5", 0, 59), [5]);
    assert.deepEqual(sorted("0-10/3", 0, 59), [0, 3, 6, 9]);
    assert.deepEqual(sorted("1,2,3", 0, 23), [1, 2, 3]);
    assert.deepEqual(sorted("5-5", 0, 23), [5]);
    // A step of `hi + 1` is allowed and yields only the range start.
    assert.deepEqual(sorted("*/7", 0, 6), [0]);
    assert.deepEqual(sorted("*/60", 0, 59), [0]);
    assert.deepEqual(sorted("1-31/2", 1, 31), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]);
  });

  it("refuses a step outside 1..hi+1 with Python's message", () => {
    for (const [text, lo, hi] of [["*/0", 0, 59], ["*/61", 0, 59], ["*/8", 0, 6], ["*/-1", 0, 59], ["*/-0", 0, 6]] as const) {
      assert.throws(() => cronField(text, lo, hi), { name: "ValueError", message: "invalid cron step" }, text);
    }
  });

  it("refuses out-of-range values, an empty field and non-integers", () => {
    for (const text of ["60", "5-3", "0-60"]) {
      assert.throws(() => cronField(text, 0, 59), { name: "ValueError", message: "cron field out of range" }, text);
    }
    assert.throws(() => cronField("7", 0, 6), { name: "ValueError", message: "cron field out of range" });
    // `int('')` / `int('abc')` / `int('0x10')` are ValueErrors with their own wording.
    for (const text of ["", "-1", "abc", "*/x", "*/0x10"]) {
      assert.throws(() => cronField(text, 0, 59), { name: "ValueError" }, text);
    }
    // `base.split('-')` with the wrong arity raises Python's unpacking error.
    assert.throws(() => cronField("1-2-3", 0, 59), { name: "ValueError", message: "too many values to unpack (expected 2)" });
  });

  it("requires exactly five fields and at most 200 characters", () => {
    for (const bad of ["", "* * * *", "* * * * * *", "* * * * * x", "0 0 * * *" + " ".repeat(200)]) {
      assert.throws(() => cron(bad), { name: "ValueError", message: "schedule must have five cron fields" }, JSON.stringify(bad));
    }
    for (const bad of [5, null, undefined, ["* * * * *"], { schedule: "* * * * *" }]) {
      assert.throws(() => cron(bad), { name: "ValueError", message: "schedule must have five cron fields" });
    }
    // Python splits on runs of whitespace, so extra padding is fine.
    assert.equal(cron("  0   0  *  *  *  ").length, 5);
    assert.deepEqual([...cron("0\t0\n*\r* *")[0] as Set<number>], [0]);
  });
});

describe("nextRun", () => {
  // `next_run(schedule, tz, after)` captured from Python.
  const cases: readonly (readonly [string, string, number, number])[] = [
    ["* * * * *", "UTC", 1700000000, 1700000040],
    ["*/15 * * * *", "UTC", 1700000000, 1700000100],
    ["0 * * * *", "UTC", 1700000000, 1700002800],
    ["0 0 * * *", "UTC", 1700000000, 1700006400],
    ["45 23 31 12 *", "UTC", 1700000000, 1704066300],
    ["0 0 1 1 *", "UTC", 1700000000, 1704067200],
    ["0 0 29 2 *", "UTC", 1700000000, 1709164800],
    ["0 0 * * 0", "UTC", 1700000000, 1700352000],
    ["0 0 13 * 5", "UTC", 1700000000, 1700179200],
    ["0 0 30 2 1", "UTC", 1700000000, 1707091200],
    ["0 0 1-7 * 3", "UTC", 1700000000, 1700006400],
    ["0 0 * 3 *", "UTC", 1700000000, 1709251200],
    ["*/30 1-3 * * *", "UTC", 1700000000, 1700010000],
    // `after` is 2023-11-15T06:13:20+08, so Shanghai's next local midnight is the 16th.
    ["0 0 * * *", "Asia/Shanghai", 1700000000, 1700064000],
    ["0 0 * * *", "America/New_York", 1700000000, 1700024400],
    ["0 0 * * *", "Pacific/Auckland", 1700000000, 1700046000],
    ["0 0 * * *", "Asia/Kolkata", 1700000000, 1700073000],
    // The minute truncation: `after` itself never matches, the next minute may.
    ["* * * * *", "UTC", 1700000039.999999, 1700000040],
    ["*/5 * * * *", "UTC", 1700000000.5, 1700000100],
    ["*/5 * * * *", "UTC", 0, 300],
    ["*/5 * * * *", "UTC", -1, 0],
  ];

  it("matches Python on fixed schedules and zones", () => {
    for (const [schedule, tz, after, expected] of cases) {
      assert.equal(nextRun(schedule, tz, after), expected, `${schedule} ${tz} @${after}`);
    }
  });

  it("ORs day-of-month with day-of-week only when both are restricted", () => {
    const from = 1700000000; // 2023-11-14T22:13:20Z, a Tuesday
    // Both restricted: Python's `dom or dow`. Friday the 17th is nearer than
    // the 13th of December; the 15th is a Wednesday, which only OR admits.
    assert.equal(iso(nextRun("0 0 13 * 5", "UTC", from)), "2023-11-17T00:00:00.000Z");
    assert.equal(iso(nextRun("0 0 1-7 * 3", "UTC", from)), "2023-11-15T00:00:00.000Z");
    assert.equal(iso(nextRun("0 0 30 2 1", "UTC", from)), "2024-02-05T00:00:00.000Z");
    // From that Friday the OR rule moves to the next Friday, not to a 13th.
    assert.equal(iso(nextRun("0 0 13 * 5", "UTC", 1700179200)), "2023-11-24T00:00:00.000Z");
    // With `*` in one of them the other alone decides (AND).
    assert.equal(iso(nextRun("0 0 * * 5", "UTC", from)), "2023-11-17T00:00:00.000Z");
    assert.equal(iso(nextRun("0 0 13 * *", "UTC", from)), "2023-12-13T00:00:00.000Z");
  });

  it("follows the local wall clock across a DST transition", () => {
    // New York springs forward on 2024-03-10; 02:30 local does not exist.
    const before = Date.UTC(2024, 2, 9, 12, 0, 0) / 1000;
    assert.equal(iso(nextRun("30 2 * * *", "America/New_York", before)), "2024-03-11T06:30:00.000Z");
    // 01:30 local on the 10th exists and is still UTC-5.
    assert.equal(iso(nextRun("30 1 * * *", "America/New_York", before)), "2024-03-10T06:30:00.000Z");
    // Autumn falls back on 2024-11-03: 01:30 local happens twice, and the
    // first occurrence is the one a forward scan reaches.
    const autumn = Date.UTC(2024, 10, 2, 12, 0, 0) / 1000;
    assert.equal(iso(nextRun("30 1 * * *", "America/New_York", autumn)), "2024-11-03T05:30:00.000Z");
    // Lord Howe shifts by 30 minutes, which a whole-hour model would miss.
    const lh = Date.UTC(2024, 9, 5, 0, 0, 0) / 1000;
    assert.equal(iso(nextRun("15 2 * * *", "Australia/Lord_Howe", lh)), "2024-10-06T15:15:00.000Z");
  });

  it("reports a schedule that cannot occur, and an unknown zone", () => {
    for (const schedule of ["0 0 30 2 *", "0 0 31 4 *"]) {
      assert.throws(() => nextRun(schedule, "UTC", 1700000000), { name: "ValueError", message: "schedule has no occurrence in the next year" }, schedule);
    }
    assert.throws(() => nextRun("* * * * *", "Nope/Nope", 1700000000), { name: "ValueError", message: "No time zone found with key Nope/Nope" });
    assert.throws(() => nextRun("* * * * *", "", 1700000000), { name: "ValueError" });
  });
});

describe("validZone", () => {
  it("accepts the zone database's keys and refuses the rest", () => {
    for (const tz of ["UTC", "Etc/UTC", "Asia/Shanghai", "America/New_York", "Australia/Lord_Howe", "Etc/GMT+5"]) {
      assert.equal(validZone(tz), tz);
    }
    for (const tz of ["Nope/Nope", "localtime", "UTC+5", "+05:00", "right/UTC"]) {
      assert.throws(() => validZone(tz), { name: "ValueError", message: `No time zone found with key ${tz}` }, tz);
    }
    for (const tz of [null, 5, true, ["UTC"]]) {
      assert.throws(() => validZone(tz), { name: "ValueError", message: "invalid timezone" });
    }
  });
});

describe("Automations", () => {
  it("starts empty and persists one schedule atomically", () => withFixture((state, root) => {
    const store = new Automations(state);
    assert.equal(store.path, join(state, "automations.json"));
    assert.deepEqual(store.list(), []);
    const saved = store.save(document(root));
    assert.match(String(saved.id), /^[a-f0-9]{32}$/);
    assert.match(String(saved.digest), /^[a-f0-9]{64}$/);
    assert.deepEqual(
      { name: saved.name, timezone: saved.timezone, enabled: saved.enabled, approvalRequired: saved.approvalRequired, approved: saved.approved, allowReal: saved.allowReal, history: saved.history },
      { name: "Nightly", timezone: "UTC", enabled: true, approvalRequired: true, approved: false, allowReal: false, history: [] },
    );
    // `time.time()` is a float in Python, so the value is an integral float.
    assert.equal(typeof numericValue(saved.nextRunAt), "number");
    assert.equal((saved.workflow as Record<string, unknown>).root, root);
    assert.deepEqual(store.list(), [saved]);
    // Written with `json.dump(..., ensure_ascii=False, indent=2)`.
    const text = readFileSync(join(state, "automations.json"), "utf8");
    assert.equal(text.startsWith("[\n  {"), true);
    assert.equal(text.includes('"approvalRequired": true'), true);
  }));

  it("defaults name, timezone and enabled exactly as Python does", () => withFixture((state, root) => {
    const saved = new Automations(state).save({ schedule: "0 3 * * *", workflow: { root, ...plan() } });
    assert.deepEqual([saved.name, saved.timezone, saved.enabled, saved.schedule], ["Automation", "UTC", false, "0 3 * * *"]);
  }));

  it("refuses invalid documents with Python's messages", () => withFixture((state, root) => {
    const store = new Automations(state);
    for (const bad of [null, 5, "x", ["a"], true]) {
      assert.throws(() => store.save(bad), { name: "ValueError", message: "automation must be an object" });
    }
    const message = "invalid name or enabled state";
    for (const name of ["", "   ", 5, null, "x".repeat(121)]) {
      assert.throws(() => store.save(document(root, { name })), { name: "ValueError", message }, JSON.stringify(name));
    }
    for (const enabled of [1, 0, "true", null]) {
      assert.throws(() => store.save(document(root, { enabled })), { name: "ValueError", message });
    }
    assert.throws(() => store.save(document(root, { timezone: 5 })), { name: "ValueError", message: "invalid timezone" });
    assert.throws(() => store.save(document(root, { timezone: "Nope/Nope" })), { name: "ValueError", message: "No time zone found with key Nope/Nope" });
    for (const workflow of [{}, { root: 5, ...plan() }, plan()]) {
      assert.throws(() => store.save(document(root, { workflow })), { name: "ValueError", message: "workflow root required" });
    }
    assert.throws(() => store.save(document(join(root, "absent"))), { name: "ValueError", message: "workflow root must exist" });
    // An existing file is not a directory.
    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    assert.throws(() => store.save(document(file)), { name: "ValueError", message: "workflow root must exist" });
    assert.deepEqual(store.list(), []);
  }));

  it("keeps the digest stable and drops approval on amendment", () => withFixture((state, root) => {
    const store = new Automations(state);
    const saved = store.save(document(root));
    const first = saved.digest;
    assert.equal(store.approve(saved.id as string, true).approved, true);
    // Re-saving the identical document keeps the digest and the approval.
    const again = store.save(document(root), saved.id as string);
    assert.deepEqual({ digest: again.digest, approved: again.approved, allowReal: again.allowReal }, { digest: first, approved: true, allowReal: true });
    // A different plan changes the digest and clears the approval, but
    // `allowReal` survives: Python carries it unconditionally.
    const amended = store.save(document(root, { workflow: { root, ...plan("Other") } }), saved.id as string);
    assert.notEqual(amended.digest, first);
    assert.deepEqual({ approved: amended.approved, allowReal: amended.allowReal }, { approved: false, allowReal: true });
    // A different root changes the digest too.
    const other = join(state, "..", "other");
    mkdirSync(other, { recursive: true });
    assert.notEqual(store.save(document(other), saved.id as string).digest, amended.digest);
  }));

  it("matches the digest Python computes", () => withFixture((state, root) => {
    const store = new Automations(state);
    const saved = store.save(document(root));
    // `sha256(json.dumps({'root': str(root), 'plan': plan}, sort_keys=True))`
    // with the defaults `ensure_ascii=True` and separators `(', ', ': ')`.
    const validated = { concurrency: 1, name: "Fixture", nodes: [{ argv: ["echo", "hi"], id: "one", kind: "command" }] };
    const body = pythonDumps({ plan: validated, root });
    assert.equal(body.startsWith('{"plan": {"concurrency": 1, "name": "Fixture", "nodes": ['), true);
    assert.equal(body.endsWith(`}]}, "root": ${pythonDumps(root)}}`), true);
    assert.equal(saved.digest, createHash("sha256").update(body, "utf8").digest("hex"));
    // A non-ASCII name is escaped as `\uXXXX`, so the digest is byte-stable.
    assert.match(pythonDumps({ plan: { name: "Nïghtly ✓" }, root: "." }), /\\u00ef/);
    assert.match(String(store.save(document(root, { workflow: { root, ...plan("Nïghtly ✓") } })).digest), /^[a-f0-9]{64}$/);
  }));

  it("updates by id, refuses an unknown id, and caps the list", () => withFixture((state, root) => {
    const store = new Automations(state);
    const saved = store.save(document(root));
    assert.throws(() => store.save(document(root), "0".repeat(32)), { name: "ValueError", message: "automation not found" });
    // The merge keeps the stored fields the update did not mention.
    const renamed = store.save({ name: "Renamed" }, saved.id as string);
    assert.deepEqual(
      { name: renamed.name, schedule: renamed.schedule, timezone: renamed.timezone, root: (renamed.workflow as Record<string, unknown>).root },
      { name: "Renamed", schedule: "0 3 * * *", timezone: "UTC", root },
    );
    for (let index = 1; index < 100; index += 1) store.save(document(root, { name: `N${index}` }));
    assert.equal(store.list().length, 100);
    assert.throws(() => store.save(document(root, { name: "Over" })), { name: "ValueError", message: "automations capped at 100" });
  }));

  it("deletes by id and reports the id back", () => withFixture((state, root) => {
    const store = new Automations(state);
    const saved = store.save(document(root));
    assert.deepEqual(store.delete(saved.id as string), { deleted: saved.id });
    assert.deepEqual(store.list(), []);
    // Deleting an absent id is not an error: Python filters the list.
    assert.deepEqual(store.delete("0".repeat(32)), { deleted: "0".repeat(32) });
  }));

  it("refuses a malformed or oversized state file", () => withFixture((state, root) => {
    const store = new Automations(state);
    const path = join(state, "automations.json");
    mkdirSync(state, { recursive: true });
    for (const text of ["{}", "5"]) {
      writeFileSync(path, text);
      assert.throws(() => store.list(), { name: "ValueError", message: "invalid automation state" }, text);
    }
    writeFileSync(path, "{not json");
    assert.throws(() => store.list(), { name: "ValueError" });
    writeFileSync(path, "[" + " ".repeat(2_000_001) + "]");
    assert.throws(() => store.list(), { name: "ValueError", message: "automation state too large" });
    writeFileSync(path, JSON.stringify([document(root)]));
    assert.equal(store.list().length, 1);
    assert.equal(Array.isArray(pyJsonLoads(readFileSync(path, "utf8"))), true);
  }));

  it("claims a due schedule, advances it and settles the history", () => withFixture((state, root) => {
    const store = new Automations(state);
    const saved = store.save(document(root));
    const id = saved.id as string, next = numericValue(saved.nextRunAt) as number, bridge = fakeBridge();
    // Not due yet: the stored `nextRunAt` is in the future.
    assert.equal(store.run(id, { due: true, now: next - 60, bridge }), null);
    assert.deepEqual(store.list()[0]?.history, []);
    // Due now, but unapproved: the run is created and left for review.
    const result = store.run(id, { due: true, now: next, bridge });
    assert.equal(result?.status, "awaiting_approval");
    assert.equal(typeof result?.workflowId, "string");
    assert.deepEqual({ created: bridge.created.length, launched: bridge.launched.length }, { created: 1, launched: 0 });
    const after = store.list()[0] as Record<string, unknown>;
    assert.equal((numericValue(after.nextRunAt) as number) > next, true);
    assert.deepEqual(after.history, [result]);
    // A disabled schedule never fires, even when its time has come.
    store.save({ enabled: false }, id);
    assert.equal(store.run(id, { due: true, now: 9e9, bridge }), null);
  }));

  it("launches an approved schedule only when the host allows a real provider", () => withFixture((state, root) => {
    const store = new Automations(state);
    const saved = store.save(document(root));
    const id = saved.id as string, bridge = fakeBridge();
    // `allowReal: false` means no real provider is involved, so the host's
    // switch does not matter and the run launches.
    store.approve(id, false);
    assert.equal(store.run(id, { due: true, now: numericValue(saved.nextRunAt) as number, bridge, allowRealHost: false })?.status, "started");
    assert.equal(bridge.launched.length, 1);
    // `allowReal: true` without the host's permission stays unlaunched.
    const second = store.save(document(root, { schedule: "0 4 * * *" }), id);
    store.approve(id, true);
    assert.equal(store.run(id, { due: true, now: numericValue(second.nextRunAt) as number, bridge, allowRealHost: false })?.status, "awaiting_approval");
    assert.equal(bridge.launched.length, 1);
    // `due: false` fires regardless of the schedule, and the host's switch
    // then decides whether the real provider may be used.
    assert.equal(store.run(id, { due: false, bridge, allowRealHost: true })?.status, "started");
    assert.equal(bridge.launched.length, 2);
  }));

  it("records a failed launch instead of throwing", () => withFixture((state, root) => {
    const store = new Automations(state);
    const saved = store.save(document(root));
    const boom = (): never => { throw new Error("boom"); };
    const result = store.run(saved.id as string, { due: false, bridge: { create: boom, launch: boom, control: boom, load: boom, list: () => [] } });
    assert.deepEqual({ status: result?.status, error: result?.error }, { status: "failed", error: "workflow launch failed" });
    assert.deepEqual((store.list()[0]?.history as Record<string, unknown>[])[0], result);
  }));

  it("refuses a run or approval of an unknown id", () => withFixture((state) => {
    const store = new Automations(state), missing = "0".repeat(32), found = { name: "ValueError", message: "automation not found" };
    assert.throws(() => store.run(missing, { due: false, bridge: fakeBridge() }), found);
    assert.throws(() => store.approve(missing), found);
  }));
});

/** A bridge that records what it was asked to do and returns a fresh run id. */
function fakeBridge(): WorkflowBridge & { created: unknown[]; launched: unknown[] } {
  const created: unknown[] = [], launched: unknown[] = [];
  let counter = 0;
  return {
    created, launched,
    create(plan: unknown, root: string) {
      created.push({ plan, root });
      counter += 1;
      return { id: "a".repeat(31) + String(counter % 10), status: "created", plan, root };
    },
    launch(wid: string, approved?: boolean, allowReal?: boolean) {
      launched.push({ wid, approved, allowReal });
      return { id: wid, status: "queued" };
    },
    control(wid: string) { return { id: wid }; },
    load(wid: string) { return { id: wid }; },
    list() { return []; },
  };
}