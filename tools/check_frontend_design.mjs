#!/usr/bin/env node
// No network or state reads: validate the shared theme against actual consumers.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const src = resolve(root, 'webapp/src');
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(dir, entry.name);
  return entry.isDirectory() ? walk(path) : /\.(?:css|tsx?)$/.test(path) && !path.includes('.test.') ? [path] : [];
}); }
const sources = walk(src).map(path => [relative(root, path), readFileSync(path, 'utf8')]);
const definitions = new Set();
for (const [, source] of sources) {
  for (const match of source.matchAll(/(?:^|[;{])\s*(--[\w-]+)\s*:/gm)) definitions.add(match[1]);
  for (const match of source.matchAll(/["'](--[\w-]+)["']\s*[:,]/g)) definitions.add(match[1]);
}
// This variable is supplied by Radix Select's layout effect, not the theme.
const runtimeVariables = new Set(['--radix-select-content-available-height']);
const errors = [];
for (const [file, source] of sources) for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
  if (!definitions.has(match[1]) && !runtimeVariables.has(match[1])) errors.push(`${file}: undefined ${match[1]}`);
}
const tokens = readFileSync(resolve(src, 'styles/tokens.css'), 'utf8');
const blocks = {};
const tokenSelectors = [':root', '.dark', ':root[data-xn-palette="claude"]', '.dark[data-xn-palette="claude"]'];
for (const selector of tokenSelectors) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...tokens.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'g'))];
  if (matches.length !== 1) errors.push(`tokens.css: expected one ${selector} token block, got ${matches.length}`);
  blocks[selector] = Object.fromEntries([...(matches[0]?.[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}
function luminance(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`contrast color must be an opaque hex value: ${hex}`);
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
// Resolved themes: default light/dark plus optional Codex 风格 (stored as claude) light/dark.
const themes = {
  'default-light': { ...blocks[':root'] },
  'default-dark': { ...blocks[':root'], ...blocks['.dark'] },
  'claude-light': { ...blocks[':root'], ...blocks[':root[data-xn-palette="claude"]'] },
  'claude-dark': { ...blocks[':root'], ...blocks['.dark'], ...blocks['.dark[data-xn-palette="claude"]'] },
};
let minimum = Infinity;
for (const [theme, values] of Object.entries(themes)) {
  for (const fg of ['--fg', '--fg-subtle', '--fg-muted']) for (const bg of ['--bg', '--bg-subtle', '--bg-card', '--bg-window', '--bg-sidebar', '--bg-panel', '--bg-input', '--bg-popover', '--bg-active']) {
    // bg-active is a transparent overlay in light mode; all readable surfaces are checked separately.
    if (!values[bg]?.startsWith('#')) continue;
    try {
      const [light, dark] = [luminance(values[fg]), luminance(values[bg])].sort((a, b) => b - a);
      const ratio = (light + .05) / (dark + .05);
      minimum = Math.min(minimum, ratio);
      if (ratio < 4.5) errors.push(`${theme}: ${fg} on ${bg} contrast ${ratio.toFixed(2)} < 4.5`);
    } catch (error) { errors.push(`${theme}: ${error.message}`); }
  }
}
// Status text sits on its own tint and on cards. The single accent is used for links, active labels and the send action, so it
// must read as text on every page surface and carry its own foreground.
for (const [theme, values] of Object.entries(themes)) {
  const pairs = [['--accent-brand', '--bg'], ['--accent-brand', '--bg-card'], ['--accent-brand', '--bg-panel'], ['--accent-brand-fg', '--accent-brand'],
    ['--ok-fg', '--ok-bg'], ['--warn-fg', '--warn-bg'], ['--error-fg', '--error-bg'], ['--info-fg', '--info-bg'],
    ['--ok-fg', '--bg-card'], ['--warn-fg', '--bg-card'], ['--error-fg', '--bg-card'], ['--info-fg', '--bg-card']];
  for (const [fg, bg] of pairs) {
    try {
      const [light, dark] = [luminance(values[fg] ?? ''), luminance(values[bg] ?? '')].sort((a, b) => b - a);
      const ratio = (light + .05) / (dark + .05);
      minimum = Math.min(minimum, ratio);
      if (ratio < 4.5) errors.push(`${theme}: ${fg} on ${bg} contrast ${ratio.toFixed(2)} < 4.5`);
    } catch (error) { errors.push(`${theme}: ${fg}/${bg}: ${error.message}`); }
  }
}
if (errors.length) { console.error([...new Set(errors)].join('\n')); process.exitCode = 1; }
else console.log(`PASS: theme variables resolve; muted/subtle/body/accent/status text contrast >= ${minimum.toFixed(2)}:1 on checked surfaces (default + Codex 风格).`);
