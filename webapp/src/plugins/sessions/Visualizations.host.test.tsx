/**
 * The shell page is served with `Content-Security-Policy: sandbox allow-scripts`,
 * so it has an opaque origin and its own `localStorage` throws. Persistence and
 * the content height therefore have to cross the postMessage boundary to the
 * app page, which shares the app's origin. These tests drive that protocol the
 * way `standalone-shell.js` does.
 *
 * The two sources are read from disk rather than imported: the shell is plain
 * browser JavaScript shipped with the skill, and the assertions are about the
 * literal message names both sides must agree on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `npm test` runs from the webapp root; esbuild moves this file, so
// `import.meta.dirname` is the temporary output directory, not the source.
const ROOT = process.cwd();
const SHELL = readFileSync(join(ROOT, "..", "ts", "plugins", "skills", "bundled", "visualize", "assets", "standalone-shell.js"), "utf8");
const APP = readFileSync(join(ROOT, "src", "plugins", "sessions", "Visualizations.tsx"), "utf8");

/** The literal names both sides have to agree on. */
const names = (source: string): string[] => [...source.matchAll(/"(xueness-visualization-[a-z-]+)"/g)].map((match) => match[1]!);

test("the shell and the app page agree on every host message name", () => {
  const shell = new Set(names(SHELL));
  assert.deepEqual([...shell].sort(), ["xueness-visualization-height", "xueness-visualization-state-read", "xueness-visualization-state-write"]);
  for (const name of shell) assert.ok(APP.includes(`"${name}"`), `${name} is handled by the app page`);
});

test("the shell asks the host before falling back to its own storage", () => {
  // `localStorage` in an opaque origin throws, so the host path must come first
  // and the storage path must stay only as the stand-alone fallback.
  const persist = SHELL.slice(SHELL.indexOf("const persistState"), SHELL.indexOf("const persistState") + 700);
  assert.ok(persist.indexOf("xueness-visualization-state-write") < persist.indexOf("storage.setItem"), "host write precedes the local fallback");
  const read = SHELL.slice(SHELL.indexOf("const readSavedState"), SHELL.indexOf("const readSavedState") + 500);
  assert.ok(read.includes("xueness-visualization-state-read"), "the shell reads the host's saved state");
});

test("a height is only reported once the fragment measured itself", () => {
  // Before the inner bridge sends its first `height` message the frame still
  // holds the CSS default (`calc(100vh - 2rem)`), which is not the content's
  // height; reporting it would pin every visualization to the viewport.
  assert.match(SHELL, /let measured = false;/);
  assert.match(SHELL, /if \(hostWindow == null \|\| !measured\) \{\s*\n\s*return;/);
  assert.match(SHELL, /measured = true;\s*\n\s*reportHeight\(\);/);
  assert.ok(APP.includes("MAX_FRAME_HEIGHT"), "the app page bounds the height it accepts");
});
