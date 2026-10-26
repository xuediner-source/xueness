import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Browsers, browsersTool, createBrowsersTool, StaticSiteDriver, STALE_REFERENCE, type ToolResult } from "../src/index.ts";
import { workspace } from "./helpers.ts";

const ws = workspace();
const site = join(ws.base, "site");

async function fixture(): Promise<void> {
  await mkdir(site, { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(site, "home.html"), [
    "<html><title>Home</title><body>",
    "<h1 id='title'>Welcome</h1>",
    "<a id='docs' class='link' data-href='page:docs'>Docs</a>",
    "<a id='file' class='link' data-download='report.csv'>Download</a>",
    "<input id='query' class='field' />",
    "</body></html>",
  ].join(""));
  await writeFile(join(site, "docs.html"), "<html><title>Docs</title><body><h1 id='title'>Manual</h1><a id='back' data-href='page:home'>Back</a></body></html>");
}

function facade(): Browsers {
  return new Browsers(new StaticSiteDriver(site), { downloadsDir: join(ws.base, "downloads") });
}

async function openHome(browsers: Browsers) {
  await fixture();
  return browsers.open("page:home");
}

describe("browser and tab identity (F12.02)", () => {
  it("opens a browser with a first tab and reports identity", async () => {
    const browsers = facade();
    const opened = await openHome(browsers);
    assert.match(opened.browser.id, /^b-[0-9a-f]{10}$/);
    assert.match(opened.tab.id, /^t-[0-9a-f]{10}$/);
    assert.equal(opened.tab.browserId, opened.browser.id);
    assert.equal(opened.tab.title, "Home");
  });

  it("keeps references valid across navigation", async () => {
    const browsers = facade();
    const { tab } = await openHome(browsers);
    const moved = await browsers.navigate(tab.id, "page:docs");
    assert.equal(moved.tab.url, "page:docs");
    assert.equal(moved.tab.title, "Docs");
    const page = await browsers.read(tab.id);
    assert.match(page.snapshot.text, /Manual/);
    assert.equal(page.tab.navigations, 2);
  });

  it("lists browsers and tabs", async () => {
    const browsers = facade();
    await openHome(browsers);
    const state = browsers.list();
    assert.equal(state.browsers.length, 1);
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0]?.title, "Home");
  });
});

describe("interaction, downloads and screenshots (F12.02)", () => {
  it("clicks a link and follows the navigation", async () => {
    const browsers = facade();
    const { tab } = await openHome(browsers);
    const clicked = await browsers.click(tab.id, "#docs");
    assert.equal(clicked.navigation?.finalUrl, "page:docs");
    assert.equal((await browsers.read(tab.id)).tab.title, "Docs");
  });

  it("types into a field and echoes the value", async () => {
    const browsers = facade();
    const { tab } = await openHome(browsers);
    const typed = await browsers.type(tab.id, "#query", "persisted state");
    assert.equal(typed.value, "persisted state");
  });

  it("records downloads as persistent references outside the workspace", async () => {
    const browsers = facade();
    const { tab } = await openHome(browsers);
    const clicked = await browsers.click(tab.id, "#file");
    assert.equal(clicked.download?.filename, "report.csv");
    const id = clicked.download?.id as string;
    // The reference outlives further navigation.
    await browsers.navigate(tab.id, "page:docs");
    const again = browsers.download(id);
    assert.equal(again.filename, "report.csv");
    const bytes = await readFile(again.path);
    assert.equal(bytes.toString(), "download:report.csv");
    assert.ok(!again.path.startsWith(ws.root), "download must not land in the workspace");
    assert.deepEqual(browsers.downloads().map((d) => d.id).includes(id), true);
  });

  it("saves screenshots into the artifacts directory", async () => {
    const browsers = facade();
    const { tab } = await openHome(browsers);
    const shot = await browsers.screenshot(tab.id, ws.artifacts);
    assert.equal(shot.mimeType, "image/png");
    assert.ok(shot.path.startsWith(ws.artifacts));
    const png = await readFile(shot.path);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("invalid reference semantics (F12.02)", () => {
  it("fails deterministically for unknown tabs and browsers", async () => {
    const browsers = facade();
    await assert.rejects(() => browsers.read("t-nope"), (error: unknown) => (error as { code: string }).code === STALE_REFERENCE);
    await assert.rejects(() => browsers.closeBrowser("b-nope"), (error: unknown) => (error as { code: string }).code === STALE_REFERENCE);
  });

  it("invalidates tab references after close_tab", async () => {
    const browsers = facade();
    const { tab } = await openHome(browsers);
    await browsers.closeTab(tab.id);
    await assert.rejects(() => browsers.read(tab.id), /tab reference is no longer valid/);
  });

  it("invalidates sibling tab references after close_browser but keeps downloads", async () => {
    const browsers = facade();
    const opened = await openHome(browsers);
    const clicked = await browsers.click(opened.tab.id, "#file");
    await browsers.closeBrowser(opened.browser.id);
    await assert.rejects(() => browsers.read(opened.tab.id), /no longer valid/);
    assert.equal(browsers.download(clicked.download?.id as string).filename, "report.csv");
  });

  it("clears every live reference on dispose", async () => {
    const browsers = facade();
    const opened = await openHome(browsers);
    await browsers.click(opened.tab.id, "#file");
    await browsers.dispose();
    assert.deepEqual(browsers.list(), { browsers: [], tabs: [] });
  });
});

describe("browsers tool (F12.02)", () => {
  it("rejects unknown actions through the schema gate", async () => {
    const result = await ws.run(browsersTool, { action: "teleport" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_argument");
  });

  it("runs the six legacy operations through the facade", async () => {
    await fixture();
    const tool = createBrowsersTool({ driver: new StaticSiteDriver(site) });
    const call = async (input: Record<string, unknown>): Promise<ToolResult<unknown>> => ws.run(tool, input);
    const opened = await call({ action: "open", url: "page:home" });
    assert.equal(opened.ok, true);
    const tab = (opened.data as { tab: { id: string } }).tab.id;
    const browser = (opened.data as { browser: { id: string } }).browser.id;
    assert.match((await call({ action: "read", tab })).output as string, /Welcome/);
    assert.match((await call({ action: "type", tab, selector: "#query", text: "hi" })).output as string, /typed into #query/);
    assert.match((await call({ action: "click", tab, selector: "#file" })).output as string, /downloaded report.csv/);
    assert.match((await call({ action: "screenshot", tab })).output as string, /screenshot saved/);
    assert.match((await call({ action: "close_tab", tab })).output as string, /closed tab/);
    const stale = await call({ action: "read", tab });
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, STALE_REFERENCE);
    assert.match((await call({ action: "close_browser", browser })).output as string, /closed browser/);
  });

  it("surfaces missing arguments as invalid_argument", async () => {
    const result = await ws.run(browsersTool, { action: "open" });
    assert.equal(result.error?.code, "invalid_argument");
  });
});
