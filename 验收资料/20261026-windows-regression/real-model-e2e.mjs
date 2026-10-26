import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDesktopFixture } from './desktop-fixture.mjs';
const root=new URL('./real-model/',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1');
mkdirSync(root,{recursive:true});
const executable=process.argv[2]??new URL('../../desktop/release/win-unpacked/Xueness.exe',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1');
const fixture=await startDesktopFixture(executable,join(root,`data-${Date.now()}`));
const {page,api}=fixture;
const result={kind:'real-local-inference',base:'http://127.0.0.1:8098/v1',checks:[]};
try {
  await page.getByTestId('desktop-permission-onboarding-skip-all').waitFor({timeout:15000});
  await page.getByTestId('desktop-permission-onboarding-skip-all').click();
  await page.getByTestId('desktop-permission-onboarding').waitFor({state:'hidden'});
  const profile=JSON.parse(readFileSync(process.env.XUENESS_ACCEPTANCE_PROVIDER_FILE ?? (() => { throw new Error('Set XUENESS_ACCEPTANCE_PROVIDER_FILE to an isolated local provider profile'); })(), 'utf8'));
  result.model=profile.model;
  const saved=await api('/api/providers',{...profile,id:'bonsai-live-e2e',name:'Bonsai 本地真实验收',allowLoopbackHttp:true,maxOutputTokens:2048});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal((await api('/api/providers/default',{providerId:'bonsai-live-e2e',model:profile.model})).status,200);
  await page.reload();
  const editor=page.locator('textarea.xn-composer__input').first();
  await editor.waitFor();
  await editor.fill('请只回复 XUENESS_LOCAL_20261026，不需要调用任何工具。');
  const submitted=page.waitForRequest(r=>r.method()==='POST'&&/\/api\/sessions\/[0-9a-f]+\/commands$/.test(new URL(r.url()).pathname)&&r.postDataJSON()?.type==='run',{timeout:20000});
  submitted.catch(()=>{});
  const began=performance.now();
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const request=await submitted;
  const sid=new URL(request.url()).pathname.split('/')[3];
  result.sessionId=sid;
  let detail;
  for(let n=0;n<1800;n++) {
    detail=(await api(`/api/sessions/${sid}`)).body;
    if(!['running','pending'].includes(detail.status))break;
    if(n%150===0)console.log(JSON.stringify({elapsedSeconds:Math.round((performance.now()-began)/1000),status:detail.status}));
    await page.waitForTimeout(100);
  }
  result.seconds=(performance.now()-began)/1000;
  result.status=detail.status;
  const journal=JSON.parse(readFileSync(join(fixture.data,'state',`${sid}.json`),'utf8'));
  const replies=journal.messages.filter(m=>m.role==='assistant').map(m=>m.content);
  result.replies=replies;
  assert.equal(detail.status,'completed',JSON.stringify({status:detail.status,pause_reason:detail.pause_reason}));
  assert.ok(replies.some(s=>typeof s==='string'&&s.includes('XUENESS_LOCAL_20261026')),JSON.stringify(replies));
  result.checks.push('actual-desktop-UI-to-local-Bonsai-response-and-journal');
  result.fixtureModelRequests=fixture.modelRequests.length;
  assert.equal(result.fixtureModelRequests,0);
  await page.screenshot({path:join(root,'real-local-response.png')});
  result.ok=true;
  console.log(JSON.stringify(result));
} catch(error) {
  result.ok=false;result.error=String(error);
  await page.screenshot({path:join(root,'failure.png')}).catch(()=>{});
  console.error(error);process.exitCode=1;
} finally {
  writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2));
  await fixture.close();
}
