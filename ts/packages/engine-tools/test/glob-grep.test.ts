import assert from "node:assert/strict";
import { mkdir, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { compileGlob, encodeText, expandBraces, globTool, grepTool, listTool, walkFiles } from "../src/index.ts";
import { workspace } from "./helpers.ts";

const ws = workspace();
after(() => ws.dispose());

before(async () => {
  await ws.put(".gitignore", "dist/\n*.log\n!keep.log\n");
  await ws.put("src/app.ts", "export const app = 1;\n// TODO: wire up\n");
  await ws.put("src/lib/util.ts", "export function helper() {\n  return 42;\n}\n// todo lower\n");
  await ws.put("src/lib/util.test.ts", "import { helper } from './util';\n");
  await ws.put("src/view.tsx", "const view = <div/>;\n");
  await ws.put("docs/readme.md", "# Title\nTODO docs\n");
  await ws.put("dist/bundle.js", "TODO in build output\n");
  await ws.put("node_modules/pkg/index.ts", "TODO in dependency\n");
  await ws.put("debug.log", "TODO in log\n");
  await ws.put("keep.log", "kept log\n");
  await ws.put("legacy/gbk.txt", encodeText("中文注释：待办事项\nTODO 中文\n", "gbk"));
  await ws.put("assets/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x54, 0x4f, 0x44, 0x4f]));
  const old = new Date("2020-01-01T00:00:00Z");
  await utimes(ws.path("src/app.ts"), old, old);
  await utimes(ws.path("src/lib/util.ts"), new Date("2021-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z"));
});

describe("glob patterns", () => {
  it("compile *, ?, **, classes and braces", () => {
    const cases: [string, string, boolean][] = [
      ["*.ts", "a.ts", true], ["*.ts", "deep/dir/a.ts", true], ["*.ts", "a.tsx", false],
      ["src/*.ts", "src/a.ts", true], ["src/*.ts", "src/lib/a.ts", false], ["src/**/*.ts", "src/a.ts", true],
      ["src/**/*.ts", "src/x/y/a.ts", true], ["src/**", "src/x/y", true], ["**/test/*.py", "test/a.py", true],
      ["*.{ts,tsx}", "a/b.tsx", true], ["{src,docs}/**/*.md", "docs/r.md", true], ["file?.txt", "file1.txt", true],
      ["file?.txt", "file10.txt", false], ["[ab]*.js", "b1.js", true], ["[!ab]*.js", "b1.js", false], ["./src/*.ts", "src/a.ts", true],
    ];
    for (const [pattern, path, expected] of cases) assert.equal(compileGlob(pattern, { ignoreCase: false }).test(path), expected, `${pattern} ~ ${path}`);
    assert.deepEqual(expandBraces("a{b,c{d,e}}f").sort(), ["abf", "acdf", "acef"]);
    assert.deepEqual(expandBraces("lit{x}"), ["lit{x}"]);
  });
});

describe("glob", () => {
  it("lists matches newest first and skips ignored and dependency directories", async () => {
    const result = await ws.run(globTool, { pattern: "*.ts" });
    assert.equal(result.ok, true, result.output);
    assert.deepEqual(result.data?.files, ["src/lib/util.test.ts", "src/lib/util.ts", "src/app.ts"]);
    const all = await ws.run(globTool, { pattern: "**/*.{ts,js}", include_ignored: true });
    assert.ok(all.data?.files.includes("node_modules/pkg/index.ts"));
    assert.ok(all.data?.files.includes("dist/bundle.js"));
    const logs = await ws.run(globTool, { pattern: "*.log" });
    assert.deepEqual(logs.data?.files, ["keep.log"]);
  });

  it("searches below a path, explains empty results and caps output", async () => {
    const scoped = await ws.run(globTool, { pattern: "*.ts", path: "src/lib" });
    assert.deepEqual(scoped.data?.files.sort(), ["src/lib/util.test.ts", "src/lib/util.ts"]);
    const none = await ws.run(globTool, { pattern: "*.rs" });
    assert.match(none.output, /^No files match "\*\.rs" in \.\. Ignored files/);
    const capped = await ws.run(globTool, { pattern: "**", limit: 2 });
    assert.equal(capped.data?.truncated, true);
    assert.match(capped.output, /\[showing 2 of \d+ matches/);
    assert.equal((await ws.run(globTool, { pattern: "../*.ts" })).error?.code, "invalid_argument");
    assert.equal((await ws.run(globTool, { pattern: "/etc/*" })).error?.code, "invalid_argument");
    assert.equal((await ws.run(globTool, { pattern: "*", path: "src/app.ts" })).error?.code, "not_a_directory");
  });

  it("walks deep and wide trees breadth-first without following symlinked directories", async () => {
    let deep = "deep";
    for (let level = 0; level < 200; level += 1) deep += "/d";
    await ws.put(`${deep}/bottom.txt`, "x");
    await symlink(ws.root, ws.path("deep/loop"), process.platform === "win32" ? "junction" : "dir");
    const wide = ws.path("wide");
    await mkdir(wide);
    await Promise.all(Array.from({ length: 3000 }, (_, index) => ws.put(`wide/f${index}.dat`, "")));
    const started = performance.now();
    const result = await ws.run(globTool, { pattern: "bottom.txt" });
    assert.deepEqual(result.data?.files, [`${deep}/bottom.txt`]);
    const walk = await walkFiles(ws.root);
    assert.equal(walk.files.filter((file) => file.path.startsWith("wide/")).length, 3000);
    assert.ok(!walk.files.some((file) => file.path.includes("loop/")), "symlinked directory followed");
    // The timing bound is the loop guard: a followed junction recurses forever (there is
    // no per-test timeout), so any finite ceiling turns it into a fast failure. A generous
    // bound tolerates parallel `node --test` CPU contention — the walk alone takes ~2 s.
    assert.ok(performance.now() - started < 60_000, "walk exceeded 60 s");
    const budget = await walkFiles(ws.root, { maxEntries: 100 });
    assert.equal(budget.truncated, true);
  });
});

describe("grep", () => {
  it("prints ripgrep-style content lines and honours ignore rules", async () => {
    const result = await ws.run(grepTool, { pattern: "TODO" });
    assert.equal(result.ok, true, result.output);
    assert.equal(result.output, ["docs/readme.md:2:TODO docs", "legacy/gbk.txt:2:TODO 中文", "src/app.ts:2:// TODO: wire up"].join("\n") + "\n\n[skipped 1 binary, 0 larger than 4194304 bytes, 0 undecodable]");
  });

  it("supports case-insensitive search, glob filters and the Python include name", async () => {
    const result = await ws.run(grepTool, { pattern: "todo", case_insensitive: true, glob: "src/**/*.ts" });
    assert.deepEqual(result.data?.matches.map((match) => `${match.path}:${match.line}`), ["src/app.ts:2", "src/lib/util.ts:4"]);
    const legacy = await ws.run(grepTool, { pattern: "(?i)todo", include: "*.md" });
    assert.equal(legacy.output, "docs/readme.md:2:TODO docs");
  });

  it("decodes GBK files and supports Unicode classes and Python named groups", async () => {
    const chinese = await ws.run(grepTool, { pattern: "待办", path: "legacy" });
    assert.equal(chinese.output, "legacy/gbk.txt:1:中文注释：待办事项");
    const han = await ws.run(grepTool, { pattern: "^\\p{Script=Han}+", path: "legacy", output_mode: "count" });
    assert.equal(han.output, "legacy/gbk.txt:1");
    const named = await ws.run(grepTool, { pattern: "(?P<word>help)er\\(\\)", path: "src" });
    assert.equal(named.output, "src/lib/util.ts:1:export function helper() {");
  });

  it("shows context with group separators and pages with head_limit/offset", async () => {
    const context = await ws.run(grepTool, { pattern: "return|lower", path: "src/lib/util.ts", context: 1 });
    assert.equal(context.output, ["src/lib/util.ts-1-export function helper() {", "src/lib/util.ts:2:  return 42;", "src/lib/util.ts-3-}", "src/lib/util.ts:4:// todo lower"].join("\n"));
    const first = await ws.run(grepTool, { pattern: "e", path: "src", head_limit: 2 });
    assert.equal(first.data?.truncated, true);
    assert.match(first.output, /continue with offset=2/);
    const second = await ws.run(grepTool, { pattern: "e", path: "src", head_limit: 2, offset: 2 });
    assert.notEqual(first.output.split("\n")[0], second.output.split("\n")[0]);
  });

  it("lists files newest first, counts, and matches across lines", async () => {
    const files = await ws.run(grepTool, { pattern: "export", output_mode: "files_with_matches" });
    assert.deepEqual(files.data?.files, ["src/lib/util.ts", "src/app.ts"]);
    const counts = await ws.run(grepTool, { pattern: "t", path: "src/lib", output_mode: "count" });
    assert.deepEqual(counts.data?.counts, { "src/lib/util.test.ts": 1, "src/lib/util.ts": 3 });
    const multi = await ws.run(grepTool, { pattern: "helper\\(\\) \\{\\n\\s+return", multiline: true, path: "src" });
    assert.equal(multi.output, "src/lib/util.ts:1:export function helper() {\nsrc/lib/util.ts:2:  return 42;");
  });

  it("returns invalid_argument for bad regexes and explains empty results", async () => {
    assert.equal((await ws.run(grepTool, { pattern: "(" })).error?.code, "invalid_argument");
    const none = await ws.run(grepTool, { pattern: "no such text anywhere", path: "src" });
    assert.match(none.output, /^No matches for "no such text anywhere" in src \(4 files searched\)/);
  });
});

describe("list", () => {
  it("lists one directory with directory markers", async () => {
    const result = await ws.run(listTool, { path: "src" });
    assert.equal(result.output, "app.ts\nlib/\nview.tsx");
    assert.equal((await ws.run(listTool, { path: join("src", "app.ts") })).error?.code, "not_a_directory");
  });
});
