import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { closeWorkbenchTab, readWorkbenchTabs, reconcileWorkbenchTabs, WorkbenchTabs } from './WorkbenchTabs';

test('saved tabs tolerate damaged storage and strip everything except presentation metadata', () => {
  assert.deepEqual(readWorkbenchTabs('{'), []);
  assert.deepEqual(readWorkbenchTabs('{"id":"a"}'), []);
  assert.deepEqual(readWorkbenchTabs(JSON.stringify([null, {}, { id: '' }, { id: 'a', title: 'Title', root: '/work', status: 'running', draft: 'private' }, { id: 'a' }])), [
    { id: 'a', title: 'Title', root: '/work' },
  ]);
});

test('temporary loading and partial catalogs retain tabs while sidebar selections reopen them', () => {
  const original = [{ id: 'outside-page', title: 'Older task' }, { id: 'a', title: 'Old title' }];
  assert.equal(reconcileWorkbenchTabs(original, [], 'a', false), original);
  assert.equal(reconcileWorkbenchTabs(original, [], 'a', true), original);
  assert.deepEqual(reconcileWorkbenchTabs(original, [{ id: 'a', task: 'Task', title: 'Renamed', status: 'running', root: '/repo' }], 'new-selection', true), [
    original[0], { id: 'a', title: 'Renamed', root: '/repo' }, { id: 'new-selection', title: undefined, root: undefined },
  ]);
});

test('closing a selected tab chooses the right neighbor, then left, then new task; closing another preserves selection', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(closeWorkbenchTab(tabs, 'b', 'b'), { tabs: [{ id: 'a' }, { id: 'c' }], activeId: 'c' });
  assert.equal(closeWorkbenchTab(tabs, 'c', 'c').activeId, 'b');
  assert.equal(closeWorkbenchTab(tabs, 'a', 'c').activeId, 'c');
  assert.deepEqual(closeWorkbenchTab([{ id: 'a' }], 'a', 'a'), { tabs: [], activeId: null });
  assert.equal(reconcileWorkbenchTabs(closeWorkbenchTab(tabs, 'b', 'b').tabs, [], 'b', true).at(-1)?.id, 'b');
});

test('tabs expose the selected conversation and independent close actions, and disappear when sessions is disabled', () => {
  const props = { enabled: true, tabs: [{ id: 'a', title: 'Review', status: 'running' }, { id: 'b', title: 'Build' }], activeId: 'a', onSelect() {}, onNew() {}, onClose() {} };
  const html = renderToStaticMarkup(<WorkbenchTabs {...props} />);
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.match(html, /aria-label="关闭标签页：Review"/);
  assert.match(html, /data-status="running"/);
  assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  assert.equal(renderToStaticMarkup(<WorkbenchTabs {...props} enabled={false} />), '');
});
