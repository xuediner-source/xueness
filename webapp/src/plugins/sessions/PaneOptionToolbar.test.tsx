import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { choosePanePermission, panePlanningAvailable, loadPaneOptionCatalog, selectedPaneModel, paneModelChoice, paneModelsNeedSetup, paneCatalogNeedsModelSetup, configurePaneModels, PaneModelSetupAction, PaneOptionToolbar, PaneOptionMenu } from './PaneOptionToolbar';
import { emptyComposerCatalog, type ComposerModel } from '../../xuenessComposer';
import type { RunChoices } from '../../xuenessBridge';
const model: ComposerModel = { id: 'one', model: 'model-one', name: 'One', configured: true, protocol: 'openai', capabilities: [], reasoningLevels: ['low', 'high'] };
const choices: RunChoices = { provider: 'real', mode: 'build', provider_id: 'one', model: 'model-one', reasoning_effort: 'high', permission_mode: 'build' };
test('catalog reads are scoped to the local pane and never fall back from remote', async () => {
  const calls: unknown[][] = [];
  const load = async (...args: Parameters<typeof import('../../xuenessComposer').loadComposerCatalog>) => { calls.push(args); return emptyComposerCatalog; };
  const controller = new AbortController();
  const args = { enabled: true, providers: true, remote: false, root: '/second', sessionId: 'second' };
  for (const override of [{ enabled: false }, { providers: false }, { remote: true }]) {
    assert.equal(await loadPaneOptionCatalog({ ...args, ...override }, controller.signal, load), null);
  }
  assert.equal(calls.length, 0);
  await loadPaneOptionCatalog(args, controller.signal, load);
  assert.deepEqual(calls, [['/second', 'second', controller.signal]]);
  controller.abort();
  assert.equal(await loadPaneOptionCatalog(args, controller.signal, load), null);
  assert.equal(calls.length, 1);
});
test('provider and model must both match, including stale saved selections', () => {
  assert.equal(selectedPaneModel([model], choices), model);
  assert.equal(selectedPaneModel([model], { ...choices, model: 'deleted' }), undefined);
  assert.equal(selectedPaneModel([model], { ...choices, provider_id: 'other' }), undefined);
  assert.equal(selectedPaneModel([model], { ...choices, provider_id: undefined }), model);
});
test('model selection copies one pane, clears incompatible reasoning and standard profile', () => {
  const original = { ...choices, runtime_profile: 'standard' as const };
  const next = paneModelChoice(original, { ...model, id: 'two', model: 'model-two', toolCalling: 'json' });
  assert.equal(next.model, 'model-two'); assert.equal(next.provider_id, 'two');
  assert.equal(next.reasoning_effort, undefined); assert.equal(next.runtime_profile, undefined);
  assert.equal(original.model, 'model-one'); assert.equal(original.reasoning_effort, 'high'); assert.equal(original.runtime_profile, 'standard');
  assert.notEqual(next.acknowledge_yolo, true);
});
const props = { enabled: true, effectivePluginIds: new Set(['sessions', 'providers', 'planning']), remote: false, remoteCommands: false,
  root: '/second', sessionId: 'second', choices, onChange: () => {}, isCurrent: () => true, ensurePermission: async () => null };
test('session/provider gates fail closed and remote has no local model/reasoning selector', () => {
  assert.equal(renderToStaticMarkup(<PaneOptionToolbar {...props} enabled={false} />), '');
  assert.equal(renderToStaticMarkup(<PaneOptionToolbar {...props} effectivePluginIds={new Set(['providers'])} />), '');
  const remote = renderToStaticMarkup(<PaneOptionToolbar {...props} remote />);
  assert.match(remote, /open-mode-menu/); assert.doesNotMatch(remote, /open-model-menu|open-reasoning-menu/);
  assert.match(remote, /role="status"/);
  const providersOff = renderToStaticMarkup(<PaneOptionToolbar {...props} effectivePluginIds={new Set(['sessions'])} />);
  assert.doesNotMatch(providersOff, /open-model-menu|open-reasoning-menu/);
});
test('option triggers expose real accessible focused-pane menu actions', () => {
  const html = renderToStaticMarkup(<PaneOptionMenu label="Model" action="open-model-menu" options={[]} disabled />);
  assert.match(html, /aria-haspopup="menu"/); assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-shortcut-action="open-model-menu"/); assert.match(html, /disabled=""/);
});

test('empty or unconfigured pane catalogs offer explicit model setup under the providers gate', () => {
  assert.equal(paneModelsNeedSetup([]), true);
  assert.equal(paneModelsNeedSetup([{ ...model, configured: false }]), true);
  assert.equal(paneModelsNeedSetup([model]), false);
  assert.equal(paneCatalogNeedsModelSetup(true, []), true);
  assert.equal(paneCatalogNeedsModelSetup(false, []), false, 'loading, failed, disabled, or unavailable catalogs cannot claim setup is needed');
  assert.equal(paneCatalogNeedsModelSetup(true, [model]), false);
  assert.equal(paneCatalogNeedsModelSetup(true, [{ ...model, configured: false }]), true);
  const html = renderToStaticMarkup(<PaneModelSetupAction onConfigure={() => {}} />);
  assert.match(html, /data-testid="pane-model-setup"/);
  assert.match(html, /role="status"[^>]*>暂无可用模型|暂无可用模型/);
  assert.match(html, /<button[^>]*>配置模型<\/button>/);
  assert.doesNotMatch(renderToStaticMarkup(<PaneModelSetupAction />), /<button/);

  const opened: string[] = [];
  configurePaneModels(new Set(['sessions']), () => true, () => opened.push('open'));
  configurePaneModels(new Set(['providers']), () => false, () => opened.push('open'));
  assert.equal(opened.length, 0);
  configurePaneModels(new Set(['providers']), () => true, () => opened.push('open'));
  assert.deepEqual(opened, ['open']);
});

test('permission changes require confirmation and cannot write across rebind/disable', async () => {
  const saved: RunChoices[] = [];
  let current = true;
  let prompted = 0;
  const confirm = async (value: RunChoices) => { prompted++; return { ...value, acknowledge_yolo: true }; };
  assert.equal(await choosePanePermission('yolo', choices, confirm, () => current, value => saved.push(value)), true);
  assert.equal(saved[0].permission_mode, 'yolo'); assert.equal(saved[0].acknowledge_yolo, false);
  assert.equal(choices.permission_mode, 'build');
  assert.equal(await choosePanePermission('yolo', choices, async () => null, () => current, value => saved.push(value)), false);
  assert.equal(await choosePanePermission('yolo', choices, async value => { current = false; return value; }, () => current, value => saved.push(value)), false);
  assert.equal(await choosePanePermission('yolo', choices, confirm, () => current, value => saved.push(value)), false);
  assert.equal(prompted, 1); assert.equal(saved.length, 1);
});

test('remote catalog uses only the injected owner-bound loader with no local root', async () => {
  let localCalls = 0;
  const calls: unknown[][] = [];
  const controller = new AbortController();
  const remoteLoad = async (...args: Parameters<typeof import('../../xuenessComposer').loadComposerCatalog>) => { calls.push(args); return emptyComposerCatalog; };
  const local = async () => { localCalls++; return emptyComposerCatalog; };
  const args = { enabled: true, providers: true, remote: true, root: '/local-private-root', sessionId: 'remote-session', remoteLoad };
  assert.equal(await loadPaneOptionCatalog(args, controller.signal, local), emptyComposerCatalog);
  assert.deepEqual(calls, [[undefined, 'remote-session', controller.signal]]); assert.equal(localCalls, 0);
  await assert.rejects(loadPaneOptionCatalog({ ...args, remoteLoad: async () => { throw new Error('disconnected'); } }, controller.signal, local), /disconnected/);
  assert.equal(localCalls, 0);
  await loadPaneOptionCatalog({ ...args, providers: false }, controller.signal, local);
  assert.equal(calls.length, 1);
});
test('selecting full access never treats the current pane choice as saved-session approval', async () => {
  let savedMode: unknown = 'not-called';
  await choosePanePermission('yolo', { ...choices, permission_mode: 'yolo' }, async (value, saved) => { savedMode = saved; return value; }, () => true, () => {});
  assert.equal(savedMode, undefined);
});

test('remote planning uses only exact remote catalog capability, not local settings', () => {
  assert.equal(panePlanningAvailable(true, null, new Set(['planning'])), false);
  assert.equal(panePlanningAvailable(true, { ...emptyComposerCatalog, planningEnabled: false }, new Set(['planning'])), false);
  assert.equal(panePlanningAvailable(true, { ...emptyComposerCatalog, planningEnabled: true }, new Set()), true);
  assert.equal(panePlanningAvailable(false, { ...emptyComposerCatalog, planningEnabled: true }, new Set()), false);
  assert.equal(panePlanningAvailable(false, null, new Set(['planning'])), true);
});
