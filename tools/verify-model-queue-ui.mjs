/** Inspect the built provider request panel in Chromium using isolated fixture state. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'webapp/package.json'));
const { chromium } = require('playwright');
const dist = join(root, 'webapp/dist');
const assets = readdirSync(join(dist, 'assets'));
const asset = (prefix, ext) => assets.find(name => name.startsWith(prefix) && name.endsWith(ext));
const panel = asset('LocalRuntimeMonitor-', '.js');
const react = asset('react-vendor-', '.js');
assert.ok(panel && react, 'build webapp before running this check');
const css = assets.filter(name => name.endsWith('.css') && /^(workbench-|LocalRuntimeMonitor-)/.test(name));
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="zh-CN"><head>${css.map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}</head><body><main id="fixture" style="max-width:900px;margin:32px auto"></main></body></html>`);
  } else if (path.startsWith('/assets/') && assets.includes(path.slice(8))) {
    response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(readFileSync(join(dist, path)));
  } else { response.statusCode = 404; response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, ...(process.env.XUENESS_BROWSER_CHANNEL ? { channel: process.env.XUENESS_BROWSER_CHANNEL } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const language of ['zh', 'en']) {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(lang => localStorage.setItem('xueness.language', lang), language);
    await page.reload();
    await page.evaluate(async ({ panel, react }) => {
      const view = await import(`/assets/${panel}`);
      const runtime = await import(`/assets/${react}`);
      const target = runtime.e.createRoot(document.getElementById('fixture'));
      window.renderRequest = session => target.render(runtime.j.jsx(view.R, { session }));
      window.renderRequest({ status: 'running', runtime_activity: { phase: 'queued_model', requestStep: 1 } });
    }, { panel, react });
    const details = page.getByTestId('request-telemetry');
    await details.locator(':scope > summary').click();
    const queued = language === 'zh' ? '等待并发名额' : 'Waiting for capacity';
    await details.getByText(queued, { exact: true }).last().waitFor();
    const queueLabel = language === 'zh' ? '排队耗时' : 'Queue time';
    assert.equal(await details.locator('.xn-runtime-monitor__request-meta').getByText(queueLabel, { exact: false }).count(), 0);
    await page.evaluate(() => window.renderRequest({ status: 'running', runtime_activity: { phase: 'waiting_model', queuedMs: 1500, requestStep: 1 } }));
    await details.getByText(language === 'zh' ? /^排队耗时 1\.5 秒$/ : /^Queue time 1\.5\s+seconds$/).waitFor();
    await page.evaluate(() => window.renderRequest({ status: 'stopped', runtime_activity: { phase: 'queued_model' } }));
    await details.locator(':scope > summary').getByText(language === 'zh' ? '已停止' : 'Stopped', { exact: true }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    checks.push({ language, queuedLabel: true, unknownQueueTimeOmitted: true, measuredQueueTime: true, stoppedOverridesQueue: true, overflow });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ schema: 'xueness.model-queue-ui.v1', mode: 'built', browser: browser.version(), checks, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
