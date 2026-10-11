#!/usr/bin/env node
// Real production build + isolated Python API. Model execution is intercepted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const repo = resolve(import.meta.dirname, '..');
const output = process.env.XUENESS_SESSION_OUTPUT || join(tmpdir(), 'xueness-session-experience');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'xn-session-experience-'));
const source = String.raw`
import json,sys,threading
from pathlib import Path
from xueness import web,plugin_runtime
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.bundled_plugins.providers import providers_api,default_selection
from xueness.bundled_plugins.sessions.queue import MessageQueue
base,repo=map(Path,sys.argv[1:]);workspace=base/'workspace';workspace.mkdir();state=base/'state'
ctx=web.build_context(state,base/'runs',workspace,allow_real=True)
ctx['webapp_dir']=repo/'webapp/dist'
save_settings(state,{'general':{'language':'zh'},'appearance':{'theme':'light','colorPalette':'xueness'}})
for name in ('onboarding','diagnostics','updates'):plugin_runtime.set_enabled(state,name,False)
code,result=providers_api._handle_save(ctx,{'id':'fixture','name':'Synthetic fixture','baseUrl':'https://127.0.0.1:9/v1','model':'fixture-model','apiKey':'fixture-only'})
assert code==200,result
default_selection.save(state,{'providerId':'fixture','model':'fixture-model'})
fixtures=[]
for title in ('会话可靠性 A','会话可靠性 B'):
 s=ctx['store'].new(title,workspace);s.update(status='completed',model_selection={'provider_id':'fixture','model':'fixture-model'},runtime_profile='standard')
 for i in range(30):
  s['messages'] += [{'role':'user','content':f'问题 {i}：请检查代码'}, {'role':'assistant','content':f'答复 {i}：'+('这里是用于验证阅读位置的长对话。'*12)}]
 s['messages'][-1]['content'] += '\n\n'+chr(96)*3+'text\n'+'\n'.join(f'line {i}: nested scrolling verification' for i in range(90))+'\n'+chr(96)*3
 ctx['store'].save(s);fixtures.append(s['id'])
server=web.create_server(0,ctx);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
print(json.dumps({'port':server.server_address[1],'sessions':fixtures}),flush=True)
try:
 for line in sys.stdin:
  data=json.loads(line)
  if data.get('action')=='append':
   s=ctx['store'].load(data['sid']);s['messages'] += [{'role':'user','content':'后台追加的下一轮'}, {'role':'assistant','content':data['text']}];ctx['store'].save(s)
  elif data.get('action')=='queue':
   q=MessageQueue(ctx['store']);q.set_accepting(data['sid'],True)
   for text in ('排队一\n'+('完整消息预览。'*40),'排队二','排队三'):q.enqueue(data['sid'],text)
   s=ctx['store'].load(data['sid']);s['status']='running';ctx['store'].save(s);ctx['running'].add(data['sid'])
  elif data.get('action')=='finish-stop':
   assert data['sid'] in ctx['stop_requested'],'UI never requested stop'
   ctx['running'].discard(data['sid']);ctx['stop_requested'].discard(data['sid'])
   s=ctx['store'].load(data['sid']);s['status']='cancelled';ctx['store'].save(s)
   q=MessageQueue(ctx['store'])
   q.pause_pending(data['sid'],'Synthetic interruption')
  elif data.get('action')=='drain':
   q=MessageQueue(ctx['store']);q.resume_pending(data['sid'])
   while True:
    item=q.claim_next(data['sid'])
    if not item:break
    q.update(data['sid'],item['id'],'completed')
   q.close_if_empty(data['sid'])
  print(json.dumps({'ack':data['action'],'ticket':data.get('ticket')}),flush=True)
finally:server.shutdown();server.server_close();thread.join(timeout=5)
`;
const child = spawn(process.env.PYTHON || 'python', ['-u', '-c', source, temp, repo], {
  cwd: repo, windowsHide: true, stdio: ['pipe','pipe','pipe'],
  env: { ...process.env, PYTHONPATH: repo, XUENESS_API_KEY: '', XUENESS_MODEL: '', XUENESS_WORKSPACE_ROOTS: '', XUENESS_MARKETPLACE_URL: '' },
});
let browser, releaseMessage, releaseQueueReceipt;
const report = { layouts: [], pageErrors: [], external: [], interceptedRuns: 0, replayedReceipts: 0, modelRequests: 0 };
try {
  const info = await new Promise((accept,reject) => {
    let out='', err=''; const timer=setTimeout(()=>reject(new Error(err||'fixture timeout')),20000);
    child.stderr.on('data', data => { err=(err+data).slice(-8000); });
    child.stdout.on('data', data => { out+=data; if(out.includes('\n')) { clearTimeout(timer); accept(JSON.parse(out.split('\n')[0])); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture ${code}: ${err}`)); });
  });
  const origin=`http://127.0.0.1:${info.port}`;
  const command = data => new Promise((accept, reject) => {
    const ticket=crypto.randomUUID();let buffer='';
    const finish=()=>{child.stdout.off('data',receive);clearTimeout(timer);};
    const receive=chunk=>{buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines){const value=JSON.parse(line);if(value.ticket===ticket){finish();accept(value);}}};
    const timer=setTimeout(()=>{finish();reject(new Error(`fixture command timed out: ${data.action}`));},10000);
    child.stdout.on('data',receive);child.stdin.write(JSON.stringify({...data,ticket})+'\n');
  });
  const api = async(path, body) => {
    const csrf = (await (await fetch(origin+'/api/csrf')).json()).csrfToken;
    const response=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
    assert.ok(response.ok, await response.text());
  };
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
  for(const palette of ['xueness','claudex']) for(const theme of ['light','dark']) for(const width of [1280,420]) {
    await api('/api/settings/appearance',{values:{theme,colorPalette:palette}});
    const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
    const page=await context.newPage();page.setDefaultTimeout(15000);
    page.on('pageerror',error=>report.pageErrors.push(error.message));
    let failSnapshot=true, reads=0, rejectSend=false, droppedQueueRequest;
    await page.route('**/*',async route=>{
      const request=route.request(), url=new URL(request.url());
      if(url.origin!==origin){report.external.push(url.href);return route.abort();}
      if(url.pathname.endsWith('/run')&&request.method()==='POST'){
        assert.equal(request.postDataJSON().continue_queue,true,'only explicit queue continuation is allowed');
        report.interceptedRuns++;await command({action:'drain',sid:info.sessions[1]});
        return route.fulfill({status:200,contentType:'application/json',body:'{}'});
      }
      if(url.pathname===`/api/sessions/${info.sessions[0]}/conversation`){
        reads++;
        if(failSnapshot){failSnapshot=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic first read failure'})});}
      }
      if(url.pathname.endsWith('/queue')&&request.method()==='POST'){
        if(!droppedQueueRequest){
          droppedQueueRequest=request.postDataJSON();const accepted=await route.fetch();assert.equal(accepted.status(),202);
          await new Promise(done=>{releaseQueueReceipt=done;});releaseQueueReceipt=undefined;
          return route.abort('failed');
        }
        assert.deepEqual(request.postDataJSON(),droppedQueueRequest);
        const replay=await route.fetch();assert.equal((await replay.json()).replayed,true);report.replayedReceipts++;
        return route.fulfill({response:replay});
      }
      if(rejectSend&&url.pathname.endsWith('/messages')&&request.method()==='POST'){
        await new Promise(done=>{releaseMessage=done;}); releaseMessage=undefined;
        try { return await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic delayed rejection'})}); }
        catch { /* Reload may cancel this intentionally held request. */ }
        return;
      }
      return route.continue();
    });
    const select=async sid=>{
      const row=page.getByTestId(`xn-sidebar-item-${sid}`);await row.waitFor({state:'attached'});
      if(!await row.isVisible())await page.locator('[data-testid="xn-shell-sidebar-toggle"]:visible, [data-testid="xn-desktop-titlebar-sidebar"]:visible').click();
      await row.click();await page.getByTestId('zcode-conversation').waitFor();
    };
    await page.goto(origin);await select(info.sessions[0]);
    assert.ok(reads>=2,'first read failure must recover automatically');
    await page.waitForFunction(({palette,theme})=>(document.documentElement.dataset.xnPalette||'xueness')===palette&&document.documentElement.dataset.xnTheme===theme,{palette,theme});
    const input=page.locator('textarea.xn-composer__input');
    const heldRequest = async read => {
      const deadline=Date.now()+10000;
      while(!read()&&Date.now()<deadline)await new Promise(done=>setTimeout(done,20));
      assert.ok(read(),'submission did not reach the held request');return read();
    };
    rejectSend=true;
    await input.fill('  要找回的原始消息  ');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByTestId('composer-sending').waitFor();
    await input.fill('发送期间新写的内容');
    await page.waitForFunction(()=>document.querySelector('[data-testid="composer-sending"]')!==null);
    (await heldRequest(()=>releaseMessage))();
    await page.getByTestId('composer-recovery').waitFor();
    assert.equal(await input.inputValue(),'发送期间新写的内容');
    await page.getByTestId('composer-recovery').locator('summary').click();
    await page.getByRole('button',{name:'恢复草稿',exact:true}).click();
    assert.equal(await input.inputValue(),'  要找回的原始消息  ');
    assert.match(await page.getByTestId('composer-recovery').innerText(),/发送期间新写的内容/);
    await select(info.sessions[1]);await input.fill('属于另一个会话');
    await select(info.sessions[0]);assert.equal(await input.inputValue(),'  要找回的原始消息  ');
    await page.reload();await select(info.sessions[0]);
    assert.equal(await input.inputValue(),'  要找回的原始消息  ');
    await page.getByTestId('composer-recovery').waitFor();
    const scroller=page.getByTestId('session-timeline-scroller');
    await scroller.focus();await page.keyboard.press('PageUp');
    await page.getByTestId('session-back-to-bottom').waitFor();
    // Native PageUp scrolls asynchronously even with reduced motion. Record a
    // settled reading position, not an intermediate keyboard animation frame.
    await scroller.evaluate(node => new Promise(done => {
      let top=node.scrollTop, since=performance.now();
      const frame=()=>{const now=performance.now();if(node.scrollTop!==top){top=node.scrollTop;since=now;}
        if(now-since>=200)done();else requestAnimationFrame(frame);};requestAnimationFrame(frame);
    }));
    const before=await scroller.evaluate(node=>node.scrollTop);
    const marker=`新增输出 ${palette}-${theme}-${width}`;
    // A desktop can lose Internet access while its loopback API remains live.
    await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:false});window.dispatchEvent(new Event('offline'));});
    await command({action:'append',sid:info.sessions[0],text:marker});
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    try { await page.getByText('有新内容 · 回到底部',{exact:true}).waitFor(); }
    catch (error) {
      await page.screenshot({path:join(output,'failure.png')});
      console.log(JSON.stringify({reads,before,state:await scroller.evaluate(node=>({top:node.scrollTop,height:node.scrollHeight,client:node.clientHeight})),
        tail:await page.getByTestId('session-back-to-bottom').allTextContents(),body:(await page.locator('body').innerText()).slice(-2800)},null,2));
      throw error;
    }
    const after=await scroller.evaluate(node=>node.scrollTop);
    await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:true});window.dispatchEvent(new Event('online'));});
    assert.ok(Math.abs(after-before)<80,`reading position moved ${before} -> ${after}`);
    await page.getByTestId('session-back-to-bottom').click();
    await page.getByText(marker,{exact:true}).waitFor();
    assert.equal(await page.getByTestId('session-back-to-bottom').count(),0);
    // A real code block is made vertically scrollable to exercise nested wheel ownership.
    const code=page.locator('.xn-zc-answer pre').last();
    await code.evaluate(node=>{node.style.maxHeight='120px';node.style.overflowY='auto';node.scrollTop=80;});
    await code.dispatchEvent('wheel',{deltaY:-30,bubbles:true});
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    assert.equal(await page.getByTestId('session-back-to-bottom').count(),0,'inner code scrolling must keep the conversation anchored');
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    assert.equal(overflow,false);
    await page.getByTestId('composer-recovery').locator('summary').click();
    await page.screenshot({path:join(output,`${palette}-${theme}-${width}.png`)});
    // Refresh while the server response is held. Both drafts must survive,
    // with uncertain delivery explicitly distinguished from an unsent draft.
    await input.fill('刷新前等待确认的消息');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.getByTestId('composer-sending').waitFor();
    await input.fill('刷新后还应保留的新输入');
    await heldRequest(()=>releaseMessage);
    await page.reload();releaseMessage?.();await select(info.sessions[0]);
    assert.equal(await input.inputValue(),'刷新后还应保留的新输入');
    await page.getByTestId('composer-recovery').locator('summary').click();
    await page.getByText('刷新前等待确认的消息',{exact:true}).waitFor();
    await page.getByText('消息接收状态暂时无法确认，请先查看会话与队列再重试。',{exact:true}).waitFor();
    assert.equal(await page.getByTestId('composer-sending').count(),0);
    await page.screenshot({path:join(output,`${palette}-${theme}-${width}-reloaded.png`)});
    // Exercise real Python queue mutations (no model): preview, reorder, edit,
    // cancellation and the explicit continuation handoff.
    await command({action:'queue',sid:info.sessions[1]});await select(info.sessions[1]);
    const queue=page.getByTestId('session-queue'), rows=queue.locator('.xn-session-queue__item');
    await queue.waitFor();assert.equal(await rows.count(),3);
    await input.fill('接收成功但响应丢失的排队消息');
    await page.getByTestId('composer-queue').click();
    await page.getByTestId('composer-sending').waitFor();
    await input.fill('排队期间继续输入的草稿');
    (await heldRequest(()=>releaseQueueReceipt))();
    await page.waitForFunction(()=>document.querySelectorAll('.xn-session-queue__item').length===4);
    assert.equal(await input.inputValue(),'排队期间继续输入的草稿');
    assert.equal(await queue.getByText('接收成功但响应丢失的排队消息',{exact:true}).count(),1);
    await rows.last().getByRole('button',{name:'取消排队',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.xn-session-queue__item').length===3);
    const stopped=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/stop'));
    await input.press('Escape');assert.equal((await (await stopped).json()).stopping,true);
    assert.equal(await input.inputValue(),'排队期间继续输入的草稿');
    await command({action:'finish-stop',sid:info.sessions[1]});
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await queue.getByRole('button',{name:'继续执行队列',exact:true}).waitFor();
    await queue.getByLabel('查看完整排队消息').click();
    await queue.locator('pre').waitFor();
    await rows.first().getByRole('button',{name:'下移排队消息',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.xn-session-queue__item .xn-session-queue__copy p')?.textContent==='排队二');
    await rows.first().getByRole('button',{name:'编辑排队消息',exact:true}).click();
    await queue.getByRole('textbox',{name:'编辑排队消息',exact:true}).fill('修改后的排队消息');
    await queue.getByRole('button',{name:'保存',exact:true}).click();
    await queue.getByText('修改后的排队消息',{exact:true}).waitFor();
    await rows.last().getByRole('button',{name:'取消排队',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.xn-session-queue__item').length===2);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:join(output,`${palette}-${theme}-${width}-queue.png`)});
    await queue.getByRole('button',{name:'继续执行队列',exact:true}).click();
    await queue.waitFor({state:'detached'});
    report.layouts.push({palette,theme,width,loadRecovery:true,draftRecovery:true,scopeIsolation:true,reload:true,
      pendingReload:true,offlineLoopback:true,readingAnchor:true,nestedScroll:true,queueReceiptReplay:true,stop:true,
      queuePreview:true,queueReorder:true,queueEdit:true,queueCancel:true,queueContinue:true});
    await context.close();
  }
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.external,[]);assert.equal(report.modelRequests,0);assert.equal(report.interceptedRuns,8);assert.equal(report.replayedReceipts,8);
  await writeFile(join(output,'verification.json'),JSON.stringify(report,null,2));
  console.log(`PASS: ${report.layouts.length} built session layouts; draft/reconnect/scroll scenarios, no model calls. ${output}`);
} finally {
  releaseMessage?.();releaseQueueReceipt?.();await browser?.close();child.stdin.end();
  await new Promise(done=>{if(child.exitCode!==null)done();else{child.once('exit',done);setTimeout(()=>{child.kill();done();},5000).unref();}});
  assert.ok(resolve(temp).startsWith(resolve(tmpdir())+'\\')||resolve(temp).startsWith(resolve(tmpdir())+'/'));
  await rm(temp,{recursive:true,force:true});
}
