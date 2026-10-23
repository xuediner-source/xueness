import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PyOSError } from "@xueness/sessions";
import { createFilesHttp, workspaceBinaryPreview, workspaceFiles, workspacePreview } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason() ?? false;
const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-files-http-")));
const root = join(base, "root");
const extra = join(base, "extra");
const sid = "ab".repeat(16);
after(() => rmSync(base, { recursive: true, force: true }));

function tree(): void {
  mkdirSync(join(root, "vis"), { recursive: true });
  mkdirSync(join(root, ".hid"));
  mkdirSync(join(root, "sub"));
  mkdirSync(join(extra, "inside"), { recursive: true });
  for (const name of ["d0", "d1", "d2", "d3"]) mkdirSync(join(root, "many", name), { recursive: true });
  writeFileSync(join(root, "note.txt"), "hello 你好");
  writeFileSync(join(root, ".secret.txt"), "hidden");
  writeFileSync(join(root, "B.txt"), "B");
  writeFileSync(join(root, "a.txt"), "a");
  writeFileSync(join(root, "é.txt"), "e");
  writeFileSync(join(root, "sub", "z.txt"), "z");
  writeFileSync(join(root, "many", "f.txt"), "f");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x61, 0, 0x62]));
  writeFileSync(join(root, "tiny.png"), Buffer.from("\x89PNG\r\n\x1a\npayload"));
  writeFileSync(join(root, "old.doc"), Buffer.from("legacy"));
  writeFileSync(join(root, "clip.mp3"), Buffer.from("ID3 fake"));
}

const DIRECTORY = `
import json, sys
from xueness.bundled_plugins.files.directory_api import dispatch
out = []
for item in json.load(sys.stdin):
    out.append(dispatch(item["method"], item["parts"], item["query"], item["data"], item["ctx"]))
print(json.dumps(out))
`;

const PREVIEW = `
import json, sys, zipfile
from pathlib import Path
from xueness.bundled_plugins.files.preview import workspace_binary_preview, workspace_files, workspace_preview
from xueness.office_preview import preview
root = Path(json.load(sys.stdin)["root"])
xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>'
with zipfile.ZipFile(root / "a.docx", "w") as archive:
    archive.writestr("word/document.xml", xml)
def grab(fn, *args):
    try: return ["ok", fn(*args)]
    except Exception as exc: return [type(exc).__name__, str(exc)]
print(json.dumps({
    "files": grab(workspace_files, root),
    "text": grab(workspace_preview, root, "note.txt"),
    "short": grab(lambda: workspace_preview(root, "note.txt", max_file_preview=4)),
    "binary": grab(workspace_preview, root, "bin.dat"),
    "outside": grab(workspace_preview, root, "../nope.txt"),
    "image": grab(workspace_binary_preview, root, "tiny.png"),
    "audio": grab(workspace_binary_preview, root, "clip.mp3"),
    "legacy": grab(workspace_binary_preview, root, "old.doc"),
    "plain": grab(workspace_binary_preview, root, "note.txt"),
    "docx": grab(workspace_binary_preview, root, "a.docx"),
    "office": grab(preview, root / "a.docx"),
}))
`;

type Call = { method: string; parts: string[]; query: Record<string, string[]>; data: unknown; ctx: Record<string, unknown> };
const same = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("files HTTP", () => {
  const session = { id: sid, root };
  const http = createFilesHttp({ loadSession: async () => session, officePreview: () => ({ kind: "docx", sections: [], truncated: false, imageCount: 0 }) });

  it("owns directory GET/POST and session GET only", () => {
    assert.equal(http.owns("GET", ["api", "system"]), true);
    assert.equal(http.owns("POST", ["api", "system"]), false);
    assert.equal(http.owns("GET", ["api", "directory"]), true);
    assert.equal(http.owns("POST", ["api", "directory"]), true);
    assert.equal(http.owns("PUT", ["api", "directory"]), false);
    assert.equal(http.owns("GET", ["api", "home"]), false);
    assert.equal(http.owns("GET", ["api", "sessions", sid, "files"]), true);
    assert.equal(http.owns("GET", ["api", "sessions", sid, "file"]), true);
    assert.equal(http.owns("POST", ["api", "sessions", sid, "files"]), false);
    assert.equal(http.owns("GET", ["api", "sessions", "NOPE", "files"]), false);
  });

  it("maps a missing session, a disabled plugin, and office preview failures", async () => {
    assert.deepEqual(await http.dispatch("POST", ["api", "sessions", sid, "files"], {}, {}), null);
    assert.deepEqual(await http.dispatch("GET", ["api", "home"], {}, {}), null);
    assert.deepEqual(await createFilesHttp({ loadSession: async () => null }).dispatch("GET", ["api", "sessions", sid, "files"], {}, {}), [404, { error: "session not found" }]);
    assert.deepEqual(await createFilesHttp({ loadSession: () => { throw new PyOSError("missing"); } }).dispatch("GET", ["api", "sessions", sid, "file"], {}, {}), [404, { error: "session not found" }]);
    const disabled = createFilesHttp({ enabled: () => false, loadSession: async () => session });
    assert.deepEqual(await disabled.dispatch("GET", ["api", "directory"], {}, {}), [403, { error: "plugin disabled or dependency unavailable: files", plugin: "files" }]);
    assert.equal(await disabled.dispatch("PUT", ["api", "directory"], {}, {}), null);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "note.txt"), "hello 你好");
    assert.deepEqual(await http.dispatch("GET", ["api", "sessions", sid, "file"], { path: ["../nope.txt"] }, {}), [400, { error: "path outside workspace" }]);
    assert.deepEqual(await http.dispatch("GET", ["api", "sessions", sid, "file"], { path: ["missing.txt"] }, {}), [400, { error: "cannot preview file" }]);
    assert.deepEqual(await http.dispatch("GET", ["api", "sessions", sid, "file"], { path: ["note.txt"] }, {}), [200, { id: sid, path: "note.txt", size: Buffer.byteLength("hello 你好"), truncated: false, text: "hello 你好" }]);
    writeFileSync(join(root, "a.docx"), Buffer.from("not-a-zip"));
    const fake = await http.dispatch("GET", ["api", "sessions", sid, "file"], { path: ["a.docx"] }, {});
    assert.deepEqual(fake, [200, { id: sid, path: "a.docx", size: 9, truncated: false, office: { kind: "docx", sections: [], truncated: false, imageCount: 0 } }]);
    const thrown = createFilesHttp({ loadSession: async () => session, officePreview: () => { throw new Error("boom"); } });
    assert.deepEqual(await thrown.dispatch("GET", ["api", "sessions", sid, "file"], { path: ["a.docx"] }, {}), [400, { error: "cannot preview file" }]);
    const missing = createFilesHttp({ loadSession: async () => session });
    assert.deepEqual(await missing.dispatch("GET", ["api", "sessions", sid, "file"], { path: ["a.docx"] }, {}), [400, { error: "cannot preview file" }]);
    rmSync(join(root, "a.docx"), { force: true });
  });
});

describe("files HTTP against Python", { skip }, () => {
  tree();
  const ctx = { list_roots: [root], create_roots: [root], workspace_roots: [extra] };
  const narrow = { ...ctx, max_entries: 2 };
  const api = createFilesHttp({ listRoots: [root], createRoots: [root], allowedRoots: () => [extra] });
  const capped = createFilesHttp({ listRoots: [root], createRoots: [root], allowedRoots: () => [extra], maxEntries: 2 });

  async function compare(calls: Call[], client = api): Promise<void> {
    const expected = JSON.parse(runPython(DIRECTORY, JSON.stringify(calls))) as unknown[];
    const actual = [];
    for (const call of calls) actual.push(await client.dispatch(call.method, call.parts, call.query, call.data));
    assert.deepEqual(same(actual), expected);
  }

  it("lists, filters hidden files, and refuses a path outside the roots", async () => {
    const q = (path: string, hidden = "0", files = "0") => ({ path: [path], includeHidden: [hidden], includeFiles: [files] });
    await compare([
      { method: "GET", parts: ["api", "system"], query: {}, data: null, ctx },
      { method: "GET", parts: ["api", "directory"], query: q(root), data: null, ctx },
      { method: "GET", parts: ["api", "directory"], query: q(root, "1", "1"), data: null, ctx },
      { method: "GET", parts: ["api", "directory"], query: q(root, "0", "1"), data: null, ctx },
      { method: "GET", parts: ["api", "directory"], query: q(extra, "1", "1"), data: null, ctx },
      { method: "GET", parts: ["api", "directory"], query: q(base), data: null, ctx },
      { method: "GET", parts: ["api", "directory"], query: { path: ["relative"] }, data: null, ctx },
      { method: "PUT", parts: ["api", "directory"], query: {}, data: {}, ctx },
      { method: "GET", parts: ["api", "home"], query: {}, data: null, ctx },
      { method: "POST", parts: ["api", "directory"], query: {}, data: null, ctx },
      { method: "POST", parts: ["api", "directory"], query: {}, data: [], ctx },
      ...["a/b", "..", ".", "", "   "].map((name) => ({ method: "POST", parts: ["api", "directory"], query: {}, data: { path: root, name }, ctx })),
      { method: "POST", parts: ["api", "directory"], query: {}, data: { path: base, name: "nope" }, ctx },
    ]);
    await compare([{ method: "GET", parts: ["api", "directory"], query: { path: [join(root, "many")], includeFiles: ["1"] }, data: null, ctx: narrow }], capped);
  });

  it("creates one child and reports the conflict the way Python does", async () => {
    const calls: Call[] = [1, 2].map(() => ({ method: "POST", parts: ["api", "directory"], query: {}, data: { path: root, name: "made-by-picker" }, ctx }));
    const expected = JSON.parse(runPython(DIRECTORY, JSON.stringify(calls))) as unknown[];
    rmSync(join(root, "made-by-picker"), { recursive: true, force: true });
    const actual = [];
    for (const call of calls) actual.push(await api.dispatch(call.method, call.parts, call.query, call.data));
    assert.deepEqual(same(actual), expected);
    assert.equal((actual[0] as [number, { path: string }])[0], 200);
    assert.equal((actual[1] as [number, { error: string }])[1].error, "directory-exists");
  });

  it("matches workspace listing, text preview, and binary refusal", () => {
    const py = JSON.parse(runPython(PREVIEW, JSON.stringify({ root }))) as Record<string, [string, unknown]>;
    const grab = (fn: () => unknown) => { try { return ["ok", fn()]; } catch (error) { return [error instanceof Error ? error.name : "Error", error instanceof Error ? error.message : String(error)]; } };
    assert.deepEqual(grab(() => workspaceFiles(root)), py.files);
    assert.deepEqual(grab(() => workspacePreview(root, "note.txt")), py.text);
    assert.deepEqual(grab(() => workspacePreview(root, "note.txt", 4)), py.short);
    assert.deepEqual(grab(() => workspacePreview(root, "bin.dat")), py.binary);
    assert.deepEqual(grab(() => workspacePreview(root, "../nope.txt")), py.outside);
    assert.deepEqual(grab(() => workspaceBinaryPreview(root, "tiny.png")), py.image);
    assert.deepEqual(grab(() => workspaceBinaryPreview(root, "clip.mp3")), py.audio);
    assert.deepEqual(grab(() => workspaceBinaryPreview(root, "old.doc")), py.legacy);
    assert.deepEqual(grab(() => workspaceBinaryPreview(root, "note.txt")), py.plain);
    const office = (py.office?.[1] ?? null) as Record<string, unknown> | null;
    assert.equal(py.office?.[0], "ok");
    assert.equal(office?.kind, "docx");
    let bytes = -1;
    const docx = grab(() => workspaceBinaryPreview(root, "a.docx", (data, suffix) => {
      bytes = data.length;
      assert.equal(suffix, ".docx");
      return office!;
    }));
    assert.deepEqual(docx, py.docx);
    assert.equal(bytes, (py.docx?.[1] as { size: number }).size);
    assert.deepEqual(grab(() => workspaceBinaryPreview(root, "a.docx")), ["ValueError", "invalid or oversized Office document"]);
  });
});
