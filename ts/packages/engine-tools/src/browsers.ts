/**
 * Unified browsers facade (F12.02).
 *
 * One address space over browsers, tabs, downloads and screenshots: every
 * artifact gets a stable reference (`b-…`, `t-…`, `d-…`) that survives
 * navigation, and a handle that outlived its tab/browser resolves to a
 * deterministic `stale_reference` error instead of silently hitting another
 * tab. The facade owns no engine: it drives a `BrowserDriver` port, so the
 * bundled static fixture driver and a real automation driver present the
 * same operations — the same six the fixed browser tools covered: open,
 * navigate/read, click, type, screenshot and close.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { failure, type ToolDefinition, type ToolEnv, type ToolResult } from "./tool.ts";

export const STALE_REFERENCE = "stale_reference";
const MAX_BROWSERS = 4;
const MAX_TABS_PER_BROWSER = 8;
const MAX_DOWNLOADS_KEPT = 32;

export interface DriverNavigation { url: string; finalUrl: string; title: string; status: number }
export interface DriverSnapshot { url: string; title: string; text: string; html: string }
export interface DriverClickResult { clicked: string; navigatedTo?: string; download?: { filename: string; bytes: Uint8Array } }
export interface DriverTypeResult { typed: string; value: string }

/** The port a real automation engine (or the bundled static driver) implements. */
export interface BrowserDriver {
  readonly name: string;
  launch(): Promise<DriverBrowser>;
}

export interface DriverBrowser {
  openTab(url: string): Promise<DriverTab>;
  close(): Promise<void>;
}

export interface DriverTab {
  navigate(url: string): Promise<DriverNavigation>;
  snapshot(): Promise<DriverSnapshot>;
  click(selector: string): Promise<DriverClickResult | null>;
  type(selector: string, text: string): Promise<DriverTypeResult | null>;
  screenshot(): Promise<{ mimeType: string; data: Uint8Array }>;
}

export class BrowsersError extends Error {
  override name = "BrowsersError";
  readonly code: string;
  constructor(code: typeof STALE_REFERENCE | "too_many_browsers" | "too_many_tabs" | "unknown_browser" | "unknown_tab" | "browsers_closed" | "driver_failed", message: string) {
    super(message);
    this.code = code;
  }
}

export interface BrowserInfo { id: string; tabs: string[]; open: boolean; createdAt: string; navigations: number }
export interface TabInfo { id: string; browserId: string; url: string; title: string; navigations: number; createdAt: string }
export interface DownloadInfo { id: string; tabId: string; browserId: string; filename: string; path: string; bytes: number; at: string }

interface TabState { id: string; browserId: string; driverTab: DriverTab; url: string; title: string; navigations: number; createdAt: number; closed: boolean }
interface BrowserState { id: string; driverBrowser: DriverBrowser; tabs: Map<string, TabState>; createdAt: number; navigations: number; closed: boolean }

/** Registry + lifecycle over a driver; references keep working across calls until closed or disposed. */
export class Browsers {
  readonly #browsers = new Map<string, BrowserState>();
  readonly #downloads: DownloadInfo[] = [];
  readonly #downloadsDir: string;
  readonly #driver: BrowserDriver;
  #closed = false;

  constructor(driver: BrowserDriver, options: { downloadsDir: string }) {
    this.#driver = driver;
    this.#downloadsDir = options.downloadsDir;
  }

  get driverName(): string {
    return this.#driver.name;
  }

  async open(url: string): Promise<{ browser: BrowserInfo; tab: TabInfo; navigation: DriverNavigation }> {
    this.#assertOpen();
    if (this.#browsers.size >= MAX_BROWSERS) throw new BrowsersError("too_many_browsers", `at most ${MAX_BROWSERS} browsers stay open`);
    const driverBrowser = await this.#driver.launch();
    const browserId = handle("b", url, this.#browsers.size);
    const state: BrowserState = { id: browserId, driverBrowser, tabs: new Map(), createdAt: Date.now(), navigations: 0, closed: false };
    this.#browsers.set(browserId, state);
    try {
      const tab = await this.#addTab(state, url);
      return { browser: this.browserInfo(state), tab: tabInfo(tab), navigation: await tab.driverTab.snapshot().then((s) => ({ url, finalUrl: s.url, title: s.title, status: 200 })) };
    } catch (error) {
      await this.closeBrowser(browserId).catch(() => undefined);
      throw error;
    }
  }

  async navigate(tabId: string, url: string): Promise<{ tab: TabInfo; navigation: DriverNavigation }> {
    const tab = this.#tab(tabId);
    const navigation = await tab.driverTab.navigate(url);
    tab.url = navigation.finalUrl;
    tab.title = navigation.title;
    tab.navigations += 1;
    this.#browser(tab.browserId).navigations += 1;
    return { tab: tabInfo(tab), navigation };
  }

  async read(tabId: string): Promise<{ tab: TabInfo; snapshot: DriverSnapshot }> {
    const tab = this.#tab(tabId);
    return { tab: tabInfo(tab), snapshot: await tab.driverTab.snapshot() };
  }

  async click(tabId: string, selector: string): Promise<{ tab: TabInfo; clicked: string; navigation?: DriverNavigation; download?: DownloadInfo }> {
    const tab = this.#tab(tabId);
    const result = await tab.driverTab.click(selector);
    if (!result) throw new BrowsersError("driver_failed", `element not found: ${selector}`);
    let navigation: DriverNavigation | undefined;
    if (result.navigatedTo) navigation = (await this.navigate(tabId, result.navigatedTo)).navigation;
    let download: DownloadInfo | undefined;
    if (result.download) download = await this.#recordDownload(tab, result.download.filename, result.download.bytes);
    return { tab: tabInfo(tab), clicked: result.clicked, navigation, download };
  }

  async type(tabId: string, selector: string, text: string): Promise<{ tab: TabInfo; typed: string; value: string }> {
    const tab = this.#tab(tabId);
    const result = await tab.driverTab.type(selector, text);
    if (!result) throw new BrowsersError("driver_failed", `element not found: ${selector}`);
    return { tab: tabInfo(tab), typed: result.typed, value: result.value };
  }

  async screenshot(tabId: string, artifactsDir: string): Promise<{ tab: TabInfo; path: string; mimeType: string; bytes: number }> {
    const tab = this.#tab(tabId);
    const shot = await tab.driverTab.screenshot();
    const path = join(artifactsDir, `${tabId}-${tab.navigations}.png`);
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path, shot.data);
    return { tab: tabInfo(tab), path, mimeType: shot.mimeType, bytes: shot.data.byteLength };
  }

  downloads(): DownloadInfo[] {
    return [...this.#downloads];
  }

  /** A download reference stays valid after navigation and tab close, until the facade is disposed. */
  download(id: string): DownloadInfo {
    const found = this.#downloads.find((d) => d.id === id);
    if (!found) throw new BrowsersError(STALE_REFERENCE, `download reference is no longer valid: ${id}`);
    return found;
  }

  async closeTab(tabId: string): Promise<{ browserId: string; closed: string }> {
    const tab = this.#tab(tabId);
    tab.closed = true;
    this.#browser(tab.browserId).tabs.delete(tabId);
    return { browserId: tab.browserId, closed: tabId };
  }

  async closeBrowser(browserId: string): Promise<{ closed: string; tabs: string[] }> {
    const state = this.#browser(browserId);
    const tabs = [...state.tabs.keys()];
    state.tabs.clear();
    state.closed = true;
    this.#browsers.delete(browserId);
    await state.driverBrowser.close().catch(() => undefined);
    return { closed: browserId, tabs };
  }

  list(): { browsers: BrowserInfo[]; tabs: TabInfo[] } {
    return {
      browsers: [...this.#browsers.values()].map((b) => this.browserInfo(b)),
      tabs: [...this.#browsers.values()].flatMap((b) => [...b.tabs.values()].map(tabInfo)),
    };
  }

  dispose(): Promise<void> {
    this.#closed = true;
    const closers = [...this.#browsers.values()].map((b) => b.driverBrowser.close().catch(() => undefined));
    this.#browsers.clear();
    return Promise.all(closers).then(() => undefined);
  }

  browserInfo(state: BrowserState): BrowserInfo {
    return { id: state.id, tabs: [...state.tabs.keys()], open: !state.closed, createdAt: new Date(state.createdAt).toISOString(), navigations: state.navigations };
  }

  async #addTab(state: BrowserState, url: string): Promise<TabState> {
    if (state.tabs.size >= MAX_TABS_PER_BROWSER) throw new BrowsersError("too_many_tabs", `browser ${state.id} holds at most ${MAX_TABS_PER_BROWSER} tabs`);
    const driverTab = await state.driverBrowser.openTab(url);
    const id = handle("t", `${state.id}/${url}`, state.tabs.size);
    const nav = await driverTab.navigate(url);
    const tab: TabState = { id, browserId: state.id, driverTab, url: nav.finalUrl, title: nav.title, navigations: 1, createdAt: Date.now(), closed: false };
    state.tabs.set(id, tab);
    state.navigations += 1;
    return tab;
  }

  async #recordDownload(tab: TabState, filename: string, bytes: Uint8Array): Promise<DownloadInfo> {
    await mkdir(this.#downloadsDir, { recursive: true });
    const id = handle("d", `${tab.id}/${filename}`, this.#downloads.length);
    const path = join(this.#downloadsDir, `${id}-${filename}`);
    await writeFile(path, bytes);
    const info: DownloadInfo = { id, tabId: tab.id, browserId: tab.browserId, filename, path, bytes: bytes.byteLength, at: new Date().toISOString() };
    this.#downloads.push(info);
    if (this.#downloads.length > MAX_DOWNLOADS_KEPT) this.#downloads.shift();
    return info;
  }

  #assertOpen(): void {
    if (this.#closed) throw new BrowsersError("browsers_closed", "browsers facade is disposed");
  }

  #browser(browserId: string): BrowserState {
    const state = this.#browsers.get(browserId);
    if (!state) throw new BrowsersError(STALE_REFERENCE, `browser reference is no longer valid: ${browserId}`);
    return state;
  }

  #tab(tabId: string): TabState {
    for (const state of this.#browsers.values()) {
      const tab = state.tabs.get(tabId);
      if (tab) return tab;
    }
    throw new BrowsersError(STALE_REFERENCE, `tab reference is no longer valid: ${tabId}`);
  }
}

function handle(prefix: "b" | "t" | "d", seed: string, salt: number): string {
  return `${prefix}-${createHash("sha256").update(`${seed}:${salt}`).digest("hex").slice(0, 10)}`;
}

function tabInfo(tab: TabState): TabInfo {
  return { id: tab.id, browserId: tab.browserId, url: tab.url, title: tab.title, navigations: tab.navigations, createdAt: new Date(tab.createdAt).toISOString() };
}

/**
 * Deterministic fixture driver: serves `page:<name>` URLs from a directory of
 * HTML files, honours `data-href` links, `data-download` anchors and input
 * selectors, and renders a 1×1 PNG screenshot. Used when no automation engine
 * is wired; the facade treats it exactly like a real one.
 */
export class StaticSiteDriver implements BrowserDriver {
  readonly name = "static";
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async launch(): Promise<DriverBrowser> {
    return {
      openTab: async (url: string) => {
        const typed: Record<string, string> = {};
        const load = async (target: string) => {
          const name = target.replace(/^page:/, "");
          const html = await readFile(join(this.#root, `${name}.html`), "utf8");
          return html;
        };
        let current = url;
        let html = await load(current);
        return {
          navigate: async (target: string) => {
            current = target;
            html = await load(target);
            return { url: target, finalUrl: target, title: titleOf(html), status: 200 };
          },
          snapshot: async () => ({ url: current, title: titleOf(html), text: textOf(html), html }),
          click: async (selector: string) => {
            const attrs = elementAttrs(html, selector);
            if (!attrs) return null;
            if (attrs["data-download"]) {
              return { clicked: selector, download: { filename: attrs["data-download"], bytes: new TextEncoder().encode(`download:${attrs["data-download"]}`) } };
            }
            if (attrs["data-href"]) return { clicked: selector, navigatedTo: attrs["data-href"] };
            return { clicked: selector };
          },
          type: async (selector: string, text: string) => {
            const attrs = elementAttrs(html, selector);
            if (!attrs) return null;
            typed[selector] = text;
            return { typed: selector, value: text };
          },
          screenshot: async () => ({ mimeType: "image/png", data: PNG_PIXEL }),
        };
      },
      close: async () => undefined,
    };
  }
}

const PNG_PIXEL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function titleOf(html: string): string {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
}

function textOf(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Attributes of the first element matching `#id` or `.class`, for fixture-level interactions. */
function elementAttrs(html: string, selector: string): Record<string, string> | null {
  const id = /^[.#](.+)/.exec(selector)?.[1];
  if (!id) return null;
  const kind = selector.startsWith("#") ? "id" : "class";
  for (const match of html.matchAll(/<([a-z]+)([^>]*)>/gi)) {
    const attrs: Record<string, string> = {};
    for (const attr of (match[2] ?? "").matchAll(/([a-z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=/>]+)))?/gi)) {
      attrs[(attr[1] ?? "").toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
    }
    if (attrs[kind]?.split(/\s+/).includes(id)) return attrs;
  }
  return null;
}

export interface BrowsersInput {
  action: "open" | "navigate" | "read" | "click" | "type" | "screenshot" | "downloads" | "close_tab" | "close_browser" | "list";
  url?: string;
  tab?: string;
  browser?: string;
  selector?: string;
  text?: string;
}

export interface BrowsersFacadeOptions {
  browsers?: Browsers;
  driver?: BrowserDriver;
  downloadsDir?: string;
}

export function createBrowsersTool(options: BrowsersFacadeOptions = {}): ToolDefinition<BrowsersInput, unknown> {
  let browsers = options.browsers;
  const ready = async (env: ToolEnv): Promise<Browsers> => {
    browsers ??= new Browsers(options.driver ?? new StaticSiteDriver(env.cwd), { downloadsDir: options.downloadsDir ?? join(env.artifactsDir, "downloads") });
    return browsers;
  };
  return {
    name: "browsers",
    gate: "browsers",
    mutating: false,
    concurrencySafe: false,
    // Real pages mean arbitrary hosts; downloads land in the artifacts directory.
    requires: { net: { connect: ["*"] }, fs: { write: ["temp"] } },
    description: [
      "Unified browser facade: open pages, navigate, read, click, type, screenshot and collect downloads through stable references.",
      "open launches a browser and its first tab and returns browser + tab ids; every other action addresses a tab by id.",
      "References survive navigation; using one after close_tab/close_browser returns a stale_reference error.",
      "Downloads are written outside the workspace and stay addressable by id.",
      "Covers the six fixed browser tools (open, read, click, type, screenshot, close) in one call surface.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["open", "navigate", "read", "click", "type", "screenshot", "downloads", "close_tab", "close_browser", "list"] },
        url: { type: "string", minLength: 1, maxLength: 8_192 },
        tab: { type: "string", minLength: 1 },
        browser: { type: "string", minLength: 1 },
        selector: { type: "string", minLength: 1, maxLength: 500 },
        text: { type: "string", maxLength: 10_000 },
      },
      required: ["action"],
    },
    subject: (input) => `browsers:${input.action}`,
    subjectKind: "text",
    async run(input, env): Promise<ToolResult<unknown>> {
      try {
        const facade = await ready(env);
        switch (input.action) {
          case "open": {
            if (!input.url) return failure("invalid_argument", "open needs url");
            const opened = await facade.open(input.url);
            return { ok: true, output: `opened ${opened.navigation.finalUrl} (${opened.navigation.title})\nbrowser ${opened.browser.id} tab ${opened.tab.id}`, data: opened };
          }
          case "navigate": {
            if (!input.tab || !input.url) return failure("invalid_argument", "navigate needs tab and url");
            const moved = await facade.navigate(input.tab, input.url);
            return { ok: true, output: `navigated to ${moved.navigation.finalUrl} (${moved.navigation.title})`, data: moved };
          }
          case "read": {
            if (!input.tab) return failure("invalid_argument", "read needs tab");
            const page = await facade.read(input.tab);
            return { ok: true, output: `${page.snapshot.title}\n${page.snapshot.text.slice(0, 4_000)}`, data: page };
          }
          case "click": {
            if (!input.tab || !input.selector) return failure("invalid_argument", "click needs tab and selector");
            const clicked = await facade.click(input.tab, input.selector);
            return { ok: true, output: clicked.download ? `clicked ${clicked.clicked}; downloaded ${clicked.download.filename} (${clicked.download.bytes} bytes)` : `clicked ${clicked.clicked}`, data: clicked };
          }
          case "type": {
            if (!input.tab || !input.selector || input.text === undefined) return failure("invalid_argument", "type needs tab, selector and text");
            const typed = await facade.type(input.tab, input.selector, input.text);
            return { ok: true, output: `typed into ${typed.typed}`, data: typed };
          }
          case "screenshot": {
            if (!input.tab) return failure("invalid_argument", "screenshot needs tab");
            const shot = await facade.screenshot(input.tab, env.artifactsDir);
            return { ok: true, output: `screenshot saved: ${shot.path} (${shot.bytes} bytes)`, data: shot };
          }
          case "downloads":
            return { ok: true, output: JSON.stringify(facade.downloads(), null, 2), data: { downloads: facade.downloads() } };
          case "close_tab": {
            if (!input.tab) return failure("invalid_argument", "close_tab needs tab");
            const closed = await facade.closeTab(input.tab);
            return { ok: true, output: `closed tab ${closed.closed}`, data: closed };
          }
          case "close_browser": {
            if (!input.browser) return failure("invalid_argument", "close_browser needs browser");
            const closed = await facade.closeBrowser(input.browser);
            return { ok: true, output: `closed browser ${closed.closed} (${closed.tabs.length} tabs)`, data: closed };
          }
          default:
            return { ok: true, output: JSON.stringify(facade.list(), null, 2), data: facade.list() };
        }
      } catch (error) {
        if (error instanceof BrowsersError) return failure(error.code, error.message);
        return failure("driver_failed", error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export const browsersTool = createBrowsersTool();
