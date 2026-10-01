import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmWorkspaceRoot,
  createWorkspaceDirectory,
  isAbsoluteWorkspacePath,
  isPathWithinAllowedRoot,
  isWorkspacePathAllowed,
  loadWorkspaceCatalog,
  saveDefaultWorkspaceRoot,
  workspaceBreadcrumbs,
  loadNativeWorkspacePicker,
  chooseNativeWorkspace,
} from "./xuenessWorkspaces";

test("workspace path preflight enforces absolute paths and directory boundaries", () => {
  assert.equal(isAbsoluteWorkspacePath("/var/work/project"), true);
  assert.equal(isAbsoluteWorkspacePath("relative/project"), false);
  assert.equal(isAbsoluteWorkspacePath("/" + "a".repeat(4096)), false);
  assert.equal(isPathWithinAllowedRoot("/work/app", "/work"), true);
  assert.equal(isPathWithinAllowedRoot("/work/app/", "/work"), true);
  assert.equal(isPathWithinAllowedRoot("/workspace-old", "/workspace"), false);
  assert.equal(isPathWithinAllowedRoot("relative/app", "/work"), false);
  assert.equal(isPathWithinAllowedRoot("/work/../secret", "/work"), false);
  assert.equal(isPathWithinAllowedRoot("C:\\Projects\\App", "c:\\projects"), true);
  assert.equal(isWorkspacePathAllowed("/work/app", [{ path: "/work", label: "Work" }]), true);
  assert.equal(isWorkspacePathAllowed("/etc", [{ path: "/work", label: "Work" }]), false);
});

test("native folder selection is CSRF protected and cancellation remains distinct from a selected root", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; init?: RequestInit }[] = [];
  let cancelled = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push({ path, init });
    const payload = path === "/api/csrf" ? { csrfToken: "test-token" }
      : !init?.method ? { available: true, platform: "darwin" }
      : cancelled ? { cancelled: true } : { root: "/work/new-project" };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await loadNativeWorkspacePicker(), { available: true, platform: "darwin" });
    assert.deepEqual(await chooseNativeWorkspace(), { cancelled: true });
    cancelled = false;
    assert.deepEqual(await chooseNativeWorkspace("/work/current"), { root: "/work/new-project" });
    const writes = calls.filter(call => call.init?.method === "POST");
    assert.equal(writes.length, 2);
    assert.ok(writes.every(call => new Headers(call.init?.headers).get("X-CSRF-Token") === "test-token"));
    assert.deepEqual(JSON.parse(String(writes[0].init?.body)), {});
    assert.deepEqual(JSON.parse(String(writes[1].init?.body)), { initialRoot: "/work/current" });
  } finally { globalThis.fetch = originalFetch; }
});

test("workspace breadcrumbs are derived within the most specific declared root", () => {
  assert.deepEqual(
    workspaceBreadcrumbs("/work/project/src/lib", [
      { path: "/work", label: "Work" },
      { path: "/work/project", label: "Project" },
    ]),
    [
      { path: "/work/project", label: "Project" },
      { path: "/work/project/src", label: "src" },
      { path: "/work/project/src/lib", label: "lib" },
    ],
  );
  assert.deepEqual(workspaceBreadcrumbs("/etc/passwd", [{ path: "/work", label: "Work" }]), []);
});

test("workspace parent navigation may return to the declared root", () => {
  assert.equal(isWorkspacePathAllowed("/work", [{ path: "/work", label: "Work" }]), true);
});

test("workspace API uses host picker, CSRF-protected default and confirm operations", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { path: string; method: string; body?: string; csrf?: string }[] = [];
  const catalog = {
    defaultRoot: "/work/project",
    allowedRoots: [{ path: "/work", label: "Work" }],
    recentDirectories: [{ path: "/work/project", label: "Project", lastUsed: "2026-09-30T00:00:00Z" }],
    picker: { path: "/work/project", parent: "/work", entries: [], truncated: false },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push({ path, method: init?.method ?? "GET", body: init?.body?.toString(), csrf: new Headers(init?.headers).get("X-CSRF-Token") ?? undefined });
    const payload = path === "/api/csrf"
      ? { csrfToken: "test-token" }
      : path.startsWith("/api/workspaces/default")
        ? { defaultRoot: "/work/new-default", allowedRoots: [], recentDirectories: [], picker: { path: null, parent: null, entries: [], truncated: false } }
        : path.startsWith("/api/workspaces/confirm")
          ? { root: "/work/project" }
          : path === "/api/directory"
            ? { path: "/work/project/new-folder" }
            : catalog;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const loaded = await loadWorkspaceCatalog("/work/project");
    assert.equal(loaded.picker.path, "/work/project");
    assert.equal(requests[0].path, "/api/workspaces?path=%2Fwork%2Fproject");
    assert.deepEqual(await saveDefaultWorkspaceRoot("/work/new-default"), { root: "/work/new-default" });
    assert.deepEqual(await confirmWorkspaceRoot("/work/project"), { root: "/work/project" });
    assert.deepEqual(await createWorkspaceDirectory("/work/project", "new-folder"), { path: "/work/project/new-folder" });
    const csrfReads = requests.filter((request) => request.path === "/api/csrf");
    const writes = requests.filter((request) => request.method === "POST");
    assert.equal(csrfReads.length, 3);
    assert.deepEqual(writes.map((request) => request.path), [
      "/api/workspaces/default", "/api/workspaces/confirm", "/api/directory",
    ]);
    assert.ok(writes.every((request) => request.csrf === "test-token"));
    assert.deepEqual(JSON.parse(writes[0].body ?? "{}"), { root: "/work/new-default" });
    assert.deepEqual(JSON.parse(writes[1].body ?? "{}"), { root: "/work/project" });
    assert.deepEqual(JSON.parse(writes[2].body ?? "{}"), { path: "/work/project", name: "new-folder" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
