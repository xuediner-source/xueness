import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOnboardingSteps,
  canRequestDesktopPermission,
  completeDesktopPermissionOnboarding,
  desktopPermissionActionLabel,
  initialDesktopPermissionPlatform,
  isDesktopOnboardingAvailable,
  normalizeDesktopPermissionSnapshot,
  requestDesktopPermission,
  startDesktopOnboardingCheck,
  startDesktopPermissionStatusObserver,
  DESKTOP_PERMISSION_REFRESH_INTERVAL_MS,
  type DesktopPermissionSnapshot,
} from "./DesktopPermissionOnboarding";
import { shouldDismissModalOnEscape } from "../shared";

const marker = "?xuenessDesktop=1";
const snapshot: DesktopPermissionSnapshot = {
  platform: "darwin",
  permissions: [
    { id: "accessibility", status: "not-determined", canRequest: true },
    { id: "screen", status: "denied", canRequest: true },
    { id: "fullDisk", status: "unknown", canRequest: false },
    { id: "microphone", status: "not-determined", canRequest: true },
  ],
};

function fakeEvents() {
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const rows = listeners.get(type) ?? new Set<() => void>();
      rows.add(listener as () => void);
      listeners.set(type, rows);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener as () => void);
    },
  };
  return {
    target,
    dispatch(type: string) { for (const listener of listeners.get(type) ?? []) listener(); },
    count(type: string) { return listeners.get(type)?.size ?? 0; },
  };
}

function fakeScheduler() {
  let serial = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  return {
    scheduler: {
      schedule(callback: () => void, delay: number) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
      cancel(handle: unknown) { timers.delete(handle as number); },
    },
    rows() { return Array.from(timers.entries()).map(([id, timer]) => ({ id, ...timer })); },
    fireNext() {
      const first = timers.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
      if (!first) throw new Error("No scheduled status refresh");
      timers.delete(first[0]);
      first[1].callback();
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("automatic onboarding and status reads require the desktop marker and both effective flags", async () => {
  assert.equal(isDesktopOnboardingAvailable(true, true, marker), true);
  assert.equal(isDesktopOnboardingAvailable(false, true, marker), false);
  assert.equal(isDesktopOnboardingAvailable(true, false, marker), false);
  assert.equal(isDesktopOnboardingAvailable(true, true, ""), false);
  assert.equal(isDesktopOnboardingAvailable(true, true, "?xuenessDesktop=0"), false);

  let completionReads = 0;
  const read = async () => { completionReads += 1; return { completed: false as const, version: 1 as const }; };
  for (const flags of [
    { enabled: false, desktopEnabled: true, search: marker },
    { enabled: true, desktopEnabled: false, search: marker },
    { enabled: true, desktopEnabled: true, search: "" },
  ]) {
    startDesktopOnboardingCheck({ ...flags, read, onIncomplete: () => assert.fail("disabled/browser must not open onboarding"), onError: () => assert.fail("no read should fail") });
  }
  const listeners = new Set<() => void>();
  const target = {
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { listeners.add(listener as () => void); },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { listeners.delete(listener as () => void); },
  } as unknown as Window;
  let permissionReads = 0;
  for (const flags of [
    { enabled: false, desktopEnabled: true, search: marker },
    { enabled: true, desktopEnabled: false, search: marker },
    { enabled: true, desktopEnabled: true, search: "" },
  ]) {
    startDesktopPermissionStatusObserver({ ...flags, open: true, target,
      read: async () => { permissionReads += 1; return snapshot; }, onSnapshot: () => {}, onError: () => {}, onLoading: () => {} });
  }
  await Promise.resolve();
  assert.equal(completionReads, 0);
  assert.equal(permissionReads, 0);
  assert.equal(listeners.size, 0);
});

test("first launch opens only for an incomplete saved record and ignores late results after cleanup", async () => {
  let openCount = 0;
  let errorCount = 0;
  const stopCompleted = startDesktopOnboardingCheck({ enabled: true, desktopEnabled: true, search: marker,
    read: async () => ({ completed: true, version: 1 }), onIncomplete: () => { openCount += 1; }, onError: () => { errorCount += 1; } });
  await Promise.resolve();
  assert.equal(openCount, 0);
  stopCompleted();

  const stopIncomplete = startDesktopOnboardingCheck({ enabled: true, desktopEnabled: true, search: marker,
    read: async () => ({ completed: false, version: 1 }), onIncomplete: () => { openCount += 1; }, onError: () => { errorCount += 1; } });
  await Promise.resolve();
  assert.equal(openCount, 1);
  stopIncomplete();

  let signal: AbortSignal | undefined;
  let resolveRead!: (value: { completed: boolean; version: 1 }) => void;
  const stopLate = startDesktopOnboardingCheck({ enabled: true, desktopEnabled: true, search: marker,
    read: currentSignal => { signal = currentSignal; return new Promise(resolve => { resolveRead = resolve; }); },
    onIncomplete: () => { openCount += 1; }, onError: () => { errorCount += 1; } });
  stopLate();
  assert.equal(signal?.aborted, true);
  resolveRead({ completed: false, version: 1 });
  await Promise.resolve();
  assert.equal(openCount, 1);
  assert.equal(errorCount, 0);
});

test("visible polling applies bridge status changes without focus and stays quiet between reads", async () => {
  const events = fakeEvents();
  const timers = fakeScheduler();
  const visibility = Object.assign(events.target, { visibilityState: "visible" }) as unknown as Document;
  let currentSnapshot = snapshot;
  let reads = 0;
  let updates = 0;
  const loading: boolean[] = [];
  const observer = startDesktopPermissionStatusObserver({ enabled: true, desktopEnabled: true, search: marker, open: true,
    target: events.target as unknown as Window, visibilityTarget: visibility, scheduler: timers.scheduler,
    read: async () => { reads += 1; return currentSnapshot; },
    onSnapshot: value => { updates += 1; assert.equal(value, currentSnapshot); },
    onError: () => assert.fail("permission read should succeed"), onLoading: value => loading.push(value) });
  assert.equal(reads, 1);
  await flushPromises();
  assert.equal(updates, 1);
  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(timers.rows().map(row => row.delay), [DESKTOP_PERMISSION_REFRESH_INTERVAL_MS]);

  currentSnapshot = { ...snapshot, permissions: snapshot.permissions.map(permission => permission.id === "screen"
    ? { ...permission, status: "granted", canRequest: false } : permission) };
  timers.fireNext();
  assert.equal(reads, 2);
  await flushPromises();
  assert.equal(updates, 2);
  assert.equal(currentSnapshot.permissions.find(row => row.id === "screen")?.status, "granted");
  assert.deepEqual(loading, [true, false], "silent background refreshes must not make the status line blink");
  observer.stop();
});

test("permission observer coalesces focus, never overlaps reads, pauses while hidden, and cleans up timers", async () => {
  const events = fakeEvents();
  const timers = fakeScheduler();
  let visibilityState: DocumentVisibilityState = "visible";
  Object.defineProperty(events.target, "visibilityState", { get: () => visibilityState });
  const visibility = events.target as unknown as Document;
  const pending: Array<{ signal: AbortSignal; resolve: (value: DesktopPermissionSnapshot) => void }> = [];
  const signals: AbortSignal[] = [];
  let activeReads = 0;
  let maximumActiveReads = 0;
  let reads = 0;
  let updates = 0;
  const observer = startDesktopPermissionStatusObserver({ enabled: true, desktopEnabled: true, search: marker, open: true,
    target: events.target as unknown as Window, visibilityTarget: visibility, scheduler: timers.scheduler,
    read: signal => {
      reads += 1;
      signals.push(signal);
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      return new Promise(resolve => {
        let countedActive = true;
        const uncount = () => {
          if (!countedActive) return;
          countedActive = false;
          activeReads -= 1;
        };
        signal.addEventListener("abort", uncount, { once: true });
        pending.push({ signal, resolve: value => { uncount(); resolve(value); } });
      });
    },
    onSnapshot: () => { updates += 1; }, onError: () => {}, onLoading: () => {} });

  assert.equal(reads, 1);
  events.dispatch("focus");
  events.dispatch("focus");
  observer.refresh();
  assert.equal(reads, 1, "focus and manual refresh during a read should queue one follow-up, not overlap it");
  pending[0].resolve(snapshot);
  await flushPromises();
  assert.equal(reads, 2, "coalesced focus/manual refresh should start after the first read settles");
  pending[1].resolve(snapshot);
  await flushPromises();
  assert.equal(updates, 2);
  assert.equal(maximumActiveReads, 1);
  assert.deepEqual(timers.rows().map(row => row.delay), [DESKTOP_PERMISSION_REFRESH_INTERVAL_MS]);

  visibilityState = "hidden";
  events.dispatch("visibilitychange");
  assert.deepEqual(timers.rows(), [], "hidden windows must stop the timer");
  events.dispatch("focus");
  assert.equal(reads, 2, "hidden windows must not refresh even on focus events");

  visibilityState = "visible";
  events.dispatch("visibilitychange");
  assert.equal(reads, 3, "becoming visible should read immediately");
  assert.equal(events.count("focus"), 1);
  assert.equal(events.count("visibilitychange"), 1);
  visibilityState = "hidden";
  events.dispatch("visibilitychange");
  assert.equal(signals[2].aborted, true, "hiding the app should abort an active status read");
  visibilityState = "visible";
  events.dispatch("visibilitychange");
  assert.equal(reads, 4, "returning to a visible window should restart status reads immediately");
  observer.stop();
  assert.equal(signals[3].aborted, true);
  assert.equal(events.count("focus"), 0);
  assert.equal(events.count("visibilitychange"), 0);
  assert.deepEqual(timers.rows(), []);
  pending[2].resolve({ ...snapshot, permissions: snapshot.permissions.map(row => row.id === "screen" ? { ...row, status: "granted" } : row) });
  pending[3].resolve(snapshot);
  await flushPromises();
  assert.equal(updates, 2, "late responses after close/unmount must not reach UI state");
});

test("Full Disk Access stays unknown, but only macOS host-approved clicks open its settings", () => {
  const normalized = normalizeDesktopPermissionSnapshot({ platform: "darwin", permissions: [
    { id: "fullDisk", status: "granted", canRequest: true },
    { id: "microphone", status: "granted", canRequest: true },
  ] });
  const fullDisk = normalized.permissions.find(row => row.id === "fullDisk");
  assert.deepEqual(fullDisk, { id: "fullDisk", status: "unknown", canRequest: true });
  assert.equal(canRequestDesktopPermission(true, true, "fullDisk", fullDisk, false), true);
  const windows = normalizeDesktopPermissionSnapshot({ platform: "win32", permissions: [{ id: "fullDisk", status: "unknown", canRequest: true }] });
  assert.deepEqual(windows.permissions.find(row => row.id === "fullDisk"), { id: "fullDisk", status: "unsupported", canRequest: false });
  const microphone = { id: "microphone", status: "not-determined", canRequest: true } as const;
  assert.equal(canRequestDesktopPermission(false, true, "microphone", microphone, false), false);
  assert.equal(canRequestDesktopPermission(true, false, "microphone", microphone, false), false);
  assert.equal(canRequestDesktopPermission(true, true, "microphone", microphone, true), false);
  assert.equal(canRequestDesktopPermission(true, true, "microphone", microphone, false), true);
});

test("explicit permission click and skip persist only their fixed POST contracts", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string; signal?: AbortSignal | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(typeof init?.body === "string" ? { body: init.body } : {}), signal: init?.signal });
    const payload = url === "/api/csrf" ? { csrfToken: "test-token" } : url.endsWith("/request") ? snapshot : { completed: true, version: 1 };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await requestDesktopPermission("microphone");
    await requestDesktopPermission("fullDisk");
    await completeDesktopPermissionOnboarding();
    const writes = calls.filter(call => call.method === "POST");
    assert.deepEqual(writes.map(call => [call.url, JSON.parse(call.body ?? "{}")]), [
      ["/api/desktop/permissions/request", { permission: "microphone" }],
      ["/api/desktop/permissions/request", { permission: "fullDisk" }],
      ["/api/onboarding/desktop", { completed: true }],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Windows and other platforms never suggest a macOS Full Disk Access grant", () => {
  for (const platform of ["win32", "linux"]) {
    const normalized = normalizeDesktopPermissionSnapshot({ platform, permissions: [
      { id: "fullDisk", status: "granted", canRequest: true },
    ] });
    const fullDisk = normalized.permissions.find(row => row.id === "fullDisk");
    assert.deepEqual(fullDisk, { id: "fullDisk", status: "unsupported", canRequest: false });
    assert.equal(canRequestDesktopPermission(true, true, "fullDisk", fullDisk, false), false);
  }
});

test("the onboarding modal uses the shared focus-safe Escape policy", () => {
  assert.equal(shouldDismissModalOnEscape({ key: "Escape" }), true);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", isComposing: true }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape" }, true), false);
});

test("Windows wizard is trimmed to the microphone step with Windows copy", () => {
  const mac = buildOnboardingSteps("darwin");
  assert.equal(mac.length, 3);
  assert.deepEqual(mac.map(step => step.body), ["accessibilityScreen", "fullDisk", "microphone"]);
  const windows = buildOnboardingSteps("win32");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].body, "microphone");
  assert.match(windows[0].description, /Windows 设置 → 隐私和安全性 → 麦克风/);
  const allText = windows.map(step => `${step.title} ${step.description}`).join("\n");
  assert.doesNotMatch(allText, /macOS/);
  assert.doesNotMatch(allText, /完全磁盘访问/);
  // Unknown platforms also skip the macOS-only steps.
  assert.equal(buildOnboardingSteps("linux").length, 1);
});

test("desktop permission onboarding does not assume macOS before the native snapshot", () => {
  assert.equal(initialDesktopPermissionPlatform("Win32"), "win32");
  assert.equal(initialDesktopPermissionPlatform("MacIntel"), "darwin");
  assert.equal(initialDesktopPermissionPlatform("Linux x86_64"), "unknown");
  assert.equal(initialDesktopPermissionPlatform(undefined), "unknown");
  assert.equal(buildOnboardingSteps(initialDesktopPermissionPlatform("Linux x86_64")).length, 1);
});

test("Windows microphone request is labeled as a settings action", () => {
  assert.equal(desktopPermissionActionLabel("win32", "microphone", "not-determined"), "打开系统设置");
  assert.equal(desktopPermissionActionLabel("darwin", "microphone", "not-determined"), "允许麦克风");
  assert.equal(desktopPermissionActionLabel("darwin", "microphone", "denied"), "打开系统设置");
});
