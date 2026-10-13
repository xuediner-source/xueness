// Real production bundle and isolated HTTP state. No model request is sent.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'..');
const temporary=await mkdtemp(join(tmpdir(),'xueness-workbench-'));
const output=resolve(process.env.XUENESS_WORKBENCH_OUTPUT || join(root,'artifacts/workbench-preview3'));
await mkdir(output,{recursive:true});
const source=String.raw`
import json,sys,threading
from pathlib import Path
from xueness import web
base,dist=map(Path,sys.argv[1:]);workspace=base/'project-alpha';workspace.mkdir();other=base/'project-beta';other.mkdir();state=base/'state';state.mkdir()
(workspace/'alpha.txt').write_text('alpha workspace contents')
(other/'beta.txt').write_text('beta workspace contents')
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'onboarding':False,'diagnostics':False,'updates':False}}))
(state/'settings.json').write_text(json.dumps({'appearance':{'colorPalette':'xueness','theme':'light'},'general':{'language':'zh'}}))
ctx=web.build_context(state,base/'runs',workspace,allow_real=False,workspace_roots=[other]);ctx['webapp_dir']=dist
def seed(name,root):
    session=ctx['store'].new(name,root)
    session.update(status='completed',runtime_profile='standard')
    session['messages'].append({'role':'assistant','content':'这是用于工作台验收的本地会话。'})
    ctx['store'].save(session);return session['id']
ids=[seed('检查 Alpha 工作区',workspace),seed('检查 Beta 工作区',other)]
server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1],'ids':ids,'roots':[str(workspace),str(other)]}),flush=True)
try:sys.stdin.buffer.read()
finally:server.shutdown();server.server_close()
`;
const script=join(temporary,'server.py');await writeFile(script,source);
const child=spawn(process.env.PYTHON || 'python',[script,temporary,join(root,'webapp/dist')],{
  cwd:root,env:{...process.env,PYTHONPATH:root,XUENESS_MARKETPLACE_URL:'',XUENESS_WORKSPACE_ROOTS:'',
    XUENESS_MODEL:'fixture-local',XUENESS_API_KEY:'fixture-placeholder',XUENESS_PROVIDER:'openai',XUENESS_API_BASE:'http://127.0.0.1:9/v1'},
  windowsHide:true,stdio:['pipe','pipe','pipe']});
let browser,page;
const report={checks:[],errors:[],externalRequests:[],modelRequests:0};
try {
  const ready=await new Promise((accept,reject)=>{
    let text='',stderr='';child.stderr.on('data',data=>stderr+=data);
    child.stdout.on('data',data=>{text+=data;if(text.includes('\n'))accept(JSON.parse(text.split('\n')[0]));});
    child.once('exit',code=>reject(new Error(`Backend exited ${code}: ${stderr}`)));
    setTimeout(()=>reject(new Error(`Backend timeout: ${stderr}`)),20000).unref();
  });
  const origin=`http://127.0.0.1:${ready.port}`;
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:960},colorScheme:'light',reducedMotion:'reduce'});
  page=await context.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin){report.externalRequests.push(url.href);return route.abort();}
    if(url.pathname.endsWith('/run'))report.modelRequests++;
    return route.continue();
  });
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const pick=async id=>{
    const row=page.getByTestId(`xn-sidebar-item-${id}`);
    await row.waitFor({state:'attached'});
    if(!await row.isVisible())await page.getByTestId('xn-desktop-titlebar-sidebar').click();
    await row.click();
    await page.locator(`.xn-workbench-tabs__item[data-session-id="${id}"] [aria-selected="true"]`).waitFor();
    await page.getByTestId('zcode-conversation').waitFor();
    await page.locator('.xn-composer__input:not(:disabled)').waitFor();await settle();
  };
  const tab=id=>page.locator(`.xn-workbench-tabs__item[data-session-id="${id}"] [role="tab"]`);
  const assertVisibleChat=async()=>{
    const rect=await page.locator('.xn-workbench__chat').boundingBox();
    assert.ok(rect.width>=350&&rect.height>=155,`Chat not usable: ${JSON.stringify(rect)}`);
    assert.ok(await page.locator('.xn-composer__input').isVisible());
  };
  await page.goto(`${origin}/?xuenessDesktop=1`);
  await page.getByTestId('xn-workbench-tabs').waitFor();
  await page.locator('.xn-composer__input:not(:disabled)').waitFor();await settle();
  await page.screenshot({path:join(output,'home.png')});
  await pick(ready.ids[0]);await page.locator('.xn-composer__input').fill('Alpha 独立草稿');
  await pick(ready.ids[1]);await page.locator('.xn-composer__input').fill('Beta 独立草稿');
  await tab(ready.ids[0]).click();
  await page.waitForFunction(()=>document.querySelector('.xn-composer__input')?.value==='Alpha 独立草稿');
  report.checks.push('Switching conversation tabs restores each draft');
  await page.getByTestId('xn-workbench-tool-files').click();
  const dock=page.locator('.xn-workbench-dock--right');
  await dock.getByText('alpha.txt',{exact:true}).click();
  await dock.getByText('alpha workspace contents',{exact:true}).waitFor();
  await assertVisibleChat();
  const chatBox=await page.locator('.xn-workbench__chat').boundingBox(),dockBox=await dock.boundingBox();
  assert.ok(dockBox.x>=chatBox.x+chatBox.width-1);
  await page.screenshot({path:join(output,'conversation-files.png')});
  await tab(ready.ids[1]).click();
  await dock.getByText('beta.txt',{exact:true}).waitFor();
  assert.equal(await dock.getByText('alpha.txt',{exact:true}).count(),0);
  await page.waitForFunction(()=>document.querySelector('.xn-composer__input')?.value==='Beta 独立草稿');
  report.checks.push('File dock keeps chat visible and follows the selected workspace');
  await page.getByTestId('xn-workbench-tool-terminal').click();
  const terminal=page.locator('.xn-workbench-dock--bottom');
  await terminal.getByRole('button',{name:'打开工作区终端',exact:true}).waitFor();
  await terminal.getByRole('button',{name:'打开工作区终端',exact:true}).click();
  await terminal.locator('.xterm-screen').waitFor();
  await assertVisibleChat();
  await page.screenshot({path:join(output,'conversation-terminal.png')});
  await terminal.getByRole('button',{name:'关闭面板',exact:true}).click();
  await page.getByTestId('xn-workbench-tool-terminal').click();
  await terminal.getByRole('button',{name:/连接终端/}).click();
  await terminal.locator('.xterm-screen').waitFor();
  report.checks.push('Real terminal opens below chat; hiding the dock preserves the terminal');
  await terminal.getByRole('button',{name:'关闭终端',exact:true}).click();
  await terminal.getByRole('button',{name:'关闭面板',exact:true}).click();
  await page.locator(`.xn-workbench-tabs__item[data-session-id="${ready.ids[1]}"]`).getByTestId('workbench-tab-close').click();
  await tab(ready.ids[0]).waitFor();
  assert.equal(await tab(ready.ids[1]).count(),0);
  await page.getByTestId(`xn-sidebar-item-${ready.ids[1]}`).waitFor();
  await pick(ready.ids[1]);
  await page.waitForFunction(()=>document.querySelector('.xn-composer__input')?.value==='Beta 独立草稿');
  report.checks.push('Closing a tab retains session and draft; sidebar reopens it');
  await page.getByTestId('workbench-tab-new').click();
  await page.getByTestId('xn-hero').waitFor();
  assert.equal(await page.locator('.xn-workbench__workspace').getAttribute('title'),ready.roots[1]);
  await page.locator('.xn-composer__input').fill('新任务草稿');
  await pick(ready.ids[1]);await page.getByTestId('workbench-tab-new').click();
  await page.waitForFunction(()=>document.querySelector('.xn-composer__input')?.value==='新任务草稿');
  await page.reload();await tab(ready.ids[0]).waitFor();await tab(ready.ids[1]).waitFor();
  report.checks.push('New task inherits workspace; drafts and open tabs survive navigation/reload');
  await pick(ready.ids[0]);await page.getByTestId('xn-workbench-tool-files').click();
  await page.setViewportSize({width:550,height:850});
  await page.locator('.xn-workbench-dock--right[data-stacked="true"]').waitFor();await settle();
  await dock.getByText('alpha.txt',{exact:true}).waitFor();
  await assertVisibleChat();
  assert.ok((await page.getByTestId('session-timeline-scroller').boundingBox()).height>=100,'Narrow dock hides the transcript');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(output,'narrow.png')});
  report.checks.push('Narrow view stacks tools beneath chat without horizontal overflow');
  await dock.getByRole('button',{name:'关闭面板',exact:true}).click();
  await page.setViewportSize({width:1440,height:960});
  const appearance=async value=>{
    await page.getByRole('button',{name:'打开设置',exact:true}).click();
    await page.getByTestId('xn-settings-nav-appearance').click();
    await page.locator(`.xn-appearance-choice:has(input[value="${value}"])`).click();
    await page.waitForFunction(expected=>{
      const input=document.querySelector(`.xn-appearance-choice input[value="${expected}"]`);
      return input?.checked && !input.disabled;
    },value);
    await page.getByTestId('xn-settings-back').click();
    await page.locator(`[data-workbench="${value==='claudex'?'codex':'zcode'}"]`).waitFor();
    await settle();
  };
  await appearance('claudex');
  assert.equal(await page.getByTestId('xn-sidebar-rail').count(),1);
  assert.equal(await page.locator('.xn-task-list__toolbar--compact').count(),1);
  assert.equal(await page.getByTestId('xn-workbench-tabs').count(),0);
  await page.waitForFunction(()=>document.querySelector('.xn-composer__input')?.value==='Alpha 独立草稿');
  await page.getByTestId('xn-workbench-tool-files').click();
  await dock.getByText('alpha.txt',{exact:true}).waitFor();
  await assertVisibleChat();
  await page.screenshot({path:join(output,'codex-conversation.png')});
  await dock.getByRole('button',{name:'关闭面板',exact:true}).click();
  await page.getByRole('button',{name:'新聊天',exact:true}).click();
  await page.getByTestId('xn-hero').waitFor();
  assert.equal(await page.locator('.xn-workbench__workspace').getAttribute('title'),ready.roots[0]);
  await page.locator('.xn-composer__input:not(:disabled)').fill('Codex 首页草稿');
  assert.equal(await page.locator('.xn-hero__workspace').count(),1);
  assert.equal(await page.locator('.xn-hero .xn-composer__top-content').count(),0);
  await page.screenshot({path:join(output,'codex-home.png')});
  await page.setViewportSize({width:550,height:850});await settle();
  assert.ok(await page.locator('.xn-composer__input').isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(output,'codex-narrow.png')});
  await page.setViewportSize({width:1440,height:960});
  await page.reload();await page.locator('[data-workbench="codex"]').waitFor();
  await appearance('xueness');
  assert.equal(await page.getByTestId('xn-sidebar-rail').count(),0);
  assert.equal(await page.locator('.xn-task-list__segments').count(),1);
  assert.equal(await page.getByTestId('xn-workbench-tabs').count(),1);
  assert.equal(await page.locator('.xn-hero__workspace').count(),0);
  assert.equal(await page.locator('.xn-hero .xn-composer__top-content').count(),1);
  await page.waitForFunction(()=>document.querySelector('.xn-composer__input')?.value==='Codex 首页草稿');
  await tab(ready.ids[0]).click();
  await page.waitForFunction(()=>document.querySelector('.xn-composer__input')?.value==='Alpha 独立草稿');
  assert.equal(await tab(ready.ids[1]).count(),1);
  report.checks.push('Appearance settings switch between distinct ZCode and Codex layouts, retain drafts/tabs and survive reload');
  await page.evaluate(async()=>{
    const {csrfToken}=await (await fetch('/api/csrf')).json();
    for(const id of ['files','git','terminal']) {
      const response=await fetch(`/api/plugins/${id}`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({enabled:false})});
      if(!response.ok)throw new Error(`Cannot disable ${id}`);
    }
  });
  const disabledRequests=[];
  page.on('request',request=>{if(/\/api\/(terminals|sessions\/[^/]+\/(files|git))/.test(request.url()))disabledRequests.push(request.url());});
  await page.reload();await page.getByTestId('xn-workbench-tabs').waitFor();
  await page.getByTestId('workbench-tab-session').first().click();await page.getByTestId('zcode-conversation').waitFor();
  for(const id of ['files','changes','git','terminal'])assert.equal(await page.getByTestId(`xn-workbench-tool-${id}`).count(),0);
  assert.equal(await page.locator('.xn-workbench-dock').count(),0);
  assert.deepEqual(disabledRequests,[]);
  report.checks.push('Disabled file/Git/terminal plugins mount no dock controls or requests');
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));
  assert.equal(report.externalRequests.length,0);assert.equal(report.modelRequests,0);
  console.log('PASS: '+report.checks.join('; '));
} catch(error) {
  report.failure=String(error.stack||error);
  if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});
  throw error;
} finally {
  await writeFile(join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close();child.stdin.end();
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},5000).unref();});
  await rm(temporary,{recursive:true,force:true});
}
