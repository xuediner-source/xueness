/**
 * .gitignore semantics, differential against git itself: random trees and
 * random rule files (negation, anchoring, `**`, directory-only rules, classes,
 * escapes, nested .gitignore files); walkFiles must list exactly the files
 * `git ls-files --others --exclude-standard` lists.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { IgnoreMatcher, parseIgnoreFile, walkFiles } from "../src/index.ts";

const gitMissing = spawnSync("git", ["--version"]).status === 0 ? false : "git is not installed";
const CASES = Number(process.env.XUENESS_IGNORE_CASES ?? 150);

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["a", "b", "c", "d", "da", "build", "keep.log", "x.log", "y.tmp", "z.txt", "!x", "#x", "x y", "[a]", "a.b.c"];
const RULES = [
  "a", "b", "build", "build/", "/build", "a/b", "a/**/c", "**/c", "c/**", "!a", "!*.log", "!keep.log", "*.log", "*.tmp",
  "d?", "[ab]", "[!a]*", "\\!x", "\\#x", "#x", "x\\ y", "*", "a/*", "**/b/*.txt", "/a/b/", "!/a/b/", "b/z.txt", "*.txt",
  "!b/*.txt", "da/", "!da/", "**/a.b.c", "/*.log", "a/b/**", "\\[a\\]", "[a]", "**", "!**/", "*/", "c/", "  ", "z.txt  ",
];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function buildCase(root: string, seed: number): void {
  const random = rng(seed);
  const dirs = [""];
  for (let index = 0; index < 4 + Math.floor(random() * 10); index += 1) {
    const parent = pick(random, dirs);
    const dir = parent ? `${parent}/${pick(random, NAMES)}` : pick(random, NAMES);
    if (dir.split("/").length <= 4 && !dirs.includes(dir)) dirs.push(dir);
  }
  const taken = new Set(dirs);
  for (let index = 0; index < 6 + Math.floor(random() * 20); index += 1) {
    const parent = pick(random, dirs);
    const file = parent ? `${parent}/${pick(random, NAMES)}` : pick(random, NAMES);
    if (taken.has(file) || dirs.some((dir) => dir.startsWith(`${file}/`))) continue;
    taken.add(file);
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), "x");
  }
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true });
    if (dir && random() < 0.6) continue;
    const rules = Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(random, RULES));
    writeFileSync(join(root, dir, ".gitignore"), `${rules.join("\n")}\n`);
  }
  // Empty directories do not appear in git output; give each one a file.
  for (const dir of dirs) writeFileSync(join(root, dir, "f"), "x");
}

function git(root: string, args: string[]): string {
  const home = join(root, "..", "home");
  mkdirSync(home, { recursive: true });
  const result = spawnSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "none") },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

describe("gitignore semantics", () => {
  it("parses the documented forms", () => {
    const matcher = new IgnoreMatcher().with("", parseIgnoreFile("# comment\n*.log\n!keep.log\nbuild/\n/root-only\ndocs/**/*.md\n\\#hash\nspace\\ \n"));
    assert.equal(matcher.ignores("x/app.log", false), true);
    assert.equal(matcher.ignores("x/keep.log", false), false);
    assert.equal(matcher.ignores("build", true), true);
    assert.equal(matcher.ignores("build", false), false, "directory-only rule does not match a file");
    assert.equal(matcher.ignores("build/out.js", false), true, "files inside an ignored directory stay ignored");
    assert.equal(matcher.ignores("root-only", false), true);
    assert.equal(matcher.ignores("sub/root-only", false), false);
    assert.equal(matcher.ignores("docs/a/b/c.md", false), true);
    assert.equal(matcher.ignores("docs/c.md", false), true);
    assert.equal(matcher.ignores("#hash", false), true);
    assert.equal(matcher.ignores("space ", false), true);
  });

  it(`matches git ls-files on ${CASES} random repositories`, { skip: gitMissing }, async () => {
    const base = mkdtempSync(join(tmpdir(), "xueness-ignore-"));
    let total = 0;
    let kept = 0;
    try {
      for (let seed = 1; seed <= CASES; seed += 1) {
        const root = join(base, `case-${seed}`);
        mkdirSync(root, { recursive: true });
        git(root, ["init", "-q"]);
        buildCase(root, seed);
        const expected = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean).sort();
        const actual = (await walkFiles(root, { skipDefaultExcludes: false })).files.map((file) => file.path).sort();
        assert.deepEqual(actual, expected, `seed ${seed}`);
        total += (await walkFiles(root, { respectIgnore: false, skipDefaultExcludes: false })).files.length;
        kept += expected.length;
        rmSync(root, { recursive: true, force: true });
      }
      // The generator must exercise both outcomes, or agreement would be trivial.
      assert.ok(kept > total * 0.2 && kept < total * 0.8, `kept ${kept} of ${total} files`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("applies .gitignore files above the walk root inside a repository", { skip: gitMissing }, async () => {
    const base = mkdtempSync(join(tmpdir(), "xueness-ignore-"));
    try {
      git(base, ["init", "-q"]);
      writeFileSync(join(base, ".gitignore"), "*.gen.ts\nsub/inner/cache/\n");
      mkdirSync(join(base, "sub", "inner", "cache"), { recursive: true });
      writeFileSync(join(base, "sub", "inner", "a.ts"), "");
      writeFileSync(join(base, "sub", "inner", "a.gen.ts"), "");
      writeFileSync(join(base, "sub", "inner", "cache", "c.ts"), "");
      const files = (await walkFiles(join(base, "sub"))).files.map((file) => file.path);
      assert.deepEqual(files, ["inner/a.ts"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
