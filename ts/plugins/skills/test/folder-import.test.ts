import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { it } from "node:test";
import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import { beginFolderImport, cancelFolderImport, commitFolderImport, importedSkillFolder, removeImportedSkill, writeFolderChunk } from "../src/folder-import.ts";
import { createSkillsHttp } from "../src/http-api.ts";
import { loadSkill } from "../src/render.ts";

const skill = (name: string) => Buffer.from(`---\nname: ${name}\ndescription: A folder import fixture.\n---\nUse scripts/read.py and references/说明.txt.\n`);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xueness-skill-import-")), state = join(root, "state");
  mkdirSync(state);
  return { root, state, close() { assert(root.startsWith(realpathSync.native(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); } };
}
function upload(state: string, files: Record<string, Buffer>) {
  const begun = beginFolderImport(state, { files: Object.entries(files).map(([path, content]) => ({ path, bytes: content.length })) });
  for (const path of begun.files) {
    const raw = files[path]!;
    for (let offset = 0; offset < raw.length || offset === 0; offset += 7) writeFolderChunk(state, begun.token, { path, offset, content: raw.subarray(offset, offset + 7).toString("base64") });
  }
  return begun;
}

it("imports a folder with exact binary, Unicode and nested assets into model-visible skills", () => {
  const f = fixture();
  try {
    const assets = Buffer.from([0, 255, 17, 32, 0]);
    const files = { "chosen/SKILL.md": skill("folder-demo"), "chosen/assets/icon.bin": assets, "chosen/references/说明.txt": Buffer.from("引用\r\n雪"), "chosen/scripts/read.py": Buffer.from("print('ready')\n") };
    const begun = upload(f.state, files), result = commitFolderImport(f.state, begun.token);
    assert.deepEqual(result.imported.map(row => row.name), ["folder-demo"]);
    for (const [path, bytes] of Object.entries(files)) assert.deepEqual(readFileSync(join(f.state, "skills/folder-demo", path.slice(7))), bytes);
    assert.equal(importedSkillFolder(f.state, "folder-demo"), true);
    assert.equal(loadSkill(f.state, null, "folder-demo", null).ok, true);
    assert.equal(existsSync(join(f.state, "skill-imports", begun.token)), false);
  } finally { f.close(); }
});

it("imports a collection while ignoring files outside its immediate skill folders", () => {
  const f = fixture();
  try {
    const begun = upload(f.state, { "collection/README.md": Buffer.from("not a skill"), "collection/one/SKILL.md": skill("first-skill"), "collection/two/SKILL.md": skill("second-skill") });
    assert.equal(begun.files.length, 2);
    assert.deepEqual(commitFolderImport(f.state, begun.token).imported.map(row => row.name), ["first-skill", "second-skill"]);
  } finally { f.close(); }
});

it("does not overwrite an existing skill or publish part of a conflicting batch", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.state, "skills/existing"), { recursive: true });
    const original = skill("existing"); writeFileSync(join(f.state, "skills/existing/SKILL.md"), original);
    const begun = upload(f.state, { "set/first/SKILL.md": skill("new-one"), "set/second/SKILL.md": skill("existing") });
    assert.throws(() => commitFolderImport(f.state, begun.token), /技能已存在/);
    assert.equal(existsSync(join(f.state, "skills/new-one")), false);
    assert.deepEqual(readFileSync(join(f.state, "skills/existing/SKILL.md")), original);
    assert.throws(() => removeImportedSkill(f.state, "existing"), /只能移除/);
    cancelFolderImport(f.state, begun.token);
  } finally { f.close(); }
});

it("rejects traversal, platform aliases, duplicate paths and oversized inputs before staging", () => {
  const f = fixture();
  try {
    for (const path of ["../SKILL.md", "C:/SKILL.md", "a\\SKILL.md", "a/./SKILL.md", "a/CON", "a/SKILL.md "]) {
      assert.throws(() => beginFolderImport(f.state, { files: [{ path, bytes: 1 }] }));
    }
    assert.throws(() => beginFolderImport(f.state, { files: [{ path: "a/SKILL.md", bytes: 1 }, { path: "A/skill.md", bytes: 1 }] }));
    assert.throws(() => beginFolderImport(f.state, { files: [{ path: "a/SKILL.md", bytes: 20 * 1024 * 1024 }] }));
    assert.equal(existsSync(join(f.state, "skill-imports")), false);
  } finally { f.close(); }
});

it("requires exact chunk offsets and complete valid SKILL.md before publication", () => {
  const f = fixture();
  try {
    const raw = skill("exact-chunks"), begun = beginFolderImport(f.state, { files: [{ path: "demo/SKILL.md", bytes: raw.length }] });
    assert.throws(() => writeFolderChunk(f.state, begun.token, { path: "demo/SKILL.md", offset: 1, content: "YQ==" }));
    writeFolderChunk(f.state, begun.token, { path: "demo/SKILL.md", offset: 0, content: raw.subarray(0, 4).toString("base64") });
    assert.throws(() => writeFolderChunk(f.state, begun.token, { path: "demo/SKILL.md", offset: 0, content: "YQ==" }));
    assert.throws(() => commitFolderImport(f.state, begun.token), /尚未上传完成/);
    cancelFolderImport(f.state, begun.token);
    const invalid = upload(f.state, { "bad/SKILL.md": Buffer.from("# no frontmatter") });
    assert.throws(() => commitFolderImport(f.state, invalid.token), /name.*description/);
    assert.equal(existsSync(join(f.state, "skills/exact-chunks")), false);
  } finally { f.close(); }
});

it("refuses a redirected staging parent and tampered manifest paths", () => {
  const f = fixture();
  try {
    const begun = upload(f.state, { "one/SKILL.md": skill("linked"), "one/assets/data": Buffer.from("same") });
    const assets = join(f.state, "skill-imports", begun.token, "files/one/assets"), outside = join(f.root, "outside");
    mkdirSync(outside); writeFileSync(join(outside, "data"), "same");
    rmSync(assets, { recursive: true }); symlinkSync(outside, assets, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => commitFolderImport(f.state, begun.token), /不能是链接/);
    assert.equal(readFileSync(join(outside, "data"), "utf8"), "same");
    const path = join(f.state, "skill-imports", begun.token, "upload.json");
    writeFileSync(path, JSON.stringify({ createdAt: Date.now(), roots: ["../../outside"], files: [] }));
    assert.throws(() => commitFolderImport(f.state, begun.token), /文件路径无效/);
  } finally { f.close(); }
});

it("fences upload and removal behind the skills switch and reports imported folders", () => {
  const f = fixture();
  try {
    let enabled = false;
    const api = createSkillsHttp({ stateDir: f.state, projectDir: f.root, webRuns: f.root, allowedRoots: () => [f.root], enabled: () => enabled });
    assert.equal(api.dispatch("POST", ["api", "resources", "skills", "imports"], {}, { files: [] })?.[0], 403);
    assert.equal(existsSync(join(f.state, "skill-imports")), false);
    enabled = true;
    const begun = upload(f.state, { "one/SKILL.md": skill("api-folder") }); commitFolderImport(f.state, begun.token);
    const result = api.dispatch("GET", ["api", "resources", "skills", "files"], {}, null);
    assert.equal(result?.[0], 200);
    assert.equal((result?.[1] as { skills: { name: string; imported: boolean }[] }).skills.find(row => row.name === "api-folder")?.imported, true);
    assert.equal(api.dispatch("DELETE", ["api", "resources", "skills", "folders", "api-folder"], {}, {})?.[0], 200);
    assert.equal(loadSkill(f.state, null, "api-folder", null).ok, false);
  } finally { f.close(); }
});
