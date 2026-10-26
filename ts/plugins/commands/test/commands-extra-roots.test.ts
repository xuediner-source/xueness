import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/**
 * F07.04 — additional command directories: `<state>/command-directories.json`
 * lists operator roots, each its own jail, optionally namespaced. Slash
 * commands from every root merge into one listing where a same-name loser
 * stays visible as shadowed instead of being silently overridden, a
 * namespaced root keeps `namespace:name` exclusively, and expansion still
 * substitutes arguments for the namespaced invocations.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  expandCommand, extraCommandRoots, listAll, loadCommandDirectories, loadCommands,
  MAX_EXTRA_COMMAND_ROOTS, namespacedCommandName,
} from "../src/index.ts";

const base = mkdtempSync(join(tmpdir(), "xue-commands-extra-"));
after(() => rmSync(base, { recursive: true, force: true }));

const command = (directory: string, name: string, body: string): void => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), `---\ndescription: ${name} command\nargument-hint: [args]\n---\n\n${body}\n`);
};
const configure = (state: string, directories: unknown[]): void => {
  writeFileSync(join(state, "command-directories.json"), JSON.stringify({ schemaVersion: 1, directories }));
};
const scope = (stateDir: string, root: string | null = null) => ({ stateDir, root, manifestCommands: new Set<string>(), env: process.env });

describe("F07.04 command-directories.json loading", () => {
  it("absent means no extra roots", () => {
    const state = join(base, "s-absent"); mkdirSync(state);
    assert.deepEqual(loadCommandDirectories(state), { directories: [], diagnostics: [], status: "absent" });
    assert.deepEqual(extraCommandRoots(state), []);
  });
  it("resolves paths against the state directory and keeps namespace and enabled", () => {
    const state = join(base, "s-ok"); mkdirSync(join(base, "abs-cmds"), { recursive: true }); mkdirSync(state);
    configure(state, [{ path: "../rel-cmds" }, { path: join(base, "abs-cmds"), namespace: "docs" }, { path: "../off", enabled: false }]);
    const loaded = loadCommandDirectories(state);
    assert.equal(loaded.status, "ok");
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.directories, [
      { path: join(base, "rel-cmds"), namespace: null, enabled: true },
      { path: join(base, "abs-cmds"), namespace: "docs", enabled: true },
      { path: join(base, "off"), namespace: null, enabled: false },
    ]);
  });
  it("drops invalid namespaces and duplicates with diagnostics, and caps the list", () => {
    const state = join(base, "s-edge"); mkdirSync(join(state, "ok"), { recursive: true });
    const many = Array.from({ length: MAX_EXTRA_COMMAND_ROOTS + 2 }, () => ({ path: "ok" }));
    configure(state, [{ path: "ok" }, { path: "bad", namespace: "Docs" }, { path: "bad2", namespace: "n s" }, { path: "ok" }, ...many]);
    const loaded = loadCommandDirectories(state);
    assert.equal(loaded.status, "ok");
    assert.deepEqual(loaded.directories.map((row) => row.path), [join(state, "ok")]);
    assert.ok(loaded.diagnostics.some((row) => row.code === "command_directory_invalid_namespace"));
    assert.ok(loaded.diagnostics.some((row) => row.code === "command_directory_duplicate"));
    assert.ok(loaded.diagnostics.some((row) => row.code === "command_directories_limit"));
  });
  it("a broken document is corrupt with a diagnostic and never a throw", () => {
    const state = join(base, "s-corrupt"); mkdirSync(state);
    const path = join(state, "command-directories.json");
    for (const text of ["{not json", "{}", JSON.stringify({ schemaVersion: 2, directories: [] }), JSON.stringify({ schemaVersion: 1, directories: [], extra: 1 }), JSON.stringify({ schemaVersion: 1 })]) {
      writeFileSync(path, text);
      const loaded = loadCommandDirectories(state);
      assert.equal(loaded.status, "corrupt", text);
      assert.deepEqual(loaded.directories, []);
      assert.equal(loaded.diagnostics.length, 1);
    }
  });
  it("a linked document or root is refused", { skip: process.platform === "win32" }, () => {
    const state = join(base, "s-link"); mkdirSync(join(base, "target"), { recursive: true }); mkdirSync(state);
    symlinkSync(join(base, "target"), join(state, "command-directories.json"));
    assert.equal(loadCommandDirectories(state).status, "corrupt");
    symlinkSync(join(base, "target"), join(base, "linked-root"));
    const state2 = join(base, "s-link2"); mkdirSync(state2);
    configure(state2, [{ path: "../linked-root" }]);
    const roots = extraCommandRoots(state2);
    assert.deepEqual(roots.map((root) => root.base), [""]);
    assert.equal(roots[0]!.diagnostics[0]!.code, "command_root_symlink");
  });
});

describe("F07.04 extra-root discovery, namespacing and slash-command merge", () => {
  it("lists extra commands with source and scope, and namespaces every name in a namespaced root", () => {
    const state = join(base, "d1"), root = join(base, "w1"), extra = join(base, "x1");
    mkdirSync(state); mkdirSync(root);
    command(extra, "review", "Review $ARGUMENTS");
    command(join(extra, "git"), "log", "Show the log of $1");
    configure(state, [{ path: "../x1", namespace: "docs" }]);
    const rows = listAll(scope(state, root)).commands;
    const review = rows.find((item) => item.id === "docs:review")!;
    assert.ok(review);
    assert.equal(review.source, "extra"); assert.equal(review.scope, "extra"); assert.equal(review.shadowed, false);
    assert.equal(review.rootPath, extra);
    assert.equal(namespacedCommandName("docs", "review"), "docs:review");
    // An inner namespace directory would need a second colon; a namespaced root refuses it instead of listing it.
    const deep = rows.find((item) => item.id === "docs:git:log");
    assert.equal(deep, undefined);
    assert.ok(listAll(scope(state, root)).diagnostics.some((item) => item.code === "command_invalid_name"));
  });
  it("never silently overrides: same-name losers stay listed as shadowed while the namespaced copy stays expandable", () => {
    const state = join(base, "d2"), root = join(base, "w2"), plain = join(base, "x2"), spaced = join(base, "x3");
    mkdirSync(state); mkdirSync(root);
    command(join(state, "commands"), "review", "User review of $ARGUMENTS");
    command(plain, "review", "Plain extra review");
    command(spaced, "review", "Docs review of $ARGUMENTS");
    configure(state, [{ path: "../x2" }, { path: "../x3", namespace: "docs" }]);
    const document = listAll(scope(state, root));
    const winner = document.commands.find((item) => item.id === "review" && !item.shadowed)!;
    assert.equal(winner.source, "user");
    const loser = document.commands.find((item) => item.id === "review" && item.source === "extra")!;
    assert.equal(loser.shadowed, true); assert.equal(loser.shadowedBy, "user");
    const namespaced = document.commands.find((item) => item.id === "docs:review")!;
    assert.equal(namespaced.shadowed, false);
    const loaded = loadCommands(scope(state, root));
    assert.deepEqual(loaded.map((item) => String(item.id)).filter((id) => id.includes("review")), ["docs:review", "review"]);
    const [userText, userMeta] = expandCommand(loaded, "/review the diff");
    assert.equal(userText, "User review of the diff");
    assert.deepEqual(userMeta, { command: "review", args: "the diff" });
    const [docsText, docsMeta] = expandCommand(loaded, "/docs:review the diff");
    assert.equal(docsText, "Docs review of the diff");
    assert.deepEqual(docsMeta, { command: "docs:review", args: "the diff" });
  });
  it("a reserved chat builtin from an extra root is refused, not taken over", () => {
    const state = join(base, "d3"), root = join(base, "w3"), extra = join(base, "x4");
    mkdirSync(state); mkdirSync(root);
    command(extra, "help", "Hostile help");
    command(extra, "status", "Hostile status");
    configure(state, [{ path: "../x4" }]);
    const rows = listAll(scope(state, root)).commands.filter((item) => item.source === "extra");
    assert.deepEqual(rows.map((item) => [item.id, item.shadowed, item.shadowedBy]), [["help", true, "builtin"], ["status", true, "builtin"]]);
    assert.equal(expandCommand(loadCommands(scope(state, root)), "/help")[1], null);
  });
  it("project commands outrank extra roots and disabled or missing roots only add diagnostics", () => {
    const state = join(base, "d4"), root = join(base, "w4"), extra = join(base, "x5");
    mkdirSync(state); mkdirSync(root);
    command(join(root, ".xueness", "commands"), "deploy", "Project deploy of $ARGUMENTS");
    command(extra, "deploy", "Extra deploy");
    configure(state, [{ path: "../x5" }, { path: "../missing-root" }]);
    const document = listAll(scope(state, root));
    const deploy = document.commands.filter((item) => item.id === "deploy");
    assert.equal(deploy.find((item) => !item.shadowed)!.source, "project");
    assert.equal(deploy.find((item) => item.source === "extra")!.shadowedBy, "project");
    assert.ok(document.diagnostics.some((item) => item.code === "command_directory_unreadable"));
    configure(state, [{ path: "../x5", enabled: false }]);
    const disabled = listAll(scope(state, root));
    assert.ok(disabled.commands.every((item) => item.source !== "extra"));
    assert.deepEqual(disabled.diagnostics, []);
  });
});
