import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'xueness-capabilities-'));
const output = join(tmpdir(), 'xueness-composer-capabilities-20261007');
await mkdir(output, {recursive:true});
const source = String.raw`
import json, sys, threading
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.providers import providers_api, default_selection
base, dist = map(Path, sys.argv[1:])
workspace=base/'workspace'; workspace.mkdir()
(workspace/'search-fixture.md').write_text('Synthetic search fixture; never sent to a model.')
state=base/'state'; state.mkdir()
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'updates':False,'onboarding':False,'diagnostics':False,'browser':True}}))
ctx=web.build_context(state,base/'runs',workspace,allow_real=True)
ctx['webapp_dir']=dist
status,result=providers_api._handle_save(ctx,{'id':'review','name':'Synthetic review model','baseUrl':'https://127.0.0.1:9/v1','model':'fixture-model','apiKey':'not-a-real-key','contextWindow':8192,'maxOutputTokens':1024,'reasoningLevels':['none','low','high']})
assert status==200,result
default_selection.save(state,{'providerId':'review','model':'fixture-model'})
session=ctx['store'].new('Synthetic capability UI fixture',workspace)
session['model_selection']={'provider_id':'review','model':'fixture-model'}
session['runtime_activity']={'phase':'completed','reportedInputTokens':2048}
session['permission_mode']='build'
session['messages'].append({'role':'assistant','content':'Synthetic layout fixture; no model request has been performed.'})
ctx['store'].save(session)
server=web.create_server(0,ctx)
threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1],'session':session['id']}),flush=True)
try: sys.stdin.buffer.read()
finally: server.shutdown(); server.server_close()
`;
const serverScript = join(temporary,'server.py');
await writeFile(serverScript,source);
const child = spawn(process.env.PYTHON || 'python3',[serverScript,temporary,join(root,'webapp/dist')],{
  cwd:root,env:{...process.env,PYTHONPATH:root,XUENESS_API_KEY:'',XUENESS_MODEL:'',XUENESS_MARKETPLACE_URL:'',XUENESS_WORKSPACE_ROOTS:''},stdio:['pipe','pipe','pipe']});
let browser;
const errors=[]; const external=[]; const forbiddenRequests=[];
const results=[];
async function guardPage(page, origin) {
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const request=route.request();
    const url=new URL(request.url());
    if(url.origin!==origin){external.push(url.href);await route.abort();return;}
    if(request.method()==='POST' && ['/api/run','/api/sessions','/api/composer/prepare'].includes(url.pathname)){
      forbiddenRequests.push(`${request.method()} ${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}
function decodePng(png) {
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a','screenshot must be PNG');
  let width=0,height=0,bitDepth=0,colorType=0,interlace=0;
  const idat=[];
  for(let offset=8;offset<png.length;) {
    const length=png.readUInt32BE(offset);
    const type=png.toString('ascii',offset+4,offset+8);
    const data=png.subarray(offset+8,offset+8+length);
    if(type==='IHDR'){
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);bitDepth=data[8];colorType=data[9];interlace=data[12];
    } else if(type==='IDAT') idat.push(data);
    offset+=12+length;
    if(type==='IEND')break;
  }
  assert.equal(bitDepth,8,'pixel visibility check expects 8-bit screenshot pixels');
  assert.ok(colorType===2||colorType===6,`unsupported screenshot color type ${colorType}`);
  assert.equal(interlace,0,'pixel visibility check expects non-interlaced screenshots');
  const bpp=colorType===6?4:3;
  const stride=width*bpp;
  const compressed=inflateSync(Buffer.concat(idat));
  const decoded=Buffer.alloc(stride*height);
  let sourceOffset=0;
  const paeth=(a,b,c)=>{
    const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
    return pa<=pb&&pa<=pc?a:pb<=pc?b:c;
  };
  for(let y=0;y<height;y++){
    const filter=compressed[sourceOffset++];
    const rowOffset=y*stride;
    for(let x=0;x<stride;x++){
      const raw=compressed[sourceOffset++];
      const left=x>=bpp?decoded[rowOffset+x-bpp]:0;
      const up=y>0?decoded[rowOffset-stride+x]:0;
      const upLeft=y>0&&x>=bpp?decoded[rowOffset-stride+x-bpp]:0;
      let predictor=0;
      if(filter===1)predictor=left;
      else if(filter===2)predictor=up;
      else if(filter===3)predictor=Math.floor((left+up)/2);
      else if(filter===4)predictor=paeth(left,up,upLeft);
      else assert.equal(filter,0,`unknown PNG row filter ${filter}`);
      decoded[rowOffset+x]=(raw+predictor)&255;
    }
  }
  return {width,height,bpp,pixels:decoded};
}
function countVisiblePixelChanges(firstPng,secondPng) {
  const first=decodePng(firstPng),second=decodePng(secondPng);
  assert.deepEqual([first.width,first.height,first.bpp],[second.width,second.height,second.bpp]);
  let changed=0;
  for(let offset=0;offset<first.pixels.length;offset+=first.bpp){
    let different=false;
    for(let channel=0;channel<first.bpp;channel++){
      if(Math.abs(first.pixels[offset+channel]-second.pixels[offset+channel])>8){different=true;break;}
    }
    if(different)changed++;
  }
  return changed;
}
try {
  const ready=await new Promise((accept,reject)=>{
    let text='',stderr=''; child.stderr.on('data',data=>stderr+=data);
    child.stdout.on('data',data=>{text+=data;if(text.includes('\n'))accept(JSON.parse(text.split('\n')[0]));});
    child.once('exit',code=>reject(new Error(`Fixture server exited ${code}: ${stderr}`)));
    setTimeout(()=>reject(new Error(`Fixture server timeout: ${stderr}`)),15000).unref();
  });
  const origin=`http://127.0.0.1:${ready.port}`;
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
  for(const scheme of ['light','dark'])for(const width of [1280,420]) {
    const context=await browser.newContext({viewport:{width,height:900},colorScheme:scheme,reducedMotion:'reduce',serviceWorkers:'block'});
    await context.addInitScript(({scheme})=>{localStorage.setItem('xueness.theme',scheme);localStorage.setItem('xueness.language','en');},{scheme});
    const page=await context.newPage(); page.setDefaultTimeout(10000);
    await guardPage(page,origin);
    await page.goto(origin);
    const task=page.getByTestId(`xn-sidebar-item-${ready.session}`);
    await task.waitFor({state:'attached'});
    if(!await task.isVisible())await page.getByTestId('xn-shell-sidebar-toggle').click();
    await task.click();
    const ring=page.getByTestId('context-usage-ring');
    await page.waitForFunction(()=>document.querySelector('[data-testid="context-usage-ring"]')?.getAttribute('data-known')==='true');
    assert.equal(await ring.getAttribute('aria-valuenow'),'25');
    assert.equal(await ring.getAttribute('data-usage-source'),'provider-reported');
    assert.equal(await ring.getAttribute('data-capacity-source'),'context-window');
    await ring.focus();
    const tooltip=page.getByRole('tooltip').filter({hasText:'Input context of the latest request'});
    await tooltip.waitFor({state:'visible'});
    const tooltipBox=await tooltip.boundingBox();
    assert.ok(tooltipBox.x>=0 && tooltipBox.x+tooltipBox.width<=width+1,'context tooltip must stay inside the viewport');
    await page.getByTestId('composer-plus').click();
    const menu=page.getByRole('menu',{name:'Add context or capability',exact:true});
    await menu.waitFor({state:'visible'});
    const menuBox=await menu.boundingBox();
    assert.ok(menuBox.x>=0 && menuBox.x+menuBox.width<=width+1,'Add menu must stay inside the viewport');
    const items=menu.locator('.xn-composer-capabilities button');
    assert.equal(await items.count(),9);
    assert.equal(await menu.getByRole('menuitem',{name:'Attachment',exact:true}).count(),1);
    assert.equal(await menu.getByRole('menuitem',{name:'Create workflow',exact:true}).count(),1);
    assert.equal(await page.locator('body').evaluate(node=>node.scrollWidth>innerWidth),false);
    await page.screenshot({path:join(output,`add-${scheme}-${width}.png`)});
    if(scheme==='light' && width===1280) {
      const ids=await items.evaluateAll(nodes=>nodes.map(node=>node.dataset.testid));
      for(let index=0;index<8;index++) {
        if(index)await page.getByTestId('composer-plus').click();
        await page.getByTestId(ids[index]).click();
      }
      await page.getByTestId('composer-plus').click();
      assert.equal(await page.getByTestId(ids[8]).isDisabled(),true);
      await menu.getByRole('status').filter({hasText:'up to 8 capabilities'}).waitFor({state:'visible'});
      assert.equal(await page.getByTestId(ids[0]).isEnabled(),true);
      const disabledChipCount=await page.locator('[data-testid^="composer-capability-chip-"]').count();
      await page.getByTestId(ids[8]).evaluate(node=>node.click());
      assert.equal(await page.locator('[data-testid^="composer-capability-chip-"]').count(),disabledChipCount,
        'native activation of a disabled capability must not add it');
      await page.getByTestId(ids[0]).click();
      await page.getByTestId('composer-plus').click();
      assert.equal(await page.getByTestId(ids[8]).isEnabled(),true);
      await page.keyboard.press('Escape');
      const chips=page.locator('[data-testid^="composer-capability-chip-"]');
      while(await chips.count())await chips.first().getByRole('button',{name:'Remove capability',exact:true}).click();
      await page.getByTestId('composer-plus').click();
    }

    await page.getByTestId('composer-capability-office.docx_authoring').click();
    await page.getByTestId('composer-capability-chip-office.docx_authoring').waitFor({state:'visible'});
    await page.getByTestId('composer-plus').click();
    await menu.getByRole('menuitem',{name:'Add goal',exact:true}).click();
    const goal=page.getByRole('dialog',{name:'Session goal',exact:true});
    await goal.waitFor({state:'visible'});
    await goal.getByRole('textbox',{name:'Goal content'}).fill('Synthetic goal saved through the real API');
    const replacement=goal.getByRole('checkbox');
    if(await replacement.count())await replacement.check();
    await goal.getByRole('button',{name:'Save goal',exact:true}).click();
    try { await goal.waitFor({state:'hidden'}); } catch(error) { await page.screenshot({path:join(output, 'failed-goal.png')});; throw new Error(`Goal save failed: ${await goal.innerText()}`); }
    await page.getByTestId('session-goal').waitFor({state:'visible'});
    const mode=page.getByRole('button',{name:'Mode',exact:true});
    await mode.click();
    await page.getByRole('menuitemradio',{name:/^Full access/}).click();
    const warning=page.getByRole('alertdialog');
    await warning.waitFor({state:'visible'});
    assert.equal(await page.getByRole('menu',{name:'Mode and permissions',exact:true}).count(),0,'permission popover must close before the warning opens');
    await page.waitForFunction(()=>document.querySelector('[data-testid="full-access-cancel"]')===document.activeElement);
    assert.equal(await page.getByTestId('full-access-cancel').evaluate(node=>node===document.activeElement),true);
    const box=await warning.boundingBox();
    assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=901,'warning must stay inside the viewport');
    await page.screenshot({path:join(output,`warning-${scheme}-${width}.png`)});
    await page.getByTestId('full-access-cancel').click();
    assert.match(await mode.innerText(),/Ask before changes/);
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Mode');
    await mode.click(); await page.getByRole('menuitemradio',{name:/^Full access/}).click();
    await page.getByTestId('full-access-confirm').click();
    assert.match(await mode.innerText(),/Full access/);
    await page.getByTestId('composer-plus').click();
    await menu.getByRole('menuitem',{name:'Manage plugins',exact:true}).click();
    await page.getByTestId('xn-installed-plugin-sessions').waitFor({state:'visible'});
    assert.equal(await page.locator('[data-testid^="xn-installed-plugin-"]').count(),28);
    const catalog=await page.evaluate(async()=>{const response=await fetch('/api/plugins');return response.json();});
    const installed=catalog.plugins;
    assert.equal(installed.length,28);
    const featureIds=installed.flatMap(plugin=>plugin.features.map(feature=>feature.id));
    assert.equal(new Set(featureIds).size,160);
    const codes=await page.locator('.xn-plugin-card__details-grid code').allTextContents();
    for(const id of featureIds)assert.ok(codes.includes(id),`Missing feature in plugin panel: ${id}`);
    const heroChecks={};
    if(scheme==='light' && width===1280) {
      await page.getByTestId('xn-sidebar-action-new-task').click();
      await page.getByTestId('xn-hero').waitFor({state:'visible'});
      const heroInput=page.locator('textarea.xn-composer__input');
      await heroInput.fill('Synthetic prompt for Add menu verification');
      await page.getByTestId('composer-plus').click();
      const heroMenu=page.getByRole('menu',{name:'Add context or capability',exact:true});
      await heroMenu.waitFor({state:'visible'});
      const heroItems=heroMenu.locator('.xn-composer-capabilities button');
      await page.waitForFunction(()=>document.querySelectorAll('.xn-composer-capabilities button').length===9);
      assert.equal(await heroItems.count(),9,'hero Add menu must retain all nine unfiltered capabilities');
      const addSearch=page.getByTestId('composer-add-search');
      await addSearch.fill('skill creator');
      assert.equal(await page.getByTestId('composer-capability-skills.skill_creator').isVisible(),true);
      assert.equal(await page.getByTestId('composer-capability-office.xlsx_authoring').count(),0,
        'search must filter nonmatching capability rows');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      assert.deepEqual(forbiddenRequests,[],'Enter in Add search must not submit the hero composer');
      await addSearch.fill('search-fixture.md');
      assert.equal(await heroMenu.locator('.xn-composer-capabilities button').count(),0,
        'mention search should hide nonmatching capability rows');
      const fixtureMention=heroMenu.getByRole('menuitemcheckbox').filter({hasText:'search-fixture.md'});
      await fixtureMention.waitFor({state:'visible'});
      assert.equal(await fixtureMention.count(),1,'search must find the synthetic workspace-file mention');
      await addSearch.fill('');
      await page.waitForFunction(()=>document.querySelectorAll('.xn-composer-capabilities button').length===9);

      // A native mouse sequence with a null-relatedTarget focusout must leave
      // the target mounted through mouseup/click so its React action can run.
      const target=page.getByTestId('composer-capability-skills.skill_creator');
      await target.scrollIntoViewIfNeeded();
      const targetBox=await target.boundingBox();
      assert.ok(targetBox,'hero capability row must be hittable');
      await page.evaluate(testId=>{
        const row=document.querySelector(`[data-testid="${testId}"]`);
        const focused=document.activeElement;
        if(!row || !(focused instanceof HTMLElement))throw new Error('Add menu did not focus a menu control');
        row.addEventListener('mousedown',()=>{
          focused.dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:null}));
        },{once:true});
      },'composer-capability-skills.skill_creator');
      await page.mouse.move(targetBox.x+targetBox.width/2,targetBox.y+targetBox.height/2);
      await page.mouse.down();
      const mountedAfterMouseDown=await page.evaluate(testId=>Boolean(document.querySelector(`[data-testid="${testId}"]`)),
        'composer-capability-skills.skill_creator');
      await page.mouse.up();
      const heroChip=page.getByTestId('composer-capability-chip-skills.skill_creator');
      await heroChip.waitFor({state:'visible'});
      assert.equal(mountedAfterMouseDown,true,'null focusout during pointer activation must not unmount the menu row');
      const remove=heroChip.getByRole('button',{name:'Remove capability',exact:true});
      const hitTests=await page.evaluate(({chipId})=>{
        const chip=document.querySelector(`[data-testid="${chipId}"]`);
        const removeButton=chip?.querySelector('button');
        if(!chip || !removeButton)throw new Error('hero capability chip/remove button missing');
        const center=element=>{
          const rect=element.getBoundingClientRect();
          const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
          return {inside:hit!==null && element.contains(hit),hit:hit?.tagName ?? null,hitClass:hit instanceof HTMLElement?hit.className:null};
        };
        return {chip:center(chip),remove:center(removeButton)};
      },{chipId:'composer-capability-chip-skills.skill_creator'});
      assert.equal(hitTests.chip.inside,true,`hero chip center is covered: ${JSON.stringify(hitTests.chip)}`);
      assert.equal(hitTests.remove.inside,true,`hero remove button is covered: ${JSON.stringify(hitTests.remove)}`);
      assert.equal(await remove.isVisible(),true);
      const chipBounds=await heroChip.boundingBox();
      assert.ok(chipBounds,'hero chip must have a screenshot-visible rectangle');
      const clip={x:Math.floor(chipBounds.x),y:Math.floor(chipBounds.y),width:Math.ceil(chipBounds.width),height:Math.ceil(chipBounds.height)};
      await page.screenshot({path:join(output,'hero-after-capability-click-light-1280.png')});
      const visibleChipPng=await page.screenshot({clip});
      await page.evaluate(chipId=>{
        const chip=document.querySelector(`[data-testid="${chipId}"]`);
        if(!chip)throw new Error('hero capability chip disappeared before screenshot comparison');
        chip.style.visibility='hidden';
      },'composer-capability-chip-skills.skill_creator');
      const coveredReferencePng=await page.screenshot({clip});
      await page.evaluate(chipId=>{
        const chip=document.querySelector(`[data-testid="${chipId}"]`);
        if(chip)chip.style.visibility='';
      },'composer-capability-chip-skills.skill_creator');
      const visibleChipPixels=countVisiblePixelChanges(visibleChipPng,coveredReferencePng);
      assert.ok(visibleChipPixels>20,`hero chip must visibly paint in its screenshot; changed pixels: ${visibleChipPixels}`);
      heroChecks.mouseNullRelatedTarget=true;
      heroChecks.chipAndRemoveHitTest=hitTests;
      heroChecks.screenshotVisibleChipPixels=visibleChipPixels;
      heroChecks.chipScreenshot='hero-after-capability-click-light-1280.png';

      await remove.click();
      await page.getByTestId('composer-plus').focus();
      await page.keyboard.press('Enter');
      await heroMenu.waitFor({state:'visible'});
      const keyboardOption=page.getByTestId('composer-capability-office.xlsx_authoring');
      await keyboardOption.focus();
      await page.keyboard.press('Space');
      await page.getByTestId('composer-capability-chip-office.xlsx_authoring').waitFor({state:'visible'});
      heroChecks.keyboardActivation=true;

      // Exercise the direct attachment action through Chromium's real chooser.
      const chooserPromise=page.waitForEvent('filechooser');
      await page.getByTestId('composer-attachment').click();
      const chooser=await chooserPromise;
      await chooser.setFiles({name:'composer-fixture.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic attachment')});
      await page.getByTestId('composer-attachment-chip').waitFor({state:'visible'});
      heroChecks.primaryAttachmentFileChooser=true;

      await page.getByTestId('composer-plus').click();
      await heroMenu.getByRole('menuitem',{name:'Add goal',exact:true}).click();
      await page.getByTestId('composer-goal-chip').waitFor({state:'visible'});
      heroChecks.newTaskGoalChip=true;
      await page.getByTestId('composer-plus').click();
      await heroMenu.getByRole('menuitem',{name:'Create workflow',exact:true}).click();
      await page.getByRole('region',{name:'Workflows and background jobs',exact:true}).waitFor({state:'visible'});
      heroChecks.workflowPanel=true;
    }
    results.push({scheme,width,capabilities:9,plugins:28,features:160,syntheticInputFraction:'2048/8192',goalSaved:true,warningCancelAndConfirm:true,...heroChecks});
    await context.close();
  }
  const touchContext=await browser.newContext({viewport:{width:420,height:900},colorScheme:'light',reducedMotion:'reduce',serviceWorkers:'block',hasTouch:true});
  await touchContext.addInitScript(()=>{localStorage.setItem('xueness.theme','light');localStorage.setItem('xueness.language','en');});
  const touchPage=await touchContext.newPage();touchPage.setDefaultTimeout(10000);await guardPage(touchPage,origin);
  await touchPage.goto(origin);
  await touchPage.getByTestId('xn-hero').waitFor({state:'visible'});
  await touchPage.getByTestId('composer-plus').waitFor({state:'visible'});
  const plusBox=await touchPage.getByTestId('composer-plus').boundingBox();
  assert.ok(plusBox,'touch hero plus button must be visible');
  await touchPage.touchscreen.tap(plusBox.x+plusBox.width/2,plusBox.y+plusBox.height/2);
  const touchMenu=touchPage.getByRole('menu',{name:'Add context or capability',exact:true});
  await touchMenu.waitFor({state:'visible'});
  await touchPage.waitForFunction(()=>document.querySelectorAll('.xn-composer-capabilities button').length===9);
  const touchMenuBox=await touchMenu.boundingBox();
  assert.ok(touchMenuBox.width<=400 && touchMenuBox.height<=360,
    `narrow Add menu should remain compact: ${JSON.stringify(touchMenuBox)}`);
  const touchOption=touchPage.getByTestId('composer-capability-skills.skill_creator');
  await touchOption.scrollIntoViewIfNeeded();
  const touchBox=await touchOption.boundingBox();
  assert.ok(touchBox,'touch capability must be visible after scrolling');
  await touchPage.touchscreen.tap(touchBox.x+touchBox.width/2,touchBox.y+touchBox.height/2);
  await touchPage.getByTestId('composer-capability-chip-skills.skill_creator').waitFor({state:'visible'});
  assert.deepEqual(forbiddenRequests,[],'touch activation must not start a model request');
  results.push({surface:'hero-touch',width:420,capability:'skills.skill_creator',touchActivation:true,menuWidth:touchMenuBox.width,menuHeight:touchMenuBox.height});
  await touchContext.close();
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(forbiddenRequests,[]);
  await writeFile(join(output,'verification.json'),JSON.stringify({syntheticFixture:true,noModelRequests:true,results,errors,external,forbiddenRequests},null,2));
  process.stdout.write(`PASS: production Add menu pointer, touch, keyboard/search, hero chip hit-testing, attachment chooser, goal/workflow actions, context ring, and 28 plugins/160 features in light/dark 1280/420. ${output}\n`);
} finally {
  if(browser)await browser.close(); child.stdin.end();
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},5000).unref();});
  await rm(temporary,{recursive:true,force:true});
}
