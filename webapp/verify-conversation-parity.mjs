// Production app, synthetic journals and local message APIs. All model runs are intercepted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'xn-conversation-parity-'));
const output = join(tmpdir(), 'xueness-conversation-parity-20261007');
await mkdir(output, { recursive: true });
const source = String.raw`
import json,sys,threading,itertools
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.providers import providers_api,default_selection
base,dist=map(Path,sys.argv[1:]); state=base/'state';state.mkdir();workspace=base/'workspace';workspace.mkdir()
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'updates':False,'onboarding':False,'diagnostics':False}}))
ctx=web.build_context(state,base/'runs',workspace,allow_real=True);ctx['webapp_dir']=dist
code,data=providers_api._handle_save(ctx,{'id':'fixture','name':'Synthetic model','baseUrl':'https://127.0.0.1:9/v1','model':'fixture-model','apiKey':'synthetic-key'});assert code==200,data
default_selection.save(state,{'providerId':'fixture','model':'fixture-model'})
fixtures=[]
for profile,theme,width in itertools.product(('standard','lightweight'),('light','dark'),(1280,420)):
 s=ctx['store'].new('Inspect the project and report the result.',workspace);s['title']='Conversation '+profile+' '+theme+' '+str(width)+' — '+('A long descriptive task title. '*8);s['status']='completed';s['runtime_profile']=profile;s['model_selection']={'provider_id':'fixture','model':'fixture-model'}
 def call(id,command):return {'id':id,'type':'function','function':{'name':'exec','arguments':json.dumps({'command':command})}}
 i=len(s['messages'])
 s['messages'] += [{'role':'assistant','content':'','tool_calls':[call(profile+'-a','pwd'),call(profile+'-b','git status --short')]},
  {'role':'tool','tool_call_id':profile+'-a','content':json.dumps({'stdout':'/fixture/workspace'})},
  {'role':'tool','tool_call_id':profile+'-b','content':json.dumps({'stdout':'Working tree clean.'})},
  {'role':'assistant','content':'The workspace is clean. I will check the build next.','tool_calls':[call(profile+'-c','npm run build')]},
  {'role':'tool','tool_call_id':profile+'-c','content':json.dumps({'stdout':'Build passed.'})},
  {'role':'assistant','content':'The project is ready.\n\n- Workspace inspected\n- Build passed\n\n'+chr(96)*3+'ts\nconst ready = true;\n'+chr(96)*3}]
 s['reasoning_history']=[{'message_index':i,'text':'Check the real working directory before running project commands.'},{'message_index':i+3,'text':'Confirm the build after checking the working tree.'}]
 s['results']={profile+'-'+id:{'ok':True} for id in ('a','b','c')}
 s['completion']={'verified':True,'status':'verified','summary':s['messages'][-1]['content'],'tool_execution_status':'succeeded','delivery_status':'passed','turn_id':'turn-1'}
 s['completion_history']=[s['completion'].copy()]
 second=len(s['messages'])+1
 s['messages'] += [{'role':'user','content':'Repeat the check.'},
  {'role':'assistant','content':'The second turn starts with a real command.','tool_calls':[call(profile+'-d','pwd')]},
  {'role':'tool','tool_call_id':profile+'-d','content':json.dumps({'stdout':'/fixture/repeat'})},
  {'role':'assistant','content':'Second turn completed.'}]
 s['reasoning_history'].append({'message_index':second,'text':'Check again with separate turn evidence.'})
 s['results'][profile+'-d']={'ok':True}
 s['completion']={**s['completion'],'summary':'Second turn completed.','turn_id':'turn-2'}
 ctx['store'].save(s);fixtures.append({'id':s['id'],'profile':profile,'theme':theme,'width':width})
server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1],'fixtures':fixtures}),flush=True)
try:sys.stdin.buffer.read()
finally:server.shutdown();server.server_close()
`;
const script = join(temp, 'server.py'); await writeFile(script, source);
const child = spawn(process.env.PYTHON || 'python3', [script, temp, join(root, 'webapp/dist')], { cwd: root,
  env: { ...process.env, PYTHONPATH: root, XUENESS_API_KEY: '', XUENESS_MODEL: '', XUENESS_MARKETPLACE_URL: '', XUENESS_WORKSPACE_ROOTS: '' }, stdio: ['pipe','pipe','pipe'] });
let browser, releaseRun, releaseMessages;
const errors = [], external = [], results = [];
async function waitUntil(predicate){const end=Date.now()+12000;while(!predicate()){assert.ok(Date.now()<end,'Expected intercepted request');await new Promise(resolve=>setTimeout(resolve,25));}}
try {
  const ready = await new Promise((accept,reject) => {
    let out='',err='';child.stderr.on('data',d=>err+=d);child.stdout.on('data',d=>{out+=d;if(out.includes('\n'))accept(JSON.parse(out.split('\n')[0]));});
    child.once('exit',code=>reject(new Error(`fixture ${code}: ${err}`)));setTimeout(()=>reject(new Error(err||'fixture timeout')),15000).unref();
  });
  const origin=`http://127.0.0.1:${ready.port}`;
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
  for(const theme of ['light','dark'])for(const width of [1280,420]){
    const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,reducedMotion:'reduce'});
    await context.addInitScript(theme=>{localStorage.setItem('xueness.theme',theme);localStorage.setItem('xueness.language','en');},theme);
    const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
    let sendMode='accept';
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin){external.push(url.href);await route.abort();return;}
      if(route.request().method()==='POST'&&url.pathname.endsWith('/run')){
        await new Promise(resolve=>{releaseRun=resolve;});releaseRun=undefined;
        await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'Synthetic provider failure after message acceptance'})});return;
      }
      if(route.request().method()==='POST'&&url.pathname.endsWith('/messages')&&sendMode==='reject'){
        await new Promise(resolve=>{releaseMessages=resolve;});releaseMessages=undefined;
        await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic message rejection'})});return;
      }
      await route.continue();
    });
    await page.goto(origin);
    for(const fixture of ready.fixtures.filter(item=>item.theme===theme&&item.width===width)){
      sendMode='accept';
      const item=page.getByTestId(`xn-sidebar-item-${fixture.id}`);await item.waitFor({state:'attached'});
      if(!await item.isVisible())await page.getByTestId('xn-shell-sidebar-toggle').click();await item.click();
      await page.getByText('The project is ready.',{exact:false}).first().waitFor();
      if(fixture.profile==='standard'){
        const stream=page.getByTestId('timeline-stream').first();
        const workToggle=page.locator('[data-testid^="timeline-work-toggle-"]').first();
        assert.equal(await workToggle.getAttribute('aria-expanded'),'false');
        await page.screenshot({path:join(output,`${theme}-${width}-collapsed.png`)});
        await workToggle.click();
        const group=page.locator('.xn-tool-group').first();await group.waitFor();
        const geometry=await group.evaluate(n=>{const s=getComputedStyle(n);return {height:n.getBoundingClientRect().height,border:s.borderTopWidth,background:s.backgroundColor};});
        assert.ok(geometry.height<=32,JSON.stringify(geometry));assert.equal(geometry.border,'0px');
        const thought=page.locator('.xn-reasoning').first();
        assert.deepEqual(await thought.locator('summary').evaluate(n=>({display:getComputedStyle(n).display,gap:getComputedStyle(n).columnGap})),{display:'flex',gap:'8px'});
        await thought.locator('summary').click();
        assert.match(await thought.innerText(),/Check the real working directory/);
        assert.equal(await thought.evaluate(n=>n.compareDocumentPosition(document.querySelector('.xn-tool-group'))&Node.DOCUMENT_POSITION_FOLLOWING),4);
        await thought.locator('summary').click();await group.locator(':scope > summary').click();
        assert.match(await group.innerText(),/pwd/);assert.match(await group.innerText(),/git status/);
        const tool = group.locator('.xn-toolcall__details').first();
        await tool.locator(':scope > summary').click();
        assert.match(await tool.locator('.xn-toolcall__terminal').innerText(), /\$ pwd[\s\S]*\/fixture\/workspace/);
        const raw = tool.locator('.xn-toolcall__raw');
        assert.equal(await raw.locator('.xn-toolcall__raw-content').count(), 0);
        await page.screenshot({path:join(output,`${theme}-${width}-terminal.png`)});
        await raw.locator(':scope > summary').click();
        await raw.locator('.xn-toolcall__raw-content').waitFor();
        assert.match(await raw.innerText(), /stdout/);
        await raw.locator(':scope > summary').click();await tool.locator(':scope > summary').click();
        await page.screenshot({path:join(output,`${theme}-${width}-expanded.png`)});
        await page.locator('[data-testid^="timeline-work-toggle-"]').first().click();
        assert.equal(await page.locator('.xn-tool-group').count(),0);assert.match(await stream.innerText(),/The project is ready/);
        await page.locator('[data-testid^="timeline-work-toggle-"]').first().click();
        const proseOrder=await stream.evaluate(n=>[...n.querySelectorAll('.xn-timeline-item')].map(e=>e.textContent));
        assert.ok(proseOrder.findIndex(s=>s.includes('I will check the build'))<proseOrder.findIndex(s=>s.includes('npm run build')));
        const secondWork=page.locator('[data-testid^="timeline-work-toggle-"]').last();
        assert.equal(await secondWork.getAttribute('aria-expanded'),'false');await secondWork.click();
        const secondOrder=await stream.evaluate(n=>[...n.querySelectorAll('.xn-timeline-item')].map(e=>e.textContent));
        assert.ok(secondOrder.findIndex(s=>s.includes('The second turn starts'))<secondOrder.findIndex(s=>s.includes('/fixture/repeat')));
        await secondWork.click();
        await page.screenshot({path:join(output,`${theme}-${width}-conversation.png`)});
      }
      assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
      if(fixture.profile==='standard'){
        const header=await page.locator('.xn-conv-header').evaluate(n=>{const title=n.querySelector('h2').getBoundingClientRect();const actions=n.querySelector('.xn-conv-header__main').getBoundingClientRect();return {titleWidth:title.width,verticalOffset:Math.abs(title.y+title.height/2-actions.y-actions.height/2)};});
        assert.ok(header.titleWidth>50&&header.verticalOffset<4,JSON.stringify(header));
      }
      // The editor must empty immediately while the synthetic model request is still pending.
      const input=fixture.profile==='standard'?page.getByRole('textbox',{name:'Enter a message or instruction…'}):page.getByTestId('lightweight-composer-input');
      await input.fill('  submission with spaces  ');await page.getByRole('button',{name:'Send',exact:true}).click();
      await page.waitForFunction(()=>[...document.querySelectorAll('textarea')].some(n=>n.value===''));
      await page.waitForFunction(()=>document.body.textContent.includes('submission with spaces'));
      assert.equal(await input.inputValue(),'');
      await input.fill('New draft written during generation.');
      await waitUntil(()=>releaseRun);releaseRun();
      await page.getByText('Synthetic provider failure after message acceptance',{exact:true}).waitFor();
      assert.equal(await input.inputValue(),'New draft written during generation.');
      sendMode='reject';await input.fill('  retry exact draft  ');await page.getByRole('button',{name:'Send',exact:true}).click();
      await waitUntil(()=>releaseMessages);
      assert.equal(await input.inputValue(),'');releaseMessages();
      await page.waitForFunction(()=>[...document.querySelectorAll('textarea')].some(n=>n.value==='  retry exact draft  '));
      assert.equal(await input.inputValue(),'  retry exact draft  ');
      results.push({profile:fixture.profile,theme,width,immediateClear:true,acceptedRunFailurePreservesNewDraft:true,rejectedSubmissionRestores:true});
    }
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await writeFile(join(output,'verification.json'),JSON.stringify({results,errors,external,synthetic:true,modelRequests:0},null,2));
  console.log(`PASS: ${results.length} production conversation/draft layouts, no model requests. ${output}`);
}finally{
  releaseRun?.();releaseMessages?.();await browser?.close();child.stdin.end();
  await new Promise(resolve=>{if(child.exitCode!==null)resolve();else{child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},5000).unref();}});
  await rm(temp,{recursive:true,force:true});
}
