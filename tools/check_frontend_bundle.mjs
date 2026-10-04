#!/usr/bin/env node
// Measure the built startup graph. Dynamic imports are excluded until opened.
import { readFileSync } from 'node:fs';
import { resolve, dirname, extname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../webapp/dist');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const seen = new Set();
const rows = [];
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
  }
}
for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/g)) {
  if (!/^(?:https?:|data:)/.test(match[1]) && /\.(?:js|css)$/.test(match[1])) visit(match[1]);
}
if (!rows.some(row => row.type === '.js')) throw new Error('No startup JavaScript found in index.html');
const jsGzip = rows.filter(row => row.type === '.js').reduce((sum, row) => sum + row.gzip, 0);
const cssGzip = rows.filter(row => row.type === '.css').reduce((sum, row) => sum + row.gzip, 0);
const report = { initialJsGzip: jsGzip, initialCssGzip: cssGzip, totalGzip: jsGzip + cssGzip, assets: rows };
console.log(JSON.stringify(report, null, 2));
if (jsGzip > 400 * 1024 || cssGzip > 64 * 1024) {
  console.error('FAIL: startup graph exceeds 400 KiB JS / 64 KiB CSS gzip budget.');
  process.exitCode = 1;
} else console.log('PASS: startup bundle budget. Sizes are file estimates, not network or runtime measurements.');
