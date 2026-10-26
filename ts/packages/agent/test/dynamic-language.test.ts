/**
 * F10.01 — the published dynamic-workflow language and type contract. Every
 * entry on the published surface must compile AND evaluate for a public
 * compatible sample; ambient TS/Node powers stay rejected at compile time;
 * ask<T> type annotations synthesize JSON schemas; the diagnostic registry
 * matches what the compiler and evaluator actually emit.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DYNAMIC_DIAGNOSTICS,
  DYNAMIC_LANGUAGE,
  DYNAMIC_LANGUAGE_VERSION,
  describeDynamicLanguage,
  compileDynamicWorkflow,
  evaluateDynamicWorkflow,
  type CompiledDynamicWorkflow,
  type DynamicScriptHost,
} from "../src/index.ts";

interface HostEvent { kind: string; [key: string]: unknown }

function recordingHost(events: HostEvent[]): DynamicScriptHost {
  return {
    createActor: (siteId, name, persona) => ({
      id: siteId,
      ...(name === undefined ? {} : { name }),
      persona: typeof persona === "string" ? { system: persona } : persona ?? {},
    }),
    ask: async (siteId, actor, instructions) => {
      events.push({ kind: "ask", siteId, name: actor.name ?? null, instructions });
      return { answer: `a:${instructions}` };
    },
    read: async (siteId, operation, args) => {
      events.push({ kind: operation, args });
      return operation === "files.read" ? `content:${String(args[0])}` : ["one.txt", "two.txt"];
    },
    report: (siteId, item) => { events.push({ kind: "report", siteId, item }); },
    log: (message) => { events.push({ kind: "log", message }); },
    phase: (name) => { events.push({ kind: "phase", name }); },
    hole: async (siteId, name) => { events.push({ kind: "hole", name }); return `filled:${name}`; },
  };
}

/** Compiles a compatible sample (asserting zero diagnostics), then evaluates it. */
async function run(source: string, args?: unknown): Promise<{ value: unknown; events: HostEvent[]; compiled: CompiledDynamicWorkflow }> {
  const compiled = compileDynamicWorkflow(source);
  assert.deepEqual(compiled.diagnostics, [], "a public compatible sample must compile without diagnostics");
  const events: HostEvent[] = [];
  const raw = await evaluateDynamicWorkflow(compiled, recordingHost(events), args === undefined ? {} : { args });
  // Script object literals carry a null prototype by design; normalize for deepEqual.
  const value = raw === null || typeof raw !== "object" ? raw : (JSON.parse(JSON.stringify(raw)) as unknown);
  return { value, events, compiled };
}

/** First diagnostic code for a source that must be rejected. */
function rejectionOf(source: string): { code: string; line: number; column: number } {
  const compiled = compileDynamicWorkflow(source);
  const first = compiled.diagnostics[0];
  assert.ok(first, `expected at least one diagnostic for:\n${source}`);
  return { code: first.code, line: first.line, column: first.column };
}

describe("F10.01 published statement surface", () => {
  it("compiles and evaluates the classic loop statements", async () => {
    const { value } = await run(`
      let acc = 0;
      for (let i = 0; i < 4; i += 1) { if (i === 2) continue; acc += i; }
      let chars = '';
      for (const ch of 'ab') { chars += ch; }
      let n = 0;
      while (n < 3) { n += 1; }
      let guard = 0;
      do { guard += 1; } while (guard < 2);
      let letters: string[] = [];
      for (const ch of ['x', 'y']) { letters = letters.concat([ch]); }
      return { acc, chars, n, guard, letters };
    `);
    assert.deepEqual(value, { acc: 4, chars: "ab", n: 3, guard: 2, letters: ["x", "y"] });
  });

  it("supports declarations, destructuring, control flow, switch, and empty statements", async () => {
    const { value } = await run(`
      const [head, ...tail] = [1, 2, 3];
      const { name, tags = [], ...rest } = { name: 'w', tags: ['t'], extra: 2 };
      let total = head + tail.length;
      const note: { first: string } = { first: 'a' };
      if (total > 2) total += 10; else total = 0;
      let label = '';
      switch (total) {
        case 13: label = 'thirteen'; break;
        default: label = 'other';
      }
      for (const t of tags) { label += ':' + t; }
      ;
      return { total, label, name, rest, note };
    `);
    assert.deepEqual(value, { total: 13, label: "thirteen:t", name: "w", rest: { extra: 2 }, note: { first: "a" } });
  });

  it("returns from inside switch and loops via break/continue", async () => {
    const early = await run(`
      for (const item of [1, 2, 3]) {
        if (item === 2) return 'early';
      }
      return 'late';
    `);
    assert.equal(early.value, "early");
    const skipped = await run(`
      let seen = 0;
      while (true) { seen += 1; if (seen >= 2) break; }
      do { seen += 10; } while (false);
      return seen;
    `);
    assert.equal(skipped.value, 12);
  });
});

describe("F10.01 published expression and operator surface", () => {
  it("evaluates literals, templates, spreads, access, optional chaining and casts", async () => {
    const { value } = await run(`
      const base = { a: 1, b: 'two' };
      const merged = { ...base, c: true };
      const list = [0, ...[1, 2], 3];
      const nested = { deep: { value: 7 } };
      const missing = nested.absent?.deep ?? 'fallback';
      const template = \`v=\${merged.a + list[3]}\`;
      const erased = nested as { deep: { value: number } };
      const frozen = [1, 2] as const;
      const satisfied = base satisfies typeof base;
      const element = list[list.length - 1];
      const comma = (0, 1, 2);
      const ternary = merged.a > 0 ? 'yes' : 'no';
      return { merged, list, missing, template, erasedDeep: erased.deep.value, frozenLen: frozen.length, element, comma, ternary, satisfied };
    `);
    assert.deepEqual(value, {
      merged: { a: 1, b: "two", c: true },
      list: [0, 1, 2, 3],
      missing: "fallback",
      template: "v=4",
      erasedDeep: 7,
      frozenLen: 2,
      element: 3,
      comma: 2,
      ternary: "yes",
      satisfied: { a: 1, b: "two" },
    });
  });

  it("evaluates the documented operator set", async () => {
    const { value } = await run(`
      let x = 4;
      x += 3; x -= 1; x *= 2; x /= 3; x %= 5; x **= 2;
      let logical: number | null = null;
      logical &&= 1; logical ||= 9; logical ??= 100;
      const arithmetic = (2 + 3) * 4 - 6 / 3 % 4 + 2 ** 3;
      const comparisons = [1 < 2, 2 <= 2, 3 > 2, 3 >= 4, 1 == '1', 1 === 1, 1 != 2, 1 !== 1];
      const booleanOps = [true && false, false || true, null ?? 'd'];
      const own = 'a' in { a: 1 };
      const unary = [!0, +true, -'2', ~0, typeof 's', void 0];
      let counter = 1;
      const post = counter++;
      const pre = ++counter;
      return { x, logical, arithmetic, comparisons, booleanOps, own, unary, post, pre };
    `);
    assert.deepEqual(value, {
      x: 16,
      logical: 9,
      arithmetic: 26,
      comparisons: [true, true, true, false, true, true, true, false],
      booleanOps: [false, true, "d"],
      own: true,
      unary: [true, 1, -2, -1, "string", null],
      post: 1,
      pre: 3,
    });
  });

  it("evaluates arrow callbacks inside map/filter with values and index", async () => {
    const { value } = await run(`
      const values = [1, 2, 3, 4];
      const doubled = values.map((v) => v * 2);
      const indexed = values.map((v, i) => v + i);
      const evens = values.filter((v) => v % 2 === 0);
      const piped = values.map((v) => v).filter((v) => v > 2);
      return { doubled, indexed, evens, piped };
    `);
    assert.deepEqual(value, { doubled: [2, 4, 6, 8], indexed: [1, 3, 5, 7], evens: [2, 4], piped: [3, 4] });
  });
});

describe("F10.01 published value and workflow call surface", () => {
  it("serves every documented value helper", async () => {
    const { value } = await run(`
      const parsed = JSON.parse('{"n":1}');
      const text = JSON.stringify({ ok: true, list: [1, 'a'] });
      const math = [Math.min(3, 1, 2), Math.max(3, 1), Math.round(1.6), Math.floor(1.9), Math.ceil(1.1), Math.abs(-4)];
      const conversions = [String(7), Number('12'), Boolean('')];
      const array = [1, 2, 3].map((v) => v).join('-');
      const includes = [1, 2].includes(2);
      const sliced = [1, 2, 3].slice(1);
      const concatenated = [1].concat([2], 3);
      const chained = ' A-B '.trim().toLowerCase().split('-').join('_');
      const strOps = ['abc'.slice(1), 'abc'.includes('b'), 'ABC'.toLowerCase(), 'abc'.toUpperCase()];
      return { parsed, text, math, conversions, array, includes, sliced, concatenated, chained, strOps };
    `);
    assert.deepEqual(value, {
      parsed: { n: 1 },
      text: '{"ok":true,"list":[1,"a"]}',
      math: [1, 3, 2, 1, 2, 4],
      conversions: ["7", 12, false],
      array: "1-2-3",
      includes: true,
      sliced: [2, 3],
      concatenated: [1, 2, 3],
      chained: "a_b",
      strOps: ["bc", true, "abc", "ABC"],
    });
  });

  it("routes every workflow call through the host ports", async () => {
    const { value, events } = await run(`
      const reviewer = agent('reviewer', { system: 'be brief', model: 'm1' });
      const unnamed = agent();
      phase('gather');
      const first = await reviewer.ask('summarize');
      const second = await ask(unnamed, 'expand');
      const paths = await files.glob('src/**');
      const content = await files.read(paths[0]);
      const filled = await hole('gap', 'what next?');
      report({ first, second, content, filled });
      log('complete');
      return [first, second, content, filled];
    `);
    assert.deepEqual(value, [
      { answer: "a:summarize" },
      { answer: "a:expand" },
      "content:one.txt",
      "filled:gap",
    ]);
    const kinds = events.map((event) => event.kind);
    assert.deepEqual(kinds, ["phase", "ask", "ask", "files.glob", "files.read", "hole", "report", "log"]);
    const report = events.find((event) => event.kind === "report");
    assert.equal(report?.siteId, "report#1");
    const ask = events.find((event) => event.kind === "ask");
    assert.equal(ask?.name, "reviewer");
  });

  it("exposes args and Promise.all fan-out", async () => {
    const { value } = await run(`
      const actor = agent('fan');
      const results = await Promise.all([actor.ask('q1'), actor.ask('q2'), 'plain']);
      return { seed: args.seed, results };
    `, { seed: 42 });
    assert.deepEqual(value, { seed: 42, results: [{ answer: "a:q1" }, { answer: "a:q2" }, "plain"] });
  });

  it("records call sites with stable ids and duplicate-actor detection", () => {
    const compiled = compileDynamicWorkflow(`
      const a = agent('dup');
      const b = agent('dup');
      a.ask('x');
      report(1);
    `);
    assert.deepEqual(compiled.diagnostics.map((d) => d.code), ["DYN_DUPLICATE_ACTOR_NAME"]);
    assert.deepEqual(compiled.sites.map((site) => `${site.kind}:${site.id}:${site.name ?? ""}`), [
      "actor:actor#1:dup",
      "actor:actor#2:dup",
      "ask:ask#1:",
      "report:report#1:",
    ]);
  });
});

describe("F10.01 ambient capabilities stay unavailable", () => {
  it("rejects every forbidden global at compile time", () => {
    for (const global of DYNAMIC_LANGUAGE.forbidden.globals) {
      const source = `const value = ${global};\nreport(value);\n`;
      assert.equal(rejectionOf(source).code, "DYN_FORBIDDEN_GLOBAL", `global '${global}' must be rejected`);
    }
  });

  it("rejects forbidden properties on access, element access, and object keys", () => {
    assert.equal(rejectionOf("const c = ({}).constructor;").code, "DYN_FORBIDDEN_PROPERTY");
    assert.equal(rejectionOf("const p = {}['prototype'];").code, "DYN_FORBIDDEN_PROPERTY");
    assert.equal(rejectionOf("const o = { __proto__: 1 };").code, "DYN_FORBIDDEN_PROPERTY");
  });

  it("rejects statements, calls, and type powers outside the surface", () => {
    assert.equal(rejectionOf("class Thing {}").code, "DYN_UNSUPPORTED_SYNTAX");
    assert.equal(rejectionOf("try { report(1); } catch (e) { }").code, "DYN_UNSUPPORTED_SYNTAX");
    assert.equal(rejectionOf("throw new Error('x');").code, "DYN_UNSUPPORTED_SYNTAX");
    assert.equal(rejectionOf("outer: for (const a of [1]) { break outer; }").code, "DYN_UNSUPPORTED_SYNTAX");
    assert.equal(rejectionOf("const fn = (x) => x;").code, "DYN_UNSUPPORTED_SYNTAX");
    assert.equal(rejectionOf("const v = [1].push(2);").code, "DYN_UNSUPPORTED_CALL");
    assert.equal(rejectionOf("const t = setTimeout(() => 0, 1);").code, "DYN_UNSUPPORTED_CALL");
    assert.equal(rejectionOf("const d: Date = new Date();").code, "DYN_UNSUPPORTED_TYPE");
    assert.equal(rejectionOf("const a: any = 1;").code, "DYN_UNSUPPORTED_TYPE");
    assert.equal(rejectionOf("const f: () => void = () => 1;").code, "DYN_UNSUPPORTED_TYPE");
    assert.equal(rejectionOf("const u: unknown = 1;").code, "DYN_UNSUPPORTED_TYPE");
  });

  it("rejects sources outside the length window and parse failures", () => {
    assert.equal(rejectionOf("").code, "DYN_SOURCE_LENGTH");
    assert.equal(rejectionOf("x".repeat(32_001)).code, "DYN_SOURCE_LENGTH");
    assert.ok(rejectionOf("const = ;").code.startsWith("TS"));
  });

  it("blocks escape attempts at evaluation time even when parseable", async () => {
    const compiled = compileDynamicWorkflow("const v = Object;");
    assert.equal(compiled.diagnostics.length, 0, "unknown identifiers only fail at evaluation");
    await assert.rejects(
      evaluateDynamicWorkflow(compiled, recordingHost([]), {}),
      /unknown identifier 'Object'/,
    );
    const constant = compileDynamicWorkflow("const fixed = 1;\nfixed = 2;");
    assert.equal(constant.diagnostics.length, 0);
    await assert.rejects(
      evaluateDynamicWorkflow(constant, recordingHost([]), {}),
      (error: unknown) => (error as { code?: string }).code === "DYNAMIC_ASSIGNMENT",
    );
    const handle = compileDynamicWorkflow("const a = agent();\nreport(a.id);\n");
    await assert.rejects(
      evaluateDynamicWorkflow(handle, recordingHost([]), {}),
      (error: unknown) => (error as { code?: string }).code === "DYNAMIC_PROPERTY",
    );
  });

  it("enforces the operation budget on unbounded scripts", async () => {
    const compiled = compileDynamicWorkflow("let i = 0;\nwhile (true) { i += 1; }");
    assert.equal(compiled.diagnostics.length, 0);
    await assert.rejects(
      evaluateDynamicWorkflow(compiled, recordingHost([]), { maxOperations: 500 }),
      (error: unknown) => (error as { code?: string }).code === "DYNAMIC_BUDGET",
    );
  });
});

describe("F10.01 ask<T> type contract and schema synthesis", () => {
  it("synthesizes JSON schemas from interfaces, literals, unions, records and arrays", () => {
    const compiled = compileDynamicWorkflow(`
      interface Answer { summary: string; score: number; tags?: string[]; state: 'draft' | 'ready' }
      type Detail = { note: string; extra: Record<string, number>; ids: Array<string> }
      const actor = agent('typed');
      const a = await actor.ask<Answer>('q1');
      const b = await ask<Detail>(actor, 'q2');
      const c = await actor.ask('untyped');
    `);
    assert.deepEqual(compiled.diagnostics, []);
    const codes = [...compiled.schemas.values()];
    assert.equal(codes.length, 2);
    assert.deepEqual(codes[0], {
      type: "object",
      properties: {
        summary: { type: "string" },
        score: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        state: { type: "string", enum: ["draft", "ready"] },
      },
      required: ["summary", "score", "state"],
      additionalProperties: false,
    });
    assert.deepEqual(codes[1], {
      type: "object",
      properties: {
        note: { type: "string" },
        extra: { type: "object", additionalProperties: { type: "number" } },
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["note", "extra", "ids"],
      additionalProperties: false,
    });
  });

  it("resolves interface extension, optional members, and nested object types", () => {
    const compiled = compileDynamicWorkflow(`
      interface Base { id: string }
      interface Extended extends Base { label?: string; nested: { flag: boolean } }
      const actor = agent('ext');
      const result = await actor.ask<Extended>('q');
    `);
    assert.deepEqual(compiled.diagnostics, []);
    const schema = [...compiled.schemas.values()][0];
    assert.deepEqual(schema, {
      type: "object",
      properties: {
        id: { type: "string" },
        label: { type: "string" },
        nested: { type: "object", properties: { flag: { type: "boolean" } }, required: ["flag"], additionalProperties: false },
      },
      required: ["id", "nested"],
      additionalProperties: false,
    });
  });

  it("rejects unsupported, circular, and unknown ask<T> types with diagnostics", () => {
    assert.equal(rejectionOf("const a = agent();\nconst v = await a.ask<any>('q');").code, "DYN_UNSUPPORTED_TYPE");
    assert.equal(rejectionOf("const a = agent();\nconst v = await a.ask<Missing>('q');").code, "DYN_UNSUPPORTED_TYPE");
    const circular = compileDynamicWorkflow(`
      interface Loop { next: Loop }
      const a = agent();
      const v = await a.ask<Loop>('q');
    `);
    assert.ok(circular.diagnostics.some((d) => d.code === "DYN_UNSUPPORTED_TYPE"), "circular types must be rejected");
    const multi = compileDynamicWorkflow("const a = agent();\nconst v = await a.ask<string, number>('q');");
    assert.equal(multi.diagnostics[0]?.code, "DYN_UNSUPPORTED_TYPE");
  });

  it("passes synthesized schemas to the host ask port", async () => {
    const seen: unknown[] = [];
    const host: DynamicScriptHost = recordingHost([]);
    const proxy: DynamicScriptHost = {
      ...host,
      ask: async (siteId, actor, instructions, schema) => { seen.push(schema); return {}; },
    };
    const compiled = compileDynamicWorkflow(`
      interface Plan { step: string }
      const a = agent('schema');
      await a.ask<Plan>('plan');
      await a.ask('free');
    `);
    await evaluateDynamicWorkflow(compiled, proxy, {});
    assert.deepEqual(seen, [
      { type: "object", properties: { step: { type: "string" } }, required: ["step"], additionalProperties: false },
      undefined,
    ]);
  });
});

describe("F10.01 published surface and diagnostic registry", () => {
  it("describes the language for hosts", () => {
    const text = describeDynamicLanguage();
    assert.ok(text.startsWith(`dynamic workflow language ${DYNAMIC_LANGUAGE_VERSION}`));
    for (const section of ["statements:", "expressions:", "operators:", "calls:", "globals:", "unavailable globals:", "blocked properties:"]) {
      assert.ok(text.includes(section), `description must include '${section}'`);
    }
    assert.equal(DYNAMIC_LANGUAGE.version, DYNAMIC_LANGUAGE_VERSION);
    for (const key of ["statements", "expressions", "operators", "spread", "destructuring", "calls", "namespaces", "globals", "typeAnnotations"] as const) {
      assert.ok(DYNAMIC_LANGUAGE[key].length > 0, `surface '${key}' must list entries`);
    }
  });

  it("keeps the registry in sync with codes actually emitted by the modules", () => {
    const scriptDir = join(import.meta.dirname, "../src/script");
    const emitted = new Set<string>();
    for (const file of readdirSync(scriptDir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(scriptDir, file), "utf8");
      for (const match of source.matchAll(/["'`](DYN[A-Z_]+)["'`]/g)) emitted.add(match[1]!);
    }
    const registry = new Set(DYNAMIC_DIAGNOSTICS.map((entry) => entry.code));
    assert.equal(registry.size, DYNAMIC_DIAGNOSTICS.length, "diagnostic codes must be unique");
    for (const code of emitted) {
      assert.ok(registry.has(code), `code ${code} is emitted by the modules but missing from DYNAMIC_DIAGNOSTICS`);
    }
    for (const code of registry) {
      assert.ok(emitted.has(code), `registry code ${code} is never emitted by any module`);
    }
    for (const entry of DYNAMIC_DIAGNOSTICS) {
      assert.ok(entry.description.length > 0);
      assert.ok(entry.phase === "compile" || entry.phase === "evaluate");
    }
  });
});
