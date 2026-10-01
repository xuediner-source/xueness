/**
 * Workspace data layer tests: directory browsing, providers, usage, memory
 * tracks, and the flattened settings view, all routed through `xuenessApi`
 * with `globalThis.fetch` stubbed.
 *
 * The contract under test (docs/xueness-batch6.md §3): a failure must surface
 * as `{ok:false, error}` — never a throw, never a silent success — and no test
 * (or production code) builds a URL by hand: the shapes asserted here are the
 * ones `xuenessApi` actually produces.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  userScopeReason,
  loadHome,
  loadDirectory,
  createFolder,
  loadProviders,
  loadUsage,
  loadMemoryTracks,
  loadAllSettings,
} from "./xuenessWorkspace";

type Call = { url: string; method: string; body: unknown; headers: Record<string, unknown> };

type StubResult = { status: number; body?: unknown; /** raw non-JSON payload */ text?: string } | "network-error";

/** Install a fetch stub that records calls and replies via `handler`. */
function stubFetch(handler: (url: string, method: string, body: unknown) => StubResult): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers = (init?.headers ?? {}) as Record<string, unknown>;
    calls.push({ url, method, body, headers });
    const result = handler(url, method, body);
    if (result === "network-error") throw new Error("network down");
    const payload =
      result.text !== undefined
        ? result.text
        : result.body === undefined
          ? ""
          : JSON.stringify(result.body);
    return new Response(payload, {
      status: result.status,
      headers: { "Content-Type": result.text !== undefined ? "text/html" : "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function restoreFetch(original: typeof fetch) {
  globalThis.fetch = original;
}

/* ------------------------------------------------------------------ */
/* userScopeReason（纯函数，不碰网络）                                  */
/* ------------------------------------------------------------------ */

test("userScopeReason extracts the reason string from a capability payload", () => {
  assert.equal(
    userScopeReason({ userScopeAvailable: false, userScopeReason: "read-only workspace" }),
    "read-only workspace",
  );
  assert.equal(
    userScopeReason({ userScopeAvailable: true, userScopeReason: "unused when available" }),
    "unused when available",
  );
});

test("userScopeReason yields \"\" for missing fields, non-strings, and null", () => {
  assert.equal(userScopeReason({ userScopeAvailable: false }), ""); // 字段缺失
  assert.equal(userScopeReason({ userScopeReason: 42 }), ""); // 非字符串
  assert.equal(userScopeReason({ userScopeReason: null }), "");
  assert.equal(userScopeReason(null), "");
  assert.equal(userScopeReason(undefined), "");
  assert.equal(userScopeReason("read-only workspace"), "");
});

/* ------------------------------------------------------------------ */
/* loadHome → GET /api/system                                          */
/* ------------------------------------------------------------------ */

test("loadHome returns homedir from /api/system", async () => {
  const original = globalThis.fetch;
  try {
    const calls = stubFetch((url) => {
      assert.equal(url, "/api/system");
      return { status: 200, body: { homedir: "/Users/fish" } };
    });
    const res = await loadHome();
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value, "/Users/fish");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  } finally {
    restoreFetch(original);
  }
});

test("loadHome reports HTTP 500 without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({ status: 500, body: { error: "boom" } }));
    const res = await loadHome();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /boom/);
  } finally {
    restoreFetch(original);
  }
});

test("loadHome reports network failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => "network-error");
    const res = await loadHome();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /network down/);
  } finally {
    restoreFetch(original);
  }
});

/* ------------------------------------------------------------------ */
/* loadDirectory → GET /api/directory                                  */
/* ------------------------------------------------------------------ */

const DIRECTORY_BODY = {
  path: "/tmp/proj",
  home: "/Users/fish",
  crumbs: [],
  entries: [
    { name: "sub", path: "/tmp/proj/sub", type: "directory", hidden: false },
    { name: ".env", path: "/tmp/proj/.env", type: "file", hidden: true },
    { name: "notes.txt", path: "/tmp/proj/notes.txt", type: "file", hidden: false },
  ],
  truncated: true,
};

test("loadDirectory maps entries to {name,path,isDir,size} and passes truncated through", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch((url) => {
      assert.equal(url, "/api/directory?path=%2Ftmp%2Fproj&includeHidden=1&includeFiles=1");
      return { status: 200, body: DIRECTORY_BODY };
    });
    const res = await loadDirectory("/tmp/proj");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.path, "/tmp/proj");
      assert.equal(res.value.truncated, true);
      assert.deepEqual(res.value.entries, [
        { name: "sub", path: "/tmp/proj/sub", isDir: true, size: 0 },
        { name: ".env", path: "/tmp/proj/.env", isDir: false, size: 0 },
        { name: "notes.txt", path: "/tmp/proj/notes.txt", isDir: false, size: 0 },
      ]);
    }
  } finally {
    restoreFetch(original);
  }
});

test("loadDirectory keeps hidden entries off when includeHidden=false, truncated=false passes through", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch((url) => {
      assert.equal(url, "/api/directory?path=%2Ftmp%2Fproj&includeFiles=1");
      return { status: 200, body: { ...DIRECTORY_BODY, truncated: false } };
    });
    const res = await loadDirectory("/tmp/proj", false);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.truncated, false);
  } finally {
    restoreFetch(original);
  }
});

test("loadDirectory reports a non-JSON response without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({ status: 200, text: "<html>gateway oops</html>" }));
    const res = await loadDirectory("/tmp/proj");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(typeof res.error, "string");
      assert.ok(res.error.length > 0);
    }
  } finally {
    restoreFetch(original);
  }
});

/* ------------------------------------------------------------------ */
/* createFolder → POST /api/directory（先取 CSRF）                      */
/* ------------------------------------------------------------------ */

test("createFolder fetches CSRF then POSTs path+name to /api/directory", async () => {
  const original = globalThis.fetch;
  try {
    const calls = stubFetch((url, method) => {
      if (url === "/api/csrf") return { status: 200, body: { csrfToken: "tok-1" } };
      if (url === "/api/directory" && method === "POST") {
        return { status: 200, body: { path: "/tmp/proj/newdir" } };
      }
      return { status: 404, body: { error: `unexpected ${method} ${url}` } };
    });
    const res = await createFolder("/tmp/proj", "newdir");
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value, "/tmp/proj/newdir");
    assert.deepEqual(
      calls.map((c) => [c.method, c.url]),
      [
        ["GET", "/api/csrf"],
        ["POST", "/api/directory"],
      ],
    );
    assert.deepEqual(calls[1].body, { path: "/tmp/proj", name: "newdir" });
    assert.equal(calls[1].headers["X-CSRF-Token"], "tok-1");
  } finally {
    restoreFetch(original);
  }
});

test("createFolder reports an HTTP failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch((url, method) => {
      if (url === "/api/csrf") return { status: 200, body: { csrfToken: "tok-1" } };
      if (url === "/api/directory" && method === "POST") {
        return { status: 500, body: { error: "mkdir failed" } };
      }
      return { status: 404, body: { error: "unexpected" } };
    });
    const res = await createFolder("/tmp/proj", "newdir");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /mkdir failed/);
  } finally {
    restoreFetch(original);
  }
});

/* ------------------------------------------------------------------ */
/* loadProviders → GET /api/providers                                  */
/* ------------------------------------------------------------------ */

test("loadProviders returns the providers array", async () => {
  const original = globalThis.fetch;
  try {
    const providers = [
      { id: "p1", name: "Primary", baseUrl: "https://api.example.com", model: "m1", hasKey: true },
      { id: "p2", name: "Backup", baseUrl: "https://backup.example.com", model: "m2", hasKey: false },
    ];
    stubFetch((url) => {
      assert.equal(url, "/api/providers");
      return { status: 200, body: { providers } };
    });
    const res = await loadProviders();
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, providers);
  } finally {
    restoreFetch(original);
  }
});

test("loadProviders reports a network failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => "network-error");
    const res = await loadProviders();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /network down/);
  } finally {
    restoreFetch(original);
  }
});

/* ------------------------------------------------------------------ */
/* loadUsage → GET /api/usage?range=...                                */
/* ------------------------------------------------------------------ */

const USAGE_BODY = {
  range: "30d",
  totals: { sessions: 12, steps: 340, completed: 9 },
  series: [{ date: "2026-09-27", sessions: 2, steps: 40 }],
  updatedAt: "2026-09-28T00:00:00Z",
};

test("loadUsage requests the given range and returns the summary", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch((url) => {
      assert.equal(url, "/api/usage?range=30d");
      return { status: 200, body: USAGE_BODY };
    });
    const res = await loadUsage("30d");
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, USAGE_BODY);
  } finally {
    restoreFetch(original);
  }
});

test("loadUsage defaults to the 7d range", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch((url) => {
      assert.equal(url, "/api/usage?range=7d");
      return { status: 200, body: { ...USAGE_BODY, range: "7d" } };
    });
    const res = await loadUsage();
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.range, "7d");
  } finally {
    restoreFetch(original);
  }
});

test("loadUsage reports an HTTP failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({ status: 500, body: { error: "usage unavailable" } }));
    const res = await loadUsage();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /usage unavailable/);
  } finally {
    restoreFetch(original);
  }
});

/* ------------------------------------------------------------------ */
/* loadMemoryTracks → GET /api/memory/tracks                           */
/* ------------------------------------------------------------------ */

test("loadMemoryTracks returns the tracks array", async () => {
  const original = globalThis.fetch;
  try {
    const tracks = [
      { name: "memory", path: "/memory/MEMORY.md", bytes: 1200, present: true },
      { name: "user", path: "/memory/USER.md", bytes: 0, present: false },
    ];
    stubFetch((url) => {
      assert.equal(url, "/api/memory/tracks");
      return { status: 200, body: { tracks } };
    });
    const res = await loadMemoryTracks();
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, tracks);
  } finally {
    restoreFetch(original);
  }
});

test("loadMemoryTracks reports a non-JSON response without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({ status: 200, text: "not json at all" }));
    const res = await loadMemoryTracks();
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(typeof res.error, "string");
      assert.ok(res.error.length > 0);
    }
  } finally {
    restoreFetch(original);
  }
});

/* ------------------------------------------------------------------ */
/* loadAllSettings → GET /api/settings，五分区平铺合并                  */
/* ------------------------------------------------------------------ */

test("loadAllSettings flattens the five sections over defaults, later sections winning", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch((url) => {
      assert.equal(url, "/api/settings");
      return {
        status: 200,
        body: {
          settings: {
            general: { theme: "light", language: "zh" },
            appearance: { theme: "dark", fontSize: 14 },
            shortcuts: { "mod+k": "search" },
            browser: { homepage: "about:blank" },
            agent: { allowMcp: true },
          },
        },
      };
    });
    const defaults = { theme: "dark", onlyInDefaults: true };
    const res = await loadAllSettings(defaults);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.value, {
        theme: "dark", // appearance 覆盖 general 的 "light"
        onlyInDefaults: true, // 服务端没有的 defaults 键保留
        language: "zh",
        fontSize: 14,
        "mod+k": "search",
        homepage: "about:blank",
        allowMcp: true,
      });
    }
    // defaults 对象本身不被改动
    assert.deepEqual(defaults, { theme: "dark", onlyInDefaults: true });
  } finally {
    restoreFetch(original);
  }
});

test("loadAllSettings tolerates missing and malformed sections", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({
      status: 200,
      body: { settings: { appearance: { fontSize: 12 }, agent: "not-an-object" } },
    }));
    const res = await loadAllSettings({ theme: "dark" });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, { theme: "dark", fontSize: 12 });
  } finally {
    restoreFetch(original);
  }
});

test("loadAllSettings reports an HTTP failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({ status: 500, body: { error: "settings unavailable" } }));
    const res = await loadAllSettings({ theme: "dark" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /settings unavailable/);
  } finally {
    restoreFetch(original);
  }
});
