import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { frontendIssues, type FrontendManifest } from "../frontend-gate.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "frontend-gate-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const REGISTRY = "export const XUENESS_PLUGIN_REGISTRY = {\n  files: { panels: ['files'] },\n  git: { panels: [] },\n} as const;\n";
const manifest = (id: string, extra: Partial<FrontendManifest> = {}): FrontendManifest => ({ id, panels: [], frontendModules: [], desktopModules: [], ...extra });

describe("frontend gate", () => {
  it("accepts owned modules, shared kernel UI and matching panels", () => {
    const root = tree({
      "webapp/src/xuenessPluginRegistry.ts": REGISTRY, "webapp/src/App.tsx": "export function App() {}\n",
      "webapp/src/plugins/files/FileBrowser.tsx": "export function FileBrowser() {}\n",
      "webapp/src/gitHelpers.ts": "export const a = 1;\nexport function b() {}\n", "webapp/src/x.test.ts": "",
      "desktop/src/main.ts": "",
    });
    try {
      const issues = frontendIssues(root, [
        manifest("files", { panels: ["files"], frontendModules: ["plugins/files/FileBrowser.tsx"], desktopModules: ["src/main.ts"] }),
        manifest("git", { frontendModules: ["gitHelpers.ts#a", "gitHelpers.ts#b"] }),
      ]);
      assert.deepEqual(issues, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports what tools/check_plugin_architecture.py reports", () => {
    const root = tree({
      "webapp/src/xuenessPluginRegistry.ts": REGISTRY,
      "webapp/src/plugins/files/FileBrowser.tsx": "export function FileBrowser() {}\n",
      "webapp/src/plugins/git/GitPanel.tsx": "export function GitPanel() {}\n",
      "webapp/src/Loose.tsx": "export function Loose() {}\n", "webapp/src/half.ts": "export const a = 1;\nexport const b = 2;\n",
      "desktop/src/main.ts": "", "desktop/src/stray.ts": "",
    });
    try {
      const issues = frontendIssues(root, [
        manifest("files", { frontendModules: ["plugins/git/GitPanel.tsx", "plugins/files/FileBrowser.tsx#Missing", "../x.ts", "half.ts#a"], desktopModules: ["src/main.ts", "lib/x.ts"] }),
        manifest("git", { panels: ["git"], frontendModules: ["half.ts#a"] }),
        manifest("shell"),
      ]);
      assert.deepEqual(issues, [
        "frontend registry/allowlist mismatch: shell",
        "files: frontend/backend panel mismatch",
        "files: frontend package owned by another plugin plugins/git/GitPanel.tsx",
        "files: missing frontend export plugins/files/FileBrowser.tsx#Missing",
        "files: invalid frontend module ../x.ts",
        "files: invalid desktop module declaration",
        "git: frontend/backend panel mismatch",
        "git: multiple frontend owners for half.ts#a",
        "product component outside plugin directory: Loose.tsx",
        "unowned frontend feature module: Loose.tsx",
        "unowned frontend feature module: half.ts",
        "unowned frontend feature module: plugins/files/FileBrowser.tsx",
        "unowned desktop feature module: desktop/src/stray.ts",
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps every Python manifest declaration in the TS manifests, in order", { skip: existsSync(join(REPO, "xueness", "bundled_plugins")) ? false : "no Python manifests" }, () => {
    for (const id of readdirSync(join(REPO, "ts", "plugins")).sort()) {
      const py = JSON.parse(readFileSync(join(REPO, "xueness", "bundled_plugins", id, "manifest.json"), "utf8")) as Record<string, string[] | undefined>;
      const ts = JSON.parse(readFileSync(join(REPO, "ts", "plugins", id, "manifest.json"), "utf8")) as Record<string, string[] | undefined>;
      for (const key of ["panels", "frontendModules", "desktopModules"]) {
        const want = py[key] ?? [], have = ts[key] ?? [];
        assert.deepEqual(have.slice(0, want.length), want, `${id}.${key}`);
        if (key !== "frontendModules") assert.equal(have.length, want.length, `${id}.${key}`);
      }
    }
  });
});
