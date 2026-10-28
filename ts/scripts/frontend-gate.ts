/**
 * Frontend ownership gate, run by `check:plugins`. The TS manifests now own the
 * UI declarations that `tools/check_plugin_architecture.py` audits on the
 * Python manifests (same rules, same messages):
 *
 *  - `panels` equal the panels of the plugin's `XUENESS_PLUGIN_REGISTRY` entry,
 *    and the registry names exactly the bundled plugins;
 *  - each `frontendModules` entry is `<file>` or `<file>#<export>` under
 *    `webapp/src`, a non-test `.ts`/`.tsx` file that exists (with that export),
 *    inside `plugins/<id>/` when it is in a plugin package, and has one owner;
 *  - every other webapp source is shared kernel UI or fully owned, and product
 *    components live under `plugins/` or `ui/`;
 *  - each `desktopModules` entry is an existing `desktop/src/...` file with one
 *    owner, and every file under `desktop/src` is owned.
 *
 * A tree without `webapp/src` (a packaged build) has nothing to check.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** `SHARED_FRONTEND`: kernel UI that no plugin owns. */
export const SHARED_FRONTEND: ReadonlySet<string> = new Set([
  "App.tsx", "main.tsx", "vite-env.d.ts", "i18n.ts", "i18n.en.ts",
  "XuenessShell.tsx", "XuenessWorkbenchContainer.tsx",
  "XuenessPluginManager.tsx", "xuenessPluginRegistry.ts",
  "XuenessCapabilitiesPanel.tsx", "XuenessCapabilityDialog.tsx",
  "xuenessCapabilities.ts", "xuenessApi.ts", "xuenessBridge.ts",
  "xuenessWorkspace.ts", "xuenessFuzzy.ts", "xuenessEvents.ts", "plugins/shared.tsx",
  "ui/CodeContent.tsx", "ui/CodePreview.tsx", "ui/Select.tsx",
  "ui/icons.tsx", "ui/primitives.tsx",
  "xuenessShortcutDisplay.ts",
]);

export interface FrontendManifest {
  id: string;
  panels: readonly string[];
  frontendModules: readonly string[];
  desktopModules: readonly string[];
}

const EXPORTS = /^export (?:async )?(?:function|class|const) (\w+)/gm;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out); else out.push(path);
  }
  return out;
}

const posixPath = (base: string, path: string): string => relative(base, path).split("\\").join("/");
const suffix = (file: string): string => { const name = file.slice(file.lastIndexOf("/") + 1); const dot = name.lastIndexOf("."); return dot > 0 ? name.slice(dot) : ""; };

export function frontendIssues(repo: string, manifests: readonly FrontendManifest[]): string[] {
  const webapp = join(repo, "webapp", "src");
  if (!existsSync(webapp)) return [];
  const errors: string[] = [];
  const ids = new Set(manifests.map((manifest) => manifest.id));
  const registry = readFileSync(join(webapp, "xuenessPluginRegistry.ts"), "utf8");
  const object = /export const XUENESS_PLUGIN_REGISTRY\s*=\s*\{(.*?)\}\s*as const/s.exec(registry);
  const frontend = new Map<string, string[]>();
  for (const [, pid, body] of (object?.[1] ?? "").matchAll(/\b([a-z][a-z0-9_]*)\s*:\s*\{([^{}]*)\}/g)) {
    const panels = /\bpanels:\s*\[([^\]]*)\]/.exec(body!);
    if (frontend.has(pid!)) errors.push("duplicate frontend registry ID: " + pid);
    if (panels) frontend.set(pid!, [...panels[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]!));
  }
  const mismatch = [...new Set([...frontend.keys(), ...ids])].filter((pid) => frontend.has(pid) !== ids.has(pid)).sort();
  if (mismatch.length) errors.push("frontend registry/allowlist mismatch: " + mismatch.join(", "));
  const uiRefs = new Map<string, string>();
  const desktopRefs = new Map<string, string>();
  for (const manifest of manifests) {
    const pid = manifest.id;
    const declared = new Set(manifest.panels), shown = new Set(frontend.get(pid) ?? []);
    if (declared.size !== shown.size || [...declared].some((panel) => !shown.has(panel))) errors.push(pid + ": frontend/backend panel mismatch");
    for (const ref of manifest.frontendModules) {
      if (uiRefs.has(ref)) errors.push(pid + ": multiple frontend owners for " + ref);
      uiRefs.set(ref, pid);
      const cut = ref.indexOf("#");
      const file = cut < 0 ? ref : ref.slice(0, cut), symbol = cut < 0 ? "" : ref.slice(cut + 1);
      const parts = file.split("/");
      if (file.startsWith("/") || parts.includes("..") || ![".ts", ".tsx"].includes(suffix(file)) || file.includes(".test.")) {
        errors.push(pid + ": invalid frontend module " + ref);
        continue;
      }
      let text: string;
      try { text = readFileSync(join(webapp, file), "utf8"); } catch { errors.push(pid + ": missing frontend module " + ref); continue; }
      if (file.startsWith("plugins/") && parts.length > 2 && parts[1] !== pid) errors.push(pid + ": frontend package owned by another plugin " + file);
      if (symbol && ![...text.matchAll(EXPORTS)].some((match) => match[1] === symbol)) errors.push(pid + ": missing frontend export " + ref);
    }
    for (const ref of manifest.desktopModules) {
      if (!ref.startsWith("src/") || ref.split("/").includes("..")) { errors.push(pid + ": invalid desktop module declaration"); continue; }
      if (desktopRefs.has(ref)) errors.push("multiple desktop owners: " + ref);
      desktopRefs.set(ref, pid);
      if (!existsSync(join(repo, "desktop", ref))) errors.push(pid + ": missing desktop module " + ref);
    }
  }
  const refs = [...uiRefs.keys()];
  for (const path of walk(webapp)) {
    const file = posixPath(webapp, path);
    if (![".ts", ".tsx"].includes(suffix(file)) || file.includes(".test.") || SHARED_FRONTEND.has(file)) continue;
    if (suffix(file) === ".tsx" && !file.startsWith("plugins/") && !file.startsWith("ui/")) errors.push("product component outside plugin directory: " + file);
    if (uiRefs.has(file)) {
      if (refs.some((ref) => ref.startsWith(file + "#"))) errors.push("whole-file/export ownership overlap: " + file);
      continue;
    }
    const exports = [...readFileSync(path, "utf8").matchAll(EXPORTS)].map((match) => match[1]!);
    if (!exports.length || exports.some((symbol) => !uiRefs.has(file + "#" + symbol))) errors.push("unowned frontend feature module: " + file);
  }
  const desktop = join(repo, "desktop", "src");
  if (existsSync(desktop)) {
    for (const path of walk(desktop)) {
      const file = posixPath(join(repo, "desktop"), path);
      if (!desktopRefs.has(file)) errors.push("unowned desktop feature module: desktop/" + file);
    }
  }
  return errors;
}
