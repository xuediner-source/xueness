// Real production UI and isolated backend; no search service or model is called.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'..');
const temporary=await mkdtemp(join(tmpdir(),'xueness-search-ui-'));
const output=process.env.XUENESS_SEARCH_UI_OUTPUT || join(tmpdir(),'xueness-search-ui-evidence');
await mkdir(output,{recursive:true});
const script=join(temporary,'server.py');
await writeFile(script,String.raw`
import json,sys,threading
from pathlib import Path
from unittest.mock import patch
from xueness import web
from xueness.bundled_plugins.network import search_settings,search_services
base,dist=map(Path,sys.argv[1:]);root=base/'workspace';root.mkdir();state=base/'state';state.mkdir()
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'onboarding':False,'diagnostics':False,'updates':False}}))
search_settings.update_settings(state,{'searchProvider':'brave','searchKey':'fixture-brave-key'})
search_settings.update_settings(state,{'searchProvider':'tavily','searchKey':'fixture-tavily-key'})
ctx=web.build_context(state,base/'runs',root,allow_real=True);ctx['webapp_dir']=dist
post=patch.object(search_services,'post_json',return_value=({'results':[],'usage':{'credits':1}},'system'));post.start()
get=patch.object(search_services,'fetch',return_value={'output':'{"results":[]}','dnsSource':'system'});get.start()
server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1]}),flush=True)
try:sys.stdin.buffer.read()
finally:server.shutdown();server.server_close();post.stop();get.stop()
`);
const child=spawn(process.env.PYTHON || 'python',[script,temporary,join(root,'webapp/dist')],{
 cwd:root,env:{...process.env,PYTHONPATH:root,XUENESS_MARKETPLACE_URL:'',XUENESS_WORKSPACE_ROOTS:''},
 windowsHide:true,stdio:['pipe','pipe','pipe']});
let browser,lastPage;
const report={views:[],externalRequests:[],errors:[],diagnostics:0};
try {
 const ready=await new Promise((accept,reject)=>{
  let text='',error='';child.stderr.on('data',data=>error+=data);
  child.stdout.on('data',data=>{text+=data;if(text.includes('\n'))accept(JSON.parse(text.split('\n')[0]));});
  child.once('exit',code=>reject(new Error(`Backend exited ${code}: ${error}`)));
  setTimeout(()=>reject(new Error(`Backend timeout: ${error}`)),15000).unref();
 });
 const origin=`http://127.0.0.1:${ready.port}`;
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
 for(const width of [1280,480]) {
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  await context.addInitScript(()=>{localStorage.setItem('xueness.language','zh');localStorage.setItem('xueness.theme','light');});
  const page=await context.newPage();lastPage=page;page.setDefaultTimeout(15000);
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.route('**/*',route=>{
   if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}
   if(route.request().url().endsWith('/api/network/diagnostics')) report.diagnostics++;
   return route.continue();
  });
  await page.goto(`${origin}/?xuenessDesktop=1`);
  await page.getByTestId('xn-desktop-titlebar').waitFor();
  if(width<800) await page.getByTestId('xn-desktop-titlebar-sidebar').click();
  await page.getByRole('button',{name:'打开设置',exact:true}).waitFor({state:'attached'});
  if(!await page.getByRole('button',{name:'打开设置',exact:true}).isVisible()) await page.getByTestId('xn-desktop-titlebar-sidebar').click();
  await page.getByRole('button',{name:'打开设置',exact:true}).click();
  await page.getByTestId('xn-settings-nav-network').click();
  const panel=page.getByTestId('network-settings');
  const provider=panel.getByRole('combobox',{name:/^搜索服务/u});
  await provider.waitFor();
  assert.equal(await provider.inputValue(),'tavily');
  const test=panel.getByRole('button',{name:'发送一次测试搜索',exact:true});
  assert.equal(await test.isEnabled(),true);
  assert.equal(await panel.getByLabel('搜索服务密钥',{exact:true}).inputValue(),'');
  await provider.selectOption('searxng');
  assert.equal(await panel.getByLabel('搜索服务密钥',{exact:true}).count(),0);
  assert.equal(await test.isDisabled(),true);
  await panel.getByLabel('搜索服务 HTTPS 地址',{exact:true}).fill('https://search.example/search');
  await panel.getByRole('button',{name:'保存网络设置',exact:true}).click();
  await page.getByText('设置已保存。密钥只保存在本机服务端，不会回显。',{exact:true}).waitFor();
  await test.click();
  await panel.getByText('诊断完成',{exact:true}).waitFor();
  await provider.selectOption('brave');
  assert.equal(await test.isDisabled(),true);
  assert.match(await panel.getByLabel('搜索服务密钥',{exact:true}).getAttribute('placeholder'),/已保存/);
  await panel.getByRole('button',{name:'保存网络设置',exact:true}).click();
  await page.getByText('设置已保存。密钥只保存在本机服务端，不会回显。',{exact:true}).waitFor();
  await provider.selectOption('tavily');
  assert.equal(await panel.getByLabel('搜索服务 HTTPS 地址',{exact:true}).inputValue(),'https://api.tavily.com/search');
  await panel.getByRole('button',{name:'保存网络设置',exact:true}).click();
  await page.getByText('设置已保存。密钥只保存在本机服务端，不会回显。',{exact:true}).waitFor();
  await test.click();await panel.getByText('诊断完成',{exact:true}).waitFor();
  assert.equal(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
  await panel.evaluate(node=>{for(let parent=node.parentElement;parent;parent=parent.parentElement)parent.scrollTop=0;});
  await page.screenshot({path:join(output,`network-${width}.png`)});
  report.views.push({width,provider:'tavily',keysMasked:true,overflow:false});
  await context.close();
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);assert.equal(report.diagnostics,4);
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
 console.log('PASS: production desktop/narrow search settings, service switching, isolated diagnostics, saved-key retention; no external requests.');
} catch(error) {
 await lastPage?.screenshot({path:join(output,'failure.png'),fullPage:true});
 await writeFile(join(output,'failure.txt'),String(error)+'\n'+(await lastPage?.locator('body').innerText())+'\n'+JSON.stringify(report));
 throw error;
} finally {
 await browser?.close();child.stdin.end();
 await new Promise(accept=>{if(child.exitCode!==null)accept();else {child.once('exit',accept);setTimeout(()=>{child.kill();accept();},5000).unref();}});
 if(dirname(resolve(temporary))!==resolve(tmpdir()) || !temporary.includes('xueness-search-ui-')) throw new Error('Unexpected temporary path');
 await rm(temporary,{recursive:true,force:true});
}
