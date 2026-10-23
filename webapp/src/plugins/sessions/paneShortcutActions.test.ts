import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePaneControlKey, paneControlTarget } from './paneShortcutActions';
const event = { key:'F', altKey:true, shiftKey:true };
const context = { enabled:true, bindings:{}, platform:'win32' };
test('pane controls dispatch once with IME, modal, repeat, terminal and consumed-event precedence', () => {
  assert.equal(evaluatePaneControlKey(event, context), 'find-in-task');
  for (const patch of [{repeat:true},{isComposing:true},{keyCode:229},{defaultPrevented:true}]) assert.equal(evaluatePaneControlKey({...event,...patch},context),null);
  assert.equal(evaluatePaneControlKey(event,{...context,blocked:true}),null);
  assert.equal(evaluatePaneControlKey(event,{...context,enabled:false}),null);
  assert.equal(evaluatePaneControlKey(event,{...context,target:{closest:()=>({})}}),null);
  assert.equal(evaluatePaneControlKey({key:'c',ctrlKey:true},{...context,bindings:{'find-in-task':'Ctrl+C'}}),null);
});
test('pane resolution uses captured focused identity, never another matching pane', () => {
  const target = { closest:()=>null, getAttribute:()=>null, disabled:false };
  const first = {dataset:{paneId:'primary',paneFocused:'false'},hidden:false,querySelector:()=>target};
  const second = {dataset:{paneId:'secondary',paneFocused:'true'},hidden:false,querySelector:()=>target};
  const root = { querySelectorAll:()=>[first,second] } as unknown as HTMLElement;
  assert.equal(paneControlTarget(root,'primary','open-model-menu'),null);
  assert.equal(paneControlTarget(root,'secondary','open-model-menu'),target);
  second.hidden=true; assert.equal(paneControlTarget(root,'secondary','open-model-menu'),null);
});
