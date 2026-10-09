// Production assets + real isolated HTTP backend. No model/network service is used.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'..');
const platform=process.env.XUENESS_CONVERSATION_PLATFORM || (process.platform==='darwin'?'macos':'windows');
assert.ok(['macos','windows'].includes(platform),'XUENESS_CONVERSATION_PLATFORM must be macos or windows');
const nativePlatform=platform==='macos'?'MacIntel':'Win32';
const output=process.env.XUENESS_CONVERSATION_OUTPUT || join(tmpdir(),`xueness-conversation-review-${platform}`);
const temporary=await mkdtemp(join(tmpdir(),'xueness-conversation-'));
await mkdir(output,{recursive:true});
const source=String.raw`
import json,sys,threading,time
from pathlib import Path
from unittest.mock import patch
from xueness import web
from xueness.core import SYSTEM
base,dist=map(Path,sys.argv[1:]);workspace=base/'workspace';workspace.mkdir();state=base/'state';state.mkdir()
(workspace/'fixture.txt').write_text('verified local contents')
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'onboarding':False,'diagnostics':False,'updates':False}}))
ctx=web.build_context(state,base/'runs',workspace,allow_real=True);ctx['webapp_dir']=dist
class Provider:
    model='fixture-local';protocol='openai';tool_calling='native';runtime_profile='standard';context_window=32768;max_output_tokens=2048
    base='http://127.0.0.1:9/v1';compatibility={};reasoning_levels=()
    def complete(self,messages,tools):
        if '[delay]' in str(next((m.get('content','') for m in reversed(messages) if m.get('role')=='user'),'')):time.sleep(8)
        return {'content':json.dumps({'summary':'已完成隔离验证。','evidence':[]},ensure_ascii=False)}
def seed(name,profile,kind='short'):
    session=ctx['store'].new(name,workspace)
    session.update(status='completed',permission_mode='yolo',runtime_profile=profile)
    if kind=='long':
        call={'id':'fixture-read','type':'function','function':{'name':'read','arguments':json.dumps({'path':'fixture.txt'})}}
        session['messages'] += [{'role':'assistant','content':'我先检查文件。','tool_calls':[call]},
            {'role':'tool','tool_call_id':'fixture-read','content':json.dumps({'ok':True,'text':'verified local contents'})},
            {'role':'assistant','content':'\n'.join(['文件内容已核对。','',chr(96)*3+'python','print("verified")',chr(96)*3])}]
        session['results']={'fixture-read':{'ok':True,'text':'verified local contents'}}
        session['reasoning_history']=[{'message_index':2,'text':'根据真实文件确认结果。'}]
        session['completion']={'summary':'文件内容已核对。','status':'verified','verified':True,'tool_execution_status':'succeeded','evidence':[{'tool_call_id':'fixture-read'}]}
    else:
        session['messages'].append({'role':'assistant','content':'你好！有什么我可以帮你的吗？'})
        session['completion']={'summary':'你好！有什么我可以帮你的吗？','status':'not_applicable','verified':False,'tool_execution_status':'not_applicable'}
    ctx['store'].save(session);return session['id']
ids={p:{k:seed('隔离 '+p+' '+k,p,k) for k in ('short','long')} for p in ('standard','lightweight')}
history=ctx['store'].new('历史初始提示',workspace)
for i in range(350):history['messages'] += [{'role':'user','content':f'历史轮次 {i}'},{'role':'assistant','content':f'历史回答 {i}'}]
history.update(status='completed',runtime_profile='standard');ctx['store'].save(history)
pending=ctx['store'].new('尚未启动的原有任务',workspace)
provider=patch('xueness.provider_config.resolve',return_value=Provider());provider.start()
server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1],'ids':ids,'historyId':history['id'],'pendingId':pending['id']}),flush=True)
try:sys.stdin.buffer.read()
finally:server.shutdown();server.server_close();provider.stop()
`;
const script=join(temporary,'server.py');await writeFile(script,source);
const child=spawn(process.env.PYTHON || 'python',[script,temporary,join(root,'webapp/dist')],{
  cwd:root,env:{...process.env,PYTHONPATH:root,XUENESS_MODEL:'fixture-local',XUENESS_API_KEY:'fixture-placeholder',
    XUENESS_PROVIDER:'openai',XUENESS_API_BASE:'http://127.0.0.1:9/v1',XUENESS_MARKETPLACE_URL:'',XUENESS_WORKSPACE_ROOTS:''},
  windowsHide:true,stdio:['pipe','pipe','pipe']});
const report={platform,simulatedOS:true,executionHost:process.platform,errors:[],externalRequests:[],runBodies:[],views:[],interactions:[]};let browser,lastPage;
try {
  const ready=await new Promise((accept,reject)=>{
    let text='',stderr='';child.stderr.on('data',data=>stderr+=data);
    child.stdout.on('data',data=>{text+=data;if(text.includes('\n'))accept(JSON.parse(text.split('\n')[0]));});
    child.once('exit',code=>reject(new Error(`Server exited ${code}: ${stderr}`)));
    setTimeout(()=>reject(new Error(`Server timeout: ${stderr}`)),15000).unref();
  });
  const origin=`http://127.0.0.1:${ready.port}`;
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
  for(const theme of ['light','dark']) for(const width of [1280,760]) {
    const context=await browser.newContext({viewport:{width,height:800},colorScheme:theme,reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
    await context.addInitScript(({theme,nativePlatform})=>{
      Object.defineProperty(navigator,'platform',{get:()=>nativePlatform});
      localStorage.setItem('xueness.theme',theme);localStorage.setItem('xueness.language','zh');
    },{theme,nativePlatform});
    const page=await context.newPage();page.setDefaultTimeout(15000);
    lastPage=page;
    page.on('pageerror',error=>report.errors.push(error.message));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin){report.externalRequests.push(url.href);return route.abort();}
      if(url.pathname.endsWith('/run'))report.runBodies.push(route.request().postDataJSON());
      return route.continue();
    });
    await page.goto(`${origin}/?xuenessDesktop=1`);
    const titlebar=page.getByTestId('xn-desktop-titlebar');await titlebar.waitFor();
    assert.equal(await titlebar.getAttribute('data-platform'),platform);
    const insets=await titlebar.evaluate(node=>({
      brandLeft:node.querySelector('.xn-desktop-titlebar__brand').getBoundingClientRect().left,
      actionsRight:innerWidth-node.querySelector('.xn-desktop-titlebar__actions').getBoundingClientRect().right,
    }));
    if(platform==='macos') {assert.ok(insets.brandLeft>=78);assert.ok(insets.actionsRight>=10&&insets.actionsRight<30);}
    else {assert.ok(insets.brandLeft>=10&&insets.brandLeft<30);assert.ok(insets.actionsRight>=148);}
    const pick=async id=>{
      const row=page.getByTestId(`xn-sidebar-item-${id}`);
      await row.waitFor({state:'attached'});
      if(!await row.isVisible())await page.getByTestId('xn-desktop-titlebar-sidebar').click();
      await row.click();await page.getByTestId('zcode-conversation').waitFor();
      await page.waitForFunction(()=>!document.querySelector('.xn-composer-toolbar__model-trigger')?.getAttribute('aria-busy'));
      await page.waitForLoadState('networkidle');
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    };
    for(const profile of ['standard','lightweight']) for(const kind of ['short','long']) {
      await pick(ready.ids[profile][kind]);
      const composer=page.locator('.xn-composer__input');await composer.waitFor();
      assert.equal(await page.getByTestId('lightweight-composer').count(),0,'Profile mounted a second composer implementation');
      if(kind==='short')assert.equal(await page.locator('.xn-zc-completion').count(),0,'Ordinary greeting has an extra completion block');
      else {
        assert.equal(await page.locator('.xn-zc-work').getAttribute('open'),null);
        assert.equal(await page.locator('.xn-zc-tool-body').count(),0,'Closed work parsed hidden payloads');
        await page.locator('.xn-zc-work > summary').click();
        await page.locator('.xn-zc-tool > summary').click();
        await page.locator('.xn-zc-tool-body').getByText('verified local contents',{exact:true}).waitFor();
        await page.locator('.xn-zc-tool > summary').click();await page.locator('.xn-zc-work > summary').click();
      }
      const geometry=await page.evaluate(()=>{
        const turn=document.querySelector('.xn-zc-turn'),bubble=document.querySelector('.xn-zc-user-bubble'),answer=document.querySelector('.xn-zc-answer');
        const ts=getComputedStyle(turn),bs=getComputedStyle(bubble),as=getComputedStyle(answer);
        return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,turnPadding:ts.padding,turnGap:ts.gap,
          bubblePadding:bs.padding,bubbleRadius:bs.borderRadius,bubbleBackground:bs.backgroundColor,answerBorder:as.borderWidth,
          font:getComputedStyle(document.querySelector('.xn-zcode-conversation')).fontSize,composerCount:document.querySelectorAll('.xn-composer__input').length};
      });
      assert.ok(geometry.documentWidth<=width+1,'Horizontal overflow');assert.equal(geometry.bubblePadding,'12px 16px');
      assert.equal(geometry.bubbleRadius,'12px 2px 12px 12px');assert.equal(geometry.answerBorder,'0px');assert.equal(geometry.turnGap,'20px');
      report.views.push({platform,theme,width,profile,kind,...geometry});
      await page.screenshot({path:join(output,`${theme}-${width}-${profile}-${kind}.png`)});
    }
    if(theme==='light'&&width===1280) {
      await pick(ready.ids.standard.short);
      const user=page.locator('.xn-zc-user');await user.hover();await user.getByRole('button',{name:'复制',exact:true}).click();
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'隔离 standard short');
      await user.getByRole('button',{name:'编辑消息',exact:true}).click();
      const editor=page.getByRole('textbox',{name:'编辑消息',exact:true});await editor.fill('取消后应保留原会话');
      await page.locator('.xn-zc-editor').getByRole('button',{name:'取消',exact:true}).click();
      assert.equal(await page.locator('.xn-zc-user-bubble').textContent(),'隔离 standard short');
      await user.hover();await user.getByRole('button',{name:'编辑消息',exact:true}).click();
      await editor.fill('重新编辑的第一轮');await page.locator('.xn-zc-editor').getByRole('button',{name:'发送',exact:true}).click();
      await page.getByText('已完成隔离验证。',{exact:true}).waitFor();
      assert.equal(await page.locator('.xn-zc-user-bubble').textContent(),'重新编辑的第一轮');
      const final=page.locator('.xn-zc-final');await final.hover();await final.getByRole('button',{name:'有帮助',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[data-feedback="like"]')?.getAttribute('aria-pressed')==='true');
      await page.reload();await page.getByTestId(`xn-sidebar-item-${ready.ids.standard.short}`).waitFor();await pick(ready.ids.standard.short);
      assert.equal(await page.getByRole('button',{name:'有帮助',exact:true}).getAttribute('aria-pressed'),'true');
      await page.locator('.xn-zc-final').hover();await page.locator('.xn-zc-final').getByRole('button',{name:'分叉会话',exact:true}).click();
      await page.getByRole('dialog').waitFor();
      await page.getByRole('radio',{name:/第 1 轮结束/}).waitFor();
      assert.equal(await page.getByRole('radio',{name:/第 1 轮结束/}).getAttribute('aria-checked'),'true');
      await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
      // Existing saved yolo -> new draft must ask before creating the new task.
      await page.getByTestId('xn-sidebar-action-new-task').click();
      const input=page.locator('.xn-composer__input');await input.fill('新会话完全访问确认');
      await page.waitForFunction(()=>document.querySelector('.xn-composer__send')?.disabled===false);
      await input.press('Enter');
      await page.getByTestId('full-access-cancel').waitFor();await page.getByTestId('full-access-cancel').click();
      await page.waitForFunction(()=>document.querySelector('.xn-composer__input')?.value==='新会话完全访问确认');
      const list=await (await context.request.get(`${origin}/api/sessions`)).json();assert.equal(list.sessions.length,6,'Cancellation created an orphan session');
      const before=report.runBodies.length;await input.press('Enter');await page.getByTestId('full-access-confirm').click();
      await page.getByTestId('zcode-conversation').waitFor();await page.getByText('已完成隔离验证。',{exact:true}).waitFor();
      assert.equal(report.runBodies.length,before+1);assert.equal(report.runBodies.at(-1).acknowledge_yolo,true);
      report.interactions.push('clipboard','cancel edit','edit existing turn','persist feedback across reload','fork selected turn','cancel full access retains draft and creates no task','confirm full access submits once');
      await page.locator('.xn-conv-header__more > summary').click();
      await page.getByRole('button',{name:'编辑交付清单',exact:true}).click();
      await page.locator('.xn-delivery-checks__body').waitFor();
      await page.locator('.xn-delivery-checks__body').getByRole('button',{name:'取消编辑',exact:true}).click();
      assert.equal(await page.locator('.xn-delivery-checks').count(),0);
      report.interactions.push('delivery editor available from More');
      await pick(ready.historyId);
      await page.locator('.xn-zc-answer').getByText('历史回答 349',{exact:true}).waitFor();
      const mounted=await page.locator('.xn-zc-turn').count();assert.ok(mounted<50,`History mounted ${mounted} turns`);
      await page.locator('.xn-conversation-history-rail__stop[tabindex="0"]').focus();
      await page.keyboard.press('Home');
      await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')?.startsWith('跳转到第 1 条用户消息:'));
      const first=page.getByRole('button',{name:/跳转到第 1 条用户消息:/});await page.keyboard.press('Enter');
      await page.getByText('历史初始提示',{exact:true}).last().waitFor();
      await page.screenshot({path:join(output,'history-first.png')});
      await first.press('End');
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      report.historyFocus = await page.evaluate(()=>({focus:document.activeElement?.getAttribute('data-history-seq'),track:document.querySelector('.xn-conversation-history-rail__track')?.scrollTop,stops:[...document.querySelectorAll('[data-history-seq]')].map(e=>e.getAttribute('data-history-seq'))}));
      await page.waitForFunction(()=>document.activeElement?.getAttribute('data-history-seq')==='700');
      await page.keyboard.press('Enter');
      await page.locator('.xn-zc-answer').getByText('历史回答 349',{exact:true}).waitFor();
      for(let navigation=0;navigation<3;navigation++) {
        await page.keyboard.press('Home');
        await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')?.startsWith('跳转到第 1 条用户消息:'));
        await page.keyboard.press('Enter');
        await page.locator('.xn-zc-user-bubble').getByText('历史初始提示',{exact:true}).waitFor();
        await page.keyboard.press('End');
        await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')?.startsWith('跳转到第 351 条用户消息:'));
        await page.keyboard.press('Enter');
        await page.locator('.xn-zc-answer').getByText('历史回答 349',{exact:true}).waitFor();
      }
      report.interactions.push(`351-turn history window, ${mounted} mounted turns, four first/tail round trips`);
      await pick(ready.ids.standard.short);
      const activeInput=page.locator('.xn-composer__input');await activeInput.fill('[delay] 隔离长任务');
      await page.waitForFunction(()=>document.querySelector('.xn-composer__send')?.disabled===false);
      await activeInput.press('Enter');
      await page.getByTestId('composer-stop').waitFor();
      await activeInput.fill('排队消息');await page.getByTestId('composer-queue').click();await page.getByTestId('session-queue').waitFor();
      await page.getByTestId('composer-stop').click();
      await page.getByRole('button',{name:'继续执行队列',exact:true}).waitFor();
      assert.equal(await page.getByTestId('timeline-stream-loading').count(),0,'Stopped turn still animates as running');
      await page.getByRole('button',{name:'取消排队',exact:true}).click();
      report.interactions.push('send during run queues once, stop settles, paused queue can be cancelled');
      await pick(ready.pendingId);
      await page.locator('.xn-run-recovery').getByRole('button',{name:'重试运行',exact:true}).waitFor();
      assert.equal(await page.locator('.xn-run-error').count(),0,'Unstarted history is styled as an error');
      assert.equal(await page.locator('.xn-run-recovery .xn-zc-retry').evaluate(e=>getComputedStyle(e).borderRadius),'8px');
      await page.screenshot({path:join(output,'pending-recovery.png')});
      report.interactions.push('unstarted history retains a compact recovery control without an empty error bar');
    }
    await context.close();
  }
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);
  console.log(`PASS: ${platform}, ${report.views.length} production views, ${report.interactions.length} message/permission interactions, no page errors or external requests`);
} catch(error) {
  if(lastPage&&!lastPage.isClosed())report.failureFocus = await lastPage.evaluate(()=>{
    const track=document.querySelector('.xn-conversation-history-rail__track'),stops=document.querySelector('.xn-conversation-history-rail__stops');
    return {focus:document.activeElement?.getAttribute('aria-label'),track:{scrollTop:track?.scrollTop,height:track?.clientHeight,scrollHeight:track?.scrollHeight},stops:[...document.querySelectorAll('[data-history-seq]')].map(e=>e.getAttribute('data-history-seq'))};
  });
  if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:join(output,'failure.png')});
  throw error;
} finally {
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();child.stdin.end();
  await new Promise(accept=>{if(child.exitCode!==null)return accept();child.once('exit',accept);setTimeout(()=>{child.kill();accept();},5000).unref();});
  await rm(temporary,{recursive:true,force:true});
}
