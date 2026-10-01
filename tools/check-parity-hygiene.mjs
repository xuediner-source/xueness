#!/usr/bin/env node
// Release hygiene gate: native source and built web assets must not load the
// retired shell or depend on the ZCode vendor tree. Historical docs are skipped.
// Usage: node tools/check-parity-hygiene.mjs (Node >= 18; no dependencies)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "webapp", "src");
const DIST = join(ROOT, "webapp", "dist");

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const sourceExtensions = /\.(tsx?|jsx?|css|mjs|cjs)$/;
const releaseExtensions = /\.(html|js|mjs|cjs|css)$/;
const sourceImportPattern = /(?:from|import\s*\(|require\s*\()\s*["']@zcode\/[^"']+["']/g;
const releaseReferencePattern = /(?:@zcode\/|vendor\/zcode|legacy\/ZcodeShell|shell=zcode|material-icons\/)/i;
const sourceIssues = [];
const releaseIssues = [];
for (const retiredPath of ["vendor", "webapp/src/legacy", "webapp/public/material-icons"]) {
  if (existsSync(join(ROOT, retiredPath))) sourceIssues.push(`${retiredPath}: retired tree remains`);
}
let sourceCount = 0;
let releaseCount = 0;

for (const path of walk(SRC)) {
  const rel = relative(ROOT, path);
  if (!sourceExtensions.test(path)) continue;
  sourceCount += 1;
  const text = readFileSync(path, "utf8");
  for (const match of text.matchAll(sourceImportPattern)) {
    sourceIssues.push(`${rel}: ${match[0]}`);
  }
}

for (const path of walk(DIST)) {
  if (!releaseExtensions.test(path)) continue;
  releaseCount += 1;
  const rel = relative(ROOT, path);
  const text = readFileSync(path, "utf8");
  if (releaseReferencePattern.test(`${rel}\n${text}`)) releaseIssues.push(rel);
}
try {
  if (statSync(join(DIST, "material-icons")).isDirectory()) {
    releaseIssues.push("webapp/dist/material-icons/ (retired shell assets)");
  }
} catch {
  // A build without that public asset folder is the expected native release.
}

const nativeEntry = readFileSync(join(SRC, "main.tsx"), "utf8");
const viteConfig = readFileSync(join(ROOT, "webapp", "vite.config.ts"), "utf8");
if (/import\.meta\.glob\s*\([^)]*legacy|legacy\/ZcodeShell|shell\s*===?\s*["']zcode/i.test(nativeEntry)) {
  sourceIssues.push("webapp/src/main.tsx: retired shell route remains");
}
if (/@zcode\/|vendor\/zcode/.test(viteConfig)) {
  sourceIssues.push("webapp/vite.config.ts: vendor alias remains");
}

console.log(`Scanned ${sourceCount} native source files and ${releaseCount} built release assets.`);
if (sourceIssues.length) {
  console.error(`\n✗ Native source/config references remain (${sourceIssues.length}):`);
  for (const issue of sourceIssues) console.error(`  ${issue}`);
}
if (releaseIssues.length) {
  console.error(`\n✗ Built release contains retired-shell/vendor references (${releaseIssues.length}):`);
  for (const issue of releaseIssues) console.error(`  ${issue}`);
}
if (sourceIssues.length || releaseIssues.length) {
  console.error("\nRelease hygiene failed; rebuild after removing the remaining old shell assets.");
  process.exit(1);
}
console.log("✓ Native source, bundler config, and built assets contain no ZCode shell/vendor entries.");
