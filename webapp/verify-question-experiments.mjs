#!/usr/bin/env node
// Production dist + real loopback APIs, isolated state/workspaces, no external or real model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const repo = resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(join(tmpdir(), 'xn-question-experiments-'));
const python = process.env.PYTHON || 'python3';
let server, browser, exit;
const errors = [], unexpected = [];
const source = `
import json, sys
from pathlib import Path
from xueness import core, plugin_runtime, web
root = Path(sys.argv[1]); state = root / 'state'; workspace = root / 'workspace'
state.mkdir(); workspace.mkdir(); (workspace / 'fixture.txt').write_text('fixture content')
settings = {'general': {'sessionsAnswerQuestionEnabled': True, 'toolsCallBudgetEnabled': True, 'toolsCallBudgetLimit': 7, 'language': 'en'}, 'appearance': {'theme': 'dark'}}
(state / 'settings.json').write_text(json.dumps(settings))
(state / 'plugin-state.json').write_text(json.dumps({'apiVersion': 1, 'enabled': {p: p in ('sessions', 'providers', 'settings', 'tools') for p in plugin_runtime.PLUGIN_IDS}}))
store = core.Store(state); sessions = {}
for name, profile in (('standard', 'standard'), ('lightweight', 'lightweight'), ('stale', 'standard'), ('continue', 'standard')):
    item = store.new('Fixture ' + name, workspace); item.update(status='awaiting_user', pending_question='Which folder should I use?', runtime_profile=profile, mode='default')
    store.save(item); sessions[name] = item['id']
ctx = web.build_context(state, root / 'web-runs', Path.cwd(), workspace_roots=[workspace])
ctx['allow_real'] = False
server = web.create_server(0, ctx, '127.0.0.1')
print(json.dumps({'port': server.server_address[1], 'sessions': sessions}), flush=True)
try: server.serve_forever()
finally: server.server_close()
`;
try {
  await readFile(join(repo, 'webapp/dist/index.html'));
  server = spawn(python, ['-u', '-c', source, fixture], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  exit = new Promise(done => server.once('exit', done));
  let stderr = '';
  server.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
  const info = await new Promise((done, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Fixture server startup timed out: ' + stderr)), 15000);
    server.once('exit', code => { clearTimeout(timeout); reject(new Error('Fixture server exited ' + code + ': ' + stderr)); });
    server.stdout.on('data', data => {
      output += data;
      const line = output.split('\n').find(value => value.startsWith('{'));
      if (line) { clearTimeout(timeout); done(JSON.parse(line)); }
    });
  });
  const base = `http://127.0.0.1:${info.port}`;
  const api = async (path, body) => {
    const headers = { Origin: base };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = (await (await fetch(base + '/api/csrf')).json()).csrfToken;
    }
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  let questionRequests = 0, budgetRequests = 0, answerPosts = 0, runPosts = 0;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { unexpected.push(url.href); return route.abort(); }
    if (/\/question$/.test(url.pathname)) questionRequests++;
    if (/\/answer-question$/.test(url.pathname) && route.request().method() === 'POST') answerPosts++;
    if (/\/run$/.test(url.pathname) && route.request().method() === 'POST') runPosts++;
    if (url.pathname === '/api/tools/call-budget') budgetRequests++;
    return route.continue();
  });
  const selectSession = async id => {
    const row = page.getByTestId(`xn-sidebar-item-${id}`);
    await row.waitFor({ state: 'attached' });
    if (!await row.isVisible()) await page.locator('[data-testid="xn-shell-sidebar-toggle"]:visible, [data-testid="xn-desktop-titlebar-sidebar"]:visible').click();
    await row.click();
  };
  await page.goto(base);
  for (const mode of ['standard', 'lightweight']) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await selectSession(info.sessions[mode]);
    await page.getByRole('textbox', { name: 'Your answer', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save answer only', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[id^="question-answer-"]')?.disabled);
    if (mode === 'lightweight') await page.setViewportSize({ width: 420, height: 860 });
    const answerInput = page.getByRole('textbox', { name: 'Your answer', exact: true });
    await answerInput.fill('Use the fixture workspace.');
    const postsBeforeKeyboard = answerPosts;
    await answerInput.press('Alt+Enter');
    await answerInput.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(80);
    assert.equal(answerPosts, postsBeforeKeyboard, 'Alt+Enter and IME confirmation must not submit');
    const geometry = await page.getByTestId('pending-question').boundingBox();
    assert.ok(geometry.width <= (mode === 'lightweight' ? 420 : 1280));
    const snapshot = await api(`/api/sessions/${info.sessions[mode]}/question`);
    const qid = snapshot.data.question.id;
    if (mode === 'lightweight') assert.equal(await page.getByTestId('lightweight-composer').count(), 1);
    await page.screenshot({ path: join(tmpdir(), `xueness-followup-${mode}-20261006.png`), fullPage: true });
    await page.getByRole('button', { name: 'Save answer only', exact: true }).click();
    await page.getByTestId('pending-question').waitFor({ state: 'detached' });
    const detail = await api(`/api/sessions/${info.sessions[mode]}`);
    assert.equal(detail.data.pending_question, null);
    assert.equal(detail.data.status, 'paused');
    const duplicate = await api(`/api/sessions/${info.sessions[mode]}/answer-question`, { questionId: qid, answer: 'Use the fixture workspace.' });
    assert.equal(duplicate.status, 200); assert.equal(duplicate.data.alreadyAnswered, true);
    assert.equal(runPosts, 0, 'saving an answer must not start the model');
    await page.getByRole('button', { name: 'Continue task', exact: true }).waitFor();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(base);
  await selectSession(info.sessions.continue);
  await page.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Continue using the fixture workspace.');
  const runResponse = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${info.sessions.continue}/run`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Answer and continue', exact: true }).click();
  assert.equal((await runResponse).status(), 403, 'the isolated host must refuse real models');
  assert.equal(runPosts, 1, 'explicit answer-and-continue must request exactly one run');
  assert.equal((await api(`/api/sessions/${info.sessions.continue}`)).data.pending_question, null);
  await page.getByRole('button', { name: 'Continue task', exact: true }).waitFor();
  const resumeResponse = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${info.sessions.continue}/run`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Continue task', exact: true }).click();
  assert.equal((await resumeResponse).status(), 403);
  assert.equal(runPosts, 2, 'the explicit resume entry must request a run');
  await page.goto(base);
  await selectSession(info.sessions.stale);
  const draft = page.getByRole('textbox', { name: 'Your answer', exact: true });
  await draft.fill('Keep this draft after a stale answer.');
  assert.equal((await api(`/api/sessions/${info.sessions.stale}/answer`, { answer: 'Answered in another client.' })).status, 200);
  await page.getByRole('button', { name: 'Save answer only', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Answer action failed' }).waitFor();
  assert.equal(await draft.inputValue(), 'Keep this draft after a stale answer.');
  await page.getByRole('button', { name: 'Refresh question', exact: true }).click();
  await page.getByText('The question has changed. Refresh the conversation.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh session', exact: true }).click();
  await page.getByTestId('pending-question').waitFor({ state: 'detached' });
  const budget = await api(`/api/tools/call-budget?session=${info.sessions.stale}`);
  assert.equal(budget.status, 200); assert.equal(budget.data.used, 0); assert.equal(budget.data.remaining, 7);
  assert.equal((await api('/api/settings/general', { values: { sessionsAnswerQuestionEnabled: false, toolsCallBudgetEnabled: false, language: 'en' } })).status, 200);
  await page.reload();
  const beforeQuestions = questionRequests, beforeBudgets = budgetRequests;
  await selectSession(info.sessions.standard);
  await page.waitForTimeout(1200);
  assert.equal(await page.getByTestId('pending-question').count(), 0);
  assert.equal(questionRequests, beforeQuestions); assert.equal(budgetRequests, beforeBudgets);
  assert.equal((await api('/api/settings/general', { values: { toolsCallBudgetEnabled: true } })).status, 200);
  assert.equal((await api('/api/plugins/tools', { enabled: false })).status, 200);
  await page.reload();
  const beforeDisabledBudget = budgetRequests;
  await selectSession(info.sessions.standard);
  await page.waitForTimeout(1200);
  assert.equal(budgetRequests, beforeDisabledBudget, 'disabled tools plugin must not request budget status even with the flag enabled');
  assert.equal(await page.getByTestId('tool-call-budget').count(), 0);
  assert.equal((await api(`/api/tools/call-budget?session=${info.sessions.standard}`)).status, 403);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('PASS: production UI answers/resumes in both modes, narrow layout, stale draft retention, idempotency, flag and plugin request gates.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) server.kill('SIGTERM');
  if (exit) await exit;
  await rm(fixture, { recursive: true, force: true });
}
