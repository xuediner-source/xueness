#!/usr/bin/env node
// Built UI and real local APIs. No user's state, credentials or real model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { chromium } from 'playwright';

const repo = resolve(import.meta.dirname, '..');
const output = process.env.XUENESS_CLAUDEX_OUTPUT || join(repo, 'claudex-review');
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(join(tmpdir(), 'xn-claudex-review-'));
const source = String.raw`
import json,sys,threading
from pathlib import Path
from xueness import web, plugin_runtime
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.bundled_plugins.sessions.structured_questions import normalize_questions
from xueness.bundled_plugins.sessions.queue import MessageQueue
from xueness.bundled_plugins.providers import providers_api, default_selection
base,repo=map(Path,sys.argv[1:]);workspace=base/'workspace';workspace.mkdir();state=base/'state'
ctx=web.build_context(state,base/'runs',workspace,allow_real=False)
ctx['webapp_dir']=repo/'webapp/dist'
save_settings(state,{'general':{'language':'zh','sessionsAnswerQuestionEnabled':False},'appearance':{'theme':'light','colorPalette':'claude'}})
for name in ('onboarding','diagnostics','updates'):plugin_runtime.set_enabled(state,name,False)
status,result=providers_api._handle_save(ctx,{'id':'layout-fixture','name':'Bonsai 27B 无审查 · 本地轻量验收','baseUrl':'https://127.0.0.1:9/v1','model':'fixture-model','apiKey':'fixture-only','contextWindow':65536,'maxOutputTokens':4096,'reasoningLevels':['none','low','medium','high','xhigh','max']})
assert status==200,result
default_selection.save(state,{'providerId':'layout-fixture','model':'fixture-model'})
store=ctx['store']
def new_fixture(title):
    record=store.new(title,workspace)
    record['model_selection']={'provider_id':'layout-fixture','model':'fixture-model','reasoning_effort':'high'}
    return record
cards=normalize_questions([{'id':'destination','header':'部署位置','question':'你要部署在哪里？','options':[{'label':'本机','description':'仅在当前设备运行'},{'label':'服务器','description':'部署到已配置的服务器'}]},{'id':'details','header':'补充信息','question':'请提供任务需要的补充说明。'}])
question=new_fixture('结构化提问验收')
question.update(status='awaiting_user',pending_question='完成这两项选择后继续。',mode='default')
question['messages'].append({'role':'assistant','content':'','tool_calls':[{'id':'ask-cl','type':'function','function':{'name':'ask_user','arguments':'{}'}}]})
question['results']['ask-cl']={'ok':True,'awaiting_user':True,'question':question['pending_question'],'questions':cards}
question['messages'].append({'role':'tool','tool_call_id':'ask-cl','content':json.dumps(question['results']['ask-cl'],ensure_ascii=False)})
store.save(question)
queued=new_fixture('队列安全编辑验收');queued.update(status='paused',mode='default');store.save(queued)
queue=MessageQueue(store);queue.set_accepting(queued['id'],True)
item=queue.enqueue(queued['id'],'原排队文字',{'text':'原排队文字\n\n保留的附件上下文','metadata':{},'edit_prefix':'原排队文字'},active_run=True)
queue.enqueue(queued['id'],'第二条排队消息',active_run=True);queue.pause_pending(queued['id']);queue.set_accepting(queued['id'],False)
history=new_fixture('资料记录 A');history.update(status='completed',mode='default')
history['messages'].append({'role':'assistant','content':'这是只存在于会话正文的独特关键词。<b>按文字显示</b>'});store.save(history)
pinned=new_fixture('置顶会话对照');pinned.update(status='completed',pinned=True);store.save(pinned)
context=new_fixture('会话信息与来源对照');context.update(status='completed')
(workspace/'result.md').write_text('# 验收输出\n',encoding='utf-8')
for index,(name,args,result) in enumerate([
    ('write',{'path':'result.md','content':'# 验收输出'},{'ok':True}),
    ('read',{'path':'result.md'},{'ok':True,'content':'# 验收输出'}),
    ('web_search',{'query':'验收'},{'ok':True,'results':[{'title':f'资料来源 {i+1}','url':f'https://example.com/source/{i+1}'} for i in range(4)]})
]):
    call_id=f'fixture-tool-{index}'
    context['messages'].append({'role':'assistant','content':'','tool_calls':[{'id':call_id,'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]})
    context['results'][call_id]=result
    context['messages'].append({'role':'tool','tool_call_id':call_id,'content':json.dumps(result,ensure_ascii=False)})
context['messages'].append({'role':'assistant','content':'验收资料已经整理。'});store.save(context)
server=web.create_server(0,ctx);worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
print(json.dumps({'port':server.server_address[1],'question':question['id'],'queued':queued['id'],'queueItem':item['id'],'history':history['id'],'context':context['id']}),flush=True)
try:sys.stdin.buffer.read()
finally:server.shutdown();server.server_close();worker.join(timeout=5)
`;
const child = spawn(process.env.PYTHON || 'python3', ['-u', '-c', source, fixture, repo], {
  cwd: repo, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, XUENESS_API_KEY: '', ANTHROPIC_API_KEY: '', XUENESS_MODEL: '', XUENESS_API_BASE: '', XUENESS_PROVIDER: '', XUENESS_WORKSPACE_ROOTS: '' },
});
const exited = new Promise(done => child.once('exit', done));
const report = { pageErrors: [], externalRequests: [], settingsWrites: [], modelRuns: 0, views: [], interactions: [] };
let browser;
try {
  const info = await new Promise((done, reject) => {
    let text = '', stderr = '';
    const timer = setTimeout(() => reject(new Error('Fixture startup timed out: ' + stderr)), 15000);
    child.stderr.on('data', chunk => stderr = (stderr + chunk).slice(-5000));
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => { text += chunk; const line = text.split('\n').find(value => value.startsWith('{')); if (line) { clearTimeout(timer); done(JSON.parse(line)); } });
  });
  const base = `http://127.0.0.1:${info.port}`;
  const api = async (path, method='GET', body) => {
    const headers = { Origin: base };
    if (body !== undefined) { headers['Content-Type']='application/json'; headers['X-CSRF-Token']=(await (await fetch(base+'/api/csrf')).json()).csrfToken; }
    const response = await fetch(base+path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${method} ${path}: ${response.status}`);
    return response.json();
  };
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/settings/') && request.method()==='POST') report.settingsWrites.push(path);
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { report.externalRequests.push(url.href); return route.abort(); }
    if (/\/run$/.test(url.pathname) && route.request().method()==='POST') report.modelRuns++;
    return route.continue();
  });
  const select = async sid => {
    const row = page.getByTestId(`xn-sidebar-item-${sid}`);
    await row.waitFor({ state: 'attached' });
    if (!await row.isVisible()) await page.locator('[data-testid="xn-shell-sidebar-toggle"]:visible, [data-testid="xn-desktop-titlebar-sidebar"]:visible').click();
    await row.click();
  };
  const snapshot = async name => {
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      palette: document.documentElement.dataset.xnPalette || 'xueness', theme: document.documentElement.dataset.xnTheme,
      background: getComputedStyle(document.documentElement).getPropertyValue('--bg-window').trim(), meta: document.querySelector('meta[name="theme-color"]')?.content }));
    assert.ok(geometry.scrollWidth <= geometry.width + 1, JSON.stringify(geometry));
    assert.equal(geometry.meta, geometry.background);
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    report.views.push({ name, ...geometry });
  };
  await page.goto(base);
  await page.waitForSelector('.xn-shell-layout');
  await page.waitForFunction(() => document.documentElement.dataset.xnPalette==='claudex');
  await page.getByTestId(`xn-sidebar-item-${info.history}`).waitFor();
  await snapshot('claudex-light-home');
  await page.getByRole('button', {name:'首页',exact:true}).waitFor();
  await page.locator('.xn-task-list__recent').waitFor();
  assert.equal(await page.locator('.xn-task-list .xn-shell-nav__time').count(),0);
  const homeLayout = await page.evaluate(() => {
    const rect = document.querySelector('.xn-hero__composer').getBoundingClientRect();
    const pane = document.querySelector('.xn-shell-main__panel').getBoundingClientRect();
    return { bottomGap: pane.bottom-rect.bottom, width:rect.width };
  });
  assert.ok(homeLayout.bottomGap <= 40,JSON.stringify(homeLayout));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');await cdp.send('CSS.enable');
  const documentNode = await cdp.send('DOM.getDocument');
  report.platformFonts = {};
  for (const selector of ['.xn-shell-nav__label','.xn-claudex-sidebar-head__brand','.xn-hero__greeting','.xn-composer__input']) {
    const fontNode = await cdp.send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector});
    report.platformFonts[selector] = (await cdp.send('CSS.getPlatformFontsForNode',{nodeId:fontNode.nodeId})).fonts.map(font=>font.familyName);
    assert.ok(report.platformFonts[selector].every(font=>! /SimSun|Times New Roman/i.test(font)),JSON.stringify(report.platformFonts));
  }

  const taskOptions = page.getByRole('button', { name: '任务操作', exact: true });
  await taskOptions.click();
  await page.getByRole('menu', { name: '任务操作', exact: true }).waitFor();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await taskOptions.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Shift+Tab');
  await page.getByRole('menu', { name: '任务操作', exact: true }).waitFor({ state: 'hidden' });
  await taskOptions.click();
  await page.keyboard.press('Escape');
  assert.equal(await taskOptions.evaluate(el => el === document.activeElement), true);
  assert.equal(await taskOptions.getAttribute('aria-expanded'), 'false');
  report.interactions.push('compact task menu: reverse Tab dismissal and Escape focus return');
  await page.locator('.xn-claudex-sidebar-head__brand').click();
  assert.equal(await page.locator('.xn-claudex-sidebar-head__brand-menu').getAttribute('open'),'');
  await snapshot('claudex-brand-menu');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.xn-claudex-sidebar-head__brand-menu').getAttribute('open'),null);
  await page.locator('.xn-claudex-sidebar-head__activity > summary').click();
  await snapshot('claudex-sidebar-activity');
  await page.locator('.xn-hero__intro').click();
  assert.equal(await page.locator('.xn-claudex-sidebar-head__activity').getAttribute('open'),null);
  report.interactions.push('brand/activity menus: Escape focus return and outside dismissal');

  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: '搜索任务或命令' });
  await search.fill('独特关键词');
  await page.getByTestId(`palette-session-${info.history}`).waitFor();
  await page.getByTestId(`palette-session-${info.history}`).locator('.xn-command-option__snippet').waitFor();
  assert.ok((await page.getByTestId(`palette-session-${info.history}`).innerText()).includes('会话正文'));
  assert.equal(await page.locator('.xn-command-option__snippet b').count(), 0);
  await snapshot('claudex-content-search');
  await page.keyboard.press('Escape');
  report.interactions.push('full-text search, escaped snippet and Escape');

  await select(info.question);
  await page.getByRole('radio', { name: /本机/ }).waitFor();
  const save = page.getByRole('button', { name: '仅保存答复', exact: true });
  assert.equal(await save.isDisabled(), true);
  assert.equal(await page.getByRole('radio', { name: /本机/ }).isChecked(), false);
  await page.getByRole('radio', { name: /本机/ }).check();
  await page.locator(`[id="question-custom-${info.question}-details"]`).fill('完整验收说明');
  assert.equal(await save.isEnabled(), true);
  await snapshot('claudex-light-question');
  await save.click();
  await page.getByRole('button', { name: '继续任务', exact: true }).waitFor();
  assert.equal(report.modelRuns, 0, 'save-only must not start a model run');
  const saved = await api(`/api/sessions/${info.question}`);
  assert.equal(saved.session?.status || saved.status, 'paused');
  report.interactions.push('no preselected choice, all questions required, save-only and explicit resume');

  await select(info.queued);
  await page.getByTestId('session-queue').waitFor();
  const toggle = page.locator('.xn-session-queue__toggle');
  await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.xn-session-queue__items').isVisible(), false);
  await toggle.click();
  await page.getByRole('button', { name: '编辑排队消息', exact: true }).first().click();
  await page.getByRole('textbox', { name: '编辑排队消息', exact: true }).fill('修改后的排队文字');
  const queueResponse = page.waitForResponse(response => response.url().includes(`/queue/${info.queueItem}`) && response.request().method()==='PATCH');
  await page.locator('.xn-session-queue__editor').getByRole('button', { name: '保存', exact: true }).click();
  const patched = await queueResponse;
  assert.ok(patched.ok(), JSON.stringify(await patched.json()));
  await page.locator('.xn-session-queue__editor').waitFor({ state: 'hidden' });
  await page.getByText('修改后的排队文字', { exact: true }).waitFor();
  assert.equal((await api(`/api/sessions/${info.queued}/queue`)).queued_messages[0].text, '修改后的排队文字');
  await snapshot('claudex-queue-edited');
  report.interactions.push('queue collapse, edit through PATCH API, authoritative reload');

  await page.locator('.xn-sidebar-footer__action[data-sidebar-navigate="true"]').click();
  await page.getByTestId('xn-settings-nav-appearance').click();
  const appearance = page.getByRole('radiogroup', { name: '外观', exact: true });
  await appearance.waitFor();
  await page.waitForFunction(() => document.querySelector('.xn-appearance-choice input[value="claudex"]')?.checked);
  await page.waitForFunction(() => !document.querySelector('.xn-code-preview-card__loading'));
  await page.evaluate(()=>document.fonts.ready);
  await snapshot('claudex-appearance-before');
  const settingsGeometry = () => page.evaluate(() => Object.fromEntries(['.xn-settings-view','.xn-settings-view__sidebar','.xn-settings-view__frame','.xn-settings-view__header h1','.xn-settings-view__search'].map(selector=>{
    const node=document.querySelector(selector),rect=node.getBoundingClientRect(),style=getComputedStyle(node);
    return [selector,{x:rect.x,y:rect.y,width:rect.width,height:rect.height,fontSize:style.fontSize,lineHeight:style.lineHeight}];
  })));
  const claudexGeometry = await settingsGeometry();
  const savedXueness = page.waitForResponse(response => response.url().endsWith('/api/settings/appearance') && response.request().method()==='POST').catch(error => { throw error; });
  // Register a rejection handler immediately; a blocked click must preserve
  // the fixture report instead of ending Node on an unhandled rejection.
  void savedXueness.catch(() => {});
  await appearance.locator('.xn-appearance-choice').filter({ hasText: 'Xueness' }).click({ timeout: 5000 });
  assert.ok((await savedXueness).ok());
  await page.waitForFunction(() => !document.documentElement.dataset.xnPalette);
  assert.equal((await api('/api/settings/appearance')).values.colorPalette, 'xueness');
  await page.waitForFunction(() => !document.querySelector('.xn-appearance-choice input[value="xueness"]')?.disabled);
  const xuenessGeometry = await settingsGeometry();
  assert.deepEqual(xuenessGeometry,claudexGeometry,'Appearance switches must preserve settings geometry');
  report.appearanceGeometry={claudex:claudexGeometry,xueness:xuenessGeometry};
  await snapshot('xueness-appearance-settings');
  const savedClaudex = page.waitForResponse(response => response.url().endsWith('/api/settings/appearance') && response.request().method()==='POST');
  void savedClaudex.catch(() => {});
  await appearance.locator('.xn-appearance-choice').filter({ hasText: 'Claudex' }).click();
  assert.ok((await savedClaudex).ok());
  await page.waitForFunction(() => document.documentElement.dataset.xnPalette==='claudex');
  await page.waitForFunction(() => !document.querySelector('.xn-appearance-choice input[value="claudex"]')?.disabled);
  await snapshot('claudex-appearance-settings');
  report.interactions.push('appearance radio cards persist through the production settings API');

  await page.getByRole('button',{name:'返回工作区',exact:true}).click();
  await select(info.context);
  await page.getByRole('button',{name:'会话信息',exact:true}).click();
  const contextPane=page.getByTestId('session-context-pane');
  await contextPane.waitFor();
  await contextPane.getByRole('button',{name:'result.md',exact:true}).first().waitFor();
  await contextPane.getByRole('link',{name:'资料来源 1',exact:true}).waitFor();
  await contextPane.getByRole('button',{name:'查看全部',exact:true}).click();
  await contextPane.getByRole('link',{name:'资料来源 4',exact:true}).waitFor();
  await snapshot('claudex-context-pane');
  await contextPane.getByRole('button',{name:'关闭侧栏',exact:true}).click();
  assert.equal(await contextPane.isVisible(),false);
  await page.getByRole('button',{name:'会话信息',exact:true}).click();
  await contextPane.getByRole('button',{name:'关闭侧栏',exact:true}).focus();
  await page.keyboard.press('Escape');
  await contextPane.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('button',{name:'会话信息',exact:true}).evaluate(el=>el===document.activeElement),true);
  report.interactions.push('live output/source context, source expansion, pane close and explicit file controls');

  for (const palette of ['claudex', 'xueness']) for (const theme of ['light', 'dark']) {
    await api('/api/settings/appearance', 'POST', { values: { colorPalette: palette, theme } });
    await page.reload();
    await select(info.question);
    await page.getByRole('button', { name: '继续任务', exact: true }).waitFor();
    await page.waitForFunction(({palette,theme}) => (document.documentElement.dataset.xnPalette || 'xueness')===palette && document.documentElement.dataset.xnTheme===theme, {palette,theme});
    await snapshot(`${palette}-${theme}-conversation`);
    if (palette === 'claudex' && theme === 'light') {
      await page.waitForFunction(() => document.querySelector('.xn-composer-toolbar__model-trigger')?.textContent.includes('Bonsai 27B'));
      await page.setViewportSize({ width: 940, height: 900 });
      await snapshot('claudex-light-compact-desktop');
      const footer = await page.evaluate(() => {
        const tools = document.querySelector('.xn-composer__tools').getBoundingClientRect();
        const model = document.querySelector('.xn-composer-toolbar__right').getBoundingClientRect();
        const usage = document.querySelector('.xn-usage-quick').getBoundingClientRect();
        return { toolsRight: tools.right, modelRight: model.right, usageLeft: usage.left, usageRight: usage.right };
      });
      assert.ok(footer.modelRight <= footer.usageLeft + 1 && footer.usageRight <= footer.toolsRight + 1, JSON.stringify(footer));
    }
    await page.setViewportSize({ width: 420, height: 860 });
    await page.waitForFunction(() => document.querySelector('.xn-shell-main')?.getBoundingClientRect().width >= innerWidth - 20);
    assert.equal(await page.getByRole('button', { name: '继续任务', exact: true }).isVisible(), true);
    await snapshot(`${palette}-${theme}-narrow`);
    if (palette === 'claudex' && theme === 'light') {
      const toggle = page.getByTestId('xn-shell-sidebar-toggle');
      await toggle.click();
      await page.getByRole('dialog', { name: '侧边栏导航', exact: true }).waitFor();
      await snapshot('claudex-light-narrow-sidebar');
      const placement = await page.evaluate(() => {
        const drawer = document.querySelector('#xn-shell-sidebar').getBoundingClientRect();
        const button = document.querySelector('[data-testid="xn-shell-sidebar-toggle"]').getBoundingClientRect();
        return { drawerRight: drawer.right, buttonLeft: button.left, buttonRight: button.right, width: innerWidth };
      });
      assert.ok(placement.buttonLeft >= placement.drawerRight && placement.buttonRight <= placement.width, JSON.stringify(placement));
      await page.getByTestId('xn-sidebar-action-search').click();
      await page.getByRole('dialog', { name: '命令面板', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'xn-shell-sidebar-toggle');
      assert.equal(await toggle.isVisible(), true);
      report.interactions.push('narrow drawer placement, search dismissal and visible toggle focus return');
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.setViewportSize({width:1280,height:900});
  const nativeGeometry=[];
  for(const palette of ['claudex','xueness']) {
    await api('/api/settings/appearance','POST',{values:{colorPalette:palette,theme:'light'}});
    await page.goto(base+'/?xuenessDesktop=1');
    await page.locator('.xn-sidebar-footer__action[data-sidebar-navigate="true"]').click();
    await page.getByTestId('xn-settings-nav-appearance').click();
    await page.waitForFunction(()=>!document.querySelector('.xn-code-preview-card__loading'));
    await page.waitForFunction(()=>!document.querySelector('.xn-appearance-choice input')?.disabled);
    const geometry=await settingsGeometry();
    geometry.titlebar=await page.locator('.xn-desktop-titlebar').evaluate(node=>({height:node.getBoundingClientRect().height,fontSize:getComputedStyle(node).fontSize}));
    nativeGeometry.push(geometry);
    await snapshot(`${palette}-desktop-chrome-settings`);
  }
  assert.deepEqual(nativeGeometry[0],nativeGeometry[1]);
  assert.equal(nativeGeometry[0].titlebar.height,44);
  report.desktopAppearanceGeometry=nativeGeometry;
  await page.setViewportSize({width:420,height:860});
  assert.equal(await page.locator('.xn-desktop-titlebar').evaluate(node=>node.getBoundingClientRect().height),40);
  await snapshot('xueness-desktop-chrome-narrow-settings');
  report.interactions.push('desktop captions and settings geometry: identical palettes, 44px wide and 40px narrow');
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  console.log(`PASS: Claudex and Xueness built UI, ${report.views.length} views, ${report.interactions.length} interaction groups; no model runs.`);
} finally {
  await writeFile(join(output, 'ui-report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  child.stdin.end();
  await Promise.race([exited, new Promise(done => setTimeout(done, 6000))]);
  if (child.exitCode === null) { child.kill(); await exited; }
  const resolved = await realpath(fixture);
  assert.equal(resolved, resolve(fixture));
  assert.ok(relative(tmpdir(), resolved).startsWith('xn-claudex-review-'));
  await rm(resolved, { recursive: true, force: true });
}
