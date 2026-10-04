// Trusted browser worker. It evaluates no model-provided JavaScript and keeps
// one Playwright page alive for the lifetime of this JSON-lines process.
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const driver = process.env.XUENESS_DESKTOP_PLAYWRIGHT
  ? pathToFileURL(process.env.XUENESS_DESKTOP_PLAYWRIGHT)
  : new URL('../../../webapp/node_modules/playwright/index.mjs', import.meta.url);
let chromium;
try { ({ chromium } = await import(driver)); }
catch { process.stdout.write(JSON.stringify({ available: false, ready: false, reason: 'driver_missing' }) + '\n'); process.exit(1); }
const candidates = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  : process.platform === 'win32' ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).flatMap(root => [resolve(root, 'Google/Chrome/Application/chrome.exe'), resolve(root, 'Microsoft/Edge/Application/msedge.exe')]) : [];
const executablePath = process.env.XUENESS_BROWSER_EXECUTABLE || candidates.find(path => existsSync(path)) || chromium.executablePath();
const available = existsSync(executablePath);
const browser = /msedge/i.test(executablePath) ? 'Edge' : /Google[\\/]Chrome|Google Chrome\.app/i.test(executablePath) ? 'Chrome' : 'Chromium';
if (process.argv[2] === '--probe') {
  process.stdout.write(JSON.stringify({ available, browser: available ? browser : null, reason: available ? null : 'browser_missing' }) + '\n');
  process.exit(0);
}
if (!available) { process.stdout.write(JSON.stringify({ ready: false, reason: 'browser_missing' }) + '\n'); process.exit(1); }
const profile = resolve(process.argv[2]);
await mkdir(profile, { recursive: true, mode: 0o700 });
let context;
try { context = await chromium.launchPersistentContext(profile, {
  headless: true, viewport: { width: 1280, height: 800 }, executablePath,
}); }
catch { process.stdout.write(JSON.stringify({ ready: false, reason: 'launch_failed' }) + '\n'); process.exit(1); }
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(15000);

function inCidr4(address, prefix) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const value = parts.reduce((n, x) => (n * 256 + x) >>> 0, 0);
  const baseParts = prefix[0].split('.').map(Number);
  const base = baseParts.reduce((n, x) => (n * 256 + x) >>> 0, 0);
  const mask = prefix[1] === 0 ? 0 : (0xffffffff << (32 - prefix[1])) >>> 0;
  return (value & mask) === (base & mask);
}

function privateAddress(address) {
  if (isIP(address) === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(prefix => inCidr4(address, prefix));
  }
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) {
    const v4 = value.slice(7);
    return isIP(v4) !== 4 || privateAddress(v4);
  }
  // Conservative IPv6 deny list: unspecified, loopback, ULA, link-local,
  // multicast and documentation ranges are not public web destinations.
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
    /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:');
}

async function publicHttps(urlValue) {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const addresses = await lookup(url.hostname, { all: true });
  return addresses.length > 0 && addresses.every(({ address }) => !privateAddress(address));
}

// This is best-effort application filtering, not an OS network sandbox. Every
// top-level and subresource request is checked, but DNS rebinding remains a
// platform/network boundary concern.
await context.route('**/*', async route => {
  try {
    if (await publicHttps(route.request().url())) return route.continue();
  } catch {}
  return route.abort();
});

try {
  const saved = JSON.parse(await readFile(resolve(profile, 'current.json'), 'utf8'));
  if (typeof saved.url === 'string' && await publicHttps(saved.url)) {
    await page.goto(saved.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  }
} catch {}

process.stdout.write(JSON.stringify({ ready: true }) + '\n');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

async function act(command) {
  const actions = new Set(['navigate', 'inspect', 'click', 'fill', 'screenshot']);
  if (!command || !actions.has(command.action)) throw new Error('invalid action');
  if (command.action === 'navigate') {
    if (!await publicHttps(command.url)) throw new Error('public HTTPS URL required');
    await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } else if (!page.url().startsWith('https://')) {
    throw new Error('navigate to a public HTTPS page first');
  } else if (command.action === 'click') {
    await page.locator(command.selector).first().click();
  } else if (command.action === 'fill') {
    await page.locator(command.selector).first().fill(command.text);
  } else if (command.action === 'screenshot') {
    await page.screenshot({ path: command.output, fullPage: false });
  }
  const current = page.url();
  if (await publicHttps(current)) {
    const temp = resolve(profile, `.current-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify({ url: current }), { flag: 'wx', mode: 0o600 });
    await rename(temp, resolve(profile, 'current.json'));
  }
  if (command.action === 'screenshot') {
    const maxPngBytes = Number.isSafeInteger(command.maxPngBytes)
      ? Math.min(Math.max(command.maxPngBytes, 1), 450 * 1024) : 450 * 1024;
    const bytes = await page.screenshot({ type: 'png', fullPage: false });
    if (bytes.length > maxPngBytes) throw new Error('screenshot exceeds the size limit');
    return { ok: true, url: current.slice(0, 4096), title: (await page.title()).slice(0, 500),
      mimeType: 'image/png', imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      untrusted: true };
  }
  const text = (await page.locator('body').innerText()).slice(0, 16000);
  const anchors = await page.locator('a[href]').all();
  const links = [];
  for (const link of anchors.slice(0, 40)) {
    links.push({ text: (await link.innerText()).slice(0, 200),
      href: ((await link.getAttribute('href')) || '').slice(0, 2048) });
  }
  return { ok: true, url: current.slice(0, 4096), title: (await page.title()).slice(0, 500), text, links,
    untrusted: true };
}

for await (const line of input) {
  if (line.length > 100000) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'request too large' }) + '\n');
    continue;
  }
  try {
    const result = await act(JSON.parse(line));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'browser action failed' }) + '\n');
  }
}
await context.close();
