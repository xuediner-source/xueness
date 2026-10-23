/**
 * Inline visualizations: the TS port of the visualize skill's `render.py` and
 * `vendor.py` produces Python's standalone page byte for byte (HTML scan
 * edge cases included), refuses what `_read_fragment` refuses, and the skills
 * extension sends ZCode's interactive-views section only with a directory.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildPromptView, DESKTOP_CONTEXT_SOURCE, type AgentContext, type ModelRequest } from "@xueness/agent";
import { pythonPredatesSecurityBackports, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { BUNDLED_SKILLS_DIR, defaultTitle, interactiveViewsSection, readFragment, renderVisualizationFile, scriptStartTags, skillsExtension, VisualizationSourceError } from "../src/index.ts";

const SKILL = join(BUNDLED_SKILLS_DIR, "visualize");
const base = mkdtempSync(join(tmpdir(), "xue-visualize-"));
after(() => rmSync(base, { recursive: true, force: true }));
const skip = pythonUnavailableReason();
const D3 = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js", LUCIDE = "https://unpkg.com/lucide@1.17.0/dist/umd/lucide.js";

const FRAGMENTS: Record<string, string | Buffer> = {
  "sales-trend_2026.html": `<div class="card"><h2>Hello & "world"</h2><svg viewBox="0 0 10 10"><circle r="4"/></svg></div>\n<script>console.log("</div>", '<script src="${D3}">')</script>\n`,
  "vendor-tags.html": [
    `<SCRIPT  SRC='${D3}' defer data-x="a&amp;b'c"></SCRIPT>`, `<script src="${D3}"/>`, `<!-- <script src="${LUCIDE}"></script> -->`,
    `<textarea><script src="${D3}"></script></textarea>`, `<style>.a{} <script src="${D3}"></script></style>`, `<script src=${LUCIDE} async>`, "</script>",
    `<script id="a&ampx" src="${D3}" src="other" title="&#x41;&#128;&#0;&lt;&ampx"></script>`, `<p title="</script>">x</p><![CDATA[ <script src="${D3}"> ]]>`,
  ].join("\n"),
  "calendar.html": Buffer.from("\ufeff<viz-calendar data-x=1></viz-calendar>\r\n<p>line\r</p>\r\n", "utf8"),
  "stops-at-bad-reference.html": `<p>a &#; b</p><script src="${D3}"></script>`,
  "open-comment.html": `<p>x</p><!-- never closed <script src="${D3}"></script>`,
};

/** Equal pages, or the first difference with a little context (pages are megabytes). */
function sameDocument(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  let at = 0;
  while (at < actual.length && actual[at] === expected[at]) at++;
  assert.fail(`${label}: differs at ${at}: TS ${JSON.stringify(actual.slice(Math.max(0, at - 80), at + 80))} vs Python ${JSON.stringify(expected.slice(Math.max(0, at - 80), at + 80))}`);
}

function pythonRender(path: string, title: string | null): string {
  const out = `${path}.py-out.html`;
  runPython(`import runpy, sys\nsys.argv = ["render.py", ${JSON.stringify(path)}, ${JSON.stringify(out)}, "--force"${title === null ? "" : `, "--title", ${JSON.stringify(title)}`}]\nsys.path.insert(0, ${JSON.stringify(join(SKILL, "scripts"))})\ntry:\n    runpy.run_path(${JSON.stringify(join(SKILL, "scripts", "render.py"))}, run_name="__main__")\nexcept SystemExit as exc:\n    assert not exc.code, exc.code\n`);
  return readFileSync(out, "utf8");
}

describe("visualize render.py port", () => {
  it("renders every fragment exactly as Python", { skip: skip ?? false }, () => {
    const dir = join(base, "parity"); mkdirSync(dir);
    for (const [name, content] of Object.entries(FRAGMENTS)) {
      if (pythonPredatesSecurityBackports() && name === "vendor-tags.html") continue;
      const path = join(dir, name); writeFileSync(path, content);
      for (const title of [null, `<b>"T" & 'x'</b>`]) sameDocument(renderVisualizationFile(SKILL, path, title), pythonRender(path, title), `${name} ${title}`);
    }
  });

  it("inlines the pinned vendor scripts and keeps the scan's stopping points", () => {
    const dir = join(base, "scan"); mkdirSync(dir);
    const kit = readFileSync(join(SKILL, "assets", "visualize.html"), "utf8");
    assert.equal(scriptStartTags(kit).filter((tag) => tag.attrs.some(([name]) => name === "src")).length, 3);
    writeFileSync(join(dir, "plain.html"), "<p>x</p>");
    const page = renderVisualizationFile(SKILL, join(dir, "plain.html"));
    assert.ok(!page.includes("https://unpkg.com/lucide") && page.includes("data:text/javascript;base64,"), "the kit's own vendor scripts are inlined");
    assert.match(page, /<title>Plain<\/title>/);
    writeFileSync(join(dir, "stop.html"), String(FRAGMENTS["stops-at-bad-reference.html"]));
    assert.ok(renderVisualizationFile(SKILL, join(dir, "stop.html")).includes("https://unpkg.com/lucide"), "an invalid &# reference ends the scan, as in Python");
  });

  it("refuses links, oversized files, complete documents and invalid UTF-8", (context) => {
    const dir = join(base, "refuse"); mkdirSync(dir);
    const write = (name: string, content: string | Buffer) => { writeFileSync(join(dir, name), content); return join(dir, name); };
    const target = write("target.html", "<p>x</p>");
    let linked = true;
    try { symlinkSync(target, join(dir, "link.html")); }
    catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) linked = false; else throw error; }
    const cases: Array<[string, RegExp]> = [
      [join(dir, "missing.html"), /source must be a regular file/], [dir, /source must be a regular file/],
      [write("big.html", "x".repeat(1_000_001)), /exceeds the 1 MB size limit/], [write("doc.html", "<!DOCTYPE html><p>x</p>"), /not a complete document/],
      [write("body.html", "<div></div>< BODY>"), /not a complete document/], [write("bytes.html", Buffer.from([0x3c, 0x70, 0x3e, 0xff])), /not valid UTF-8/],
    ];
    if (linked) cases.unshift([join(dir, "link.html"), /source must be a regular file/]);
    for (const [path, message] of cases) assert.throws(() => readFragment(path), (error: unknown) => error instanceof VisualizationSourceError && message.test(error.message), path);
    assert.equal(readFragment(write("ok.html", "x".repeat(1_000_000))).length, 1_000_000);
    if (!linked) context.diagnostic("host refused file symlink creation; the link refusal is not covered here");
  });

  it("titles a fragment after its file like Python", { skip: skip ?? false }, () => {
    const names = ["sales-trend_2026.html", "a.b.c.html", ".hidden", "x", "--__.html", "mIxEd  CASE-ok.html", "a."];
    const python = JSON.parse(runPython(`import json, sys\nsys.path.insert(0, ${JSON.stringify(join(SKILL, "scripts"))})\nimport render\nfrom pathlib import Path\nprint(json.dumps([render._default_title(Path(name)) for name in ${JSON.stringify(names)}]))`)) as string[];
    assert.deepEqual(names.map((name) => defaultTitle(join(base, name))), python);
  });
});

describe("interactive views section", () => {
  const context = (root: string): AgentContext => ({ session: { id: "s" }, provider: {}, root } as unknown as AgentContext);
  const request = (): ModelRequest => ({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "Skill" } }], options: {} });

  it("reaches the stable system prompt only with a directory and the visualize skill listed", async () => {
    const state = join(base, "state"); mkdirSync(state);
    const directory = join(state, "visualizations", "a".repeat(32));
    const withViews = await skillsExtension({ stateDir: state, bundled: BUNDLED_SKILLS_DIR, visualizations: () => directory }).prepareRequest!(context(base), request());
    const section = withViews.messages.find((message) => message._context_source === DESKTOP_CONTEXT_SOURCE);
    assert.equal(section?.content, interactiveViewsSection(directory));
    assert.ok(String(section?.content).includes(`Writable, durable visualization directory for this session: ${JSON.stringify(directory)}.`));
    const view = buildPromptView(withViews.messages, { envInfo: { cwd: base, platform: "linux", shell: "bash", osVersion: "Linux" } })!;
    const stable = String(view[1]!.content);
    assert.ok(stable.indexOf("You are an interactive Xueness agent") < stable.indexOf("# Xueness Desktop Context"));
    assert.ok(!view.some((message) => message._context_source === DESKTOP_CONTEXT_SOURCE));
    for (const options of [{ visualizations: () => null }, {}, { bundled: null, visualizations: () => directory }]) {
      const plain = await skillsExtension({ stateDir: state, bundled: BUNDLED_SKILLS_DIR, ...options }).prepareRequest!(context(base), request());
      assert.ok(!plain.messages.some((message) => message._context_source === DESKTOP_CONTEXT_SOURCE));
    }
  });
});
