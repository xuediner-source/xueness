#!/usr/bin/env node
// Measure the built startup graph, including the App loaded by the bootstrap.
import { readFileSync } from 'node:fs';
import { resolve, dirname, extname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../webapp/dist'));
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const seen = new Set();
const rows = [];
let foundBootstrapApp = false;
function visit(path) {
  const absolute = resolve(root, path.replace(/^\//, ''));
  const withinRoot = relative(root, absolute);
  if (withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) throw new Error(`Asset escaped dist: ${path}`);
  if (seen.has(absolute)) return;
  seen.add(absolute);
  const source = readFileSync(absolute);
  const extension = extname(absolute);
  if (!['.js', '.css'].includes(extension)) return;
  rows.push({ asset: relative(root, absolute), type: extension, bytes: source.length, gzip: gzipSync(source).length });
  if (extension === '.js') {
    // Vite emits relative static ESM imports; import(...) remains lazy.
    for (const match of source.toString().matchAll(/(?:\bfrom\s*|\bimport\s*)(["'])(\.\.?\/[^"']+)\1/g)) {
      visit(relative(root, resolve(dirname(absolute), match[2])));
    }
    // The locale bootstrap always loads App asynchronously after the optional
    // English pack. Vite lists that chunk and its CSS in its preload map.
    for (const match of source.toString().matchAll(/["'](assets\/App-[^"']+\.(?:js|css))["']/g)) {
      if (match[1].endsWith('.js')) foundBootstrapApp = true;
      visit(match[1]);
    }
  }
}
for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/g)) {
  if (!/^(?:https?:|data:)/.test(match[1]) && /\.(?:js|css)$/.test(match[1])) visit(match[1]);
}
if (!rows.some(row => row.type === '.js')) throw new Error('No startup JavaScript found in index.html');
if (!foundBootstrapApp) throw new Error('Bootstrap App chunk not found in startup graph');
const jsGzip = rows.filter(row => row.type === '.js').reduce((sum, row) => sum + row.gzip, 0);
const appearances = [...html.matchAll(/<meta\b[^>]*name="xn-appearance-([^"]+)"[^>]*content="([^"]+)"/g)].map(([, palette, path]) => {
  const source = readFileSync(resolve(root, path.replace(/^\//, '')));
  return { palette, asset: path, bytes: source.length, gzip: gzipSync(source).length };
});
if (appearances.length !== 2) throw new Error('Both appearance assets must be emitted and declared');
const baseCssGzip = rows.filter(row => row.type === '.css').reduce((sum, row) => sum + row.gzip, 0);
const cssGzip = baseCssGzip + Math.max(...appearances.map(row => row.gzip));
const oversized = rows.filter(row => row.type === '.js' && row.gzip > 240 * 1024);
const report = { initialJsGzip: jsGzip, initialCssGzip: cssGzip, baseCssGzip,
  cssGzipByPalette: Object.fromEntries(appearances.map(row => [row.palette, baseCssGzip + row.gzip])),
  totalGzip: jsGzip + cssGzip, appearances, assets: rows };
console.log(JSON.stringify(report, null, 2));
if (jsGzip > 408 * 1024 || cssGzip > 64 * 1024 || oversized.length) {
  console.error('FAIL: startup graph exceeds 408 KiB JS / 64 KiB CSS or 240 KiB per JS chunk gzip budget.', oversized);
  process.exitCode = 1;
} else console.log('PASS: startup bundle budget. Sizes are file estimates, not network or runtime measurements.');
