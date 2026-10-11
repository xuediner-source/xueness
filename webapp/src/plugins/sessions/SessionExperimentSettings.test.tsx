import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionExperimentSettings } from './SessionExperimentSettings';

test('session auto-titling defaults on and stays switchable', () => {
  const on = renderToStaticMarkup(<SessionExperimentSettings values={{}} onUpdate={() => undefined} />);
  assert.match(on, /会话自动命名/);
  assert.match(on, /首个回答完成后自动生成简短标题，手动重命名优先。/);
  assert.match(on, /aria-checked="true"/, 'an unset sessionsAutoTitleEnabled keeps the switch on');
  assert.doesNotMatch(on, /disabled=""/, 'the switch is operable when a save handler exists');
  const off = renderToStaticMarkup(<SessionExperimentSettings values={{ sessionsAutoTitleEnabled: false }} onUpdate={() => undefined} />);
  assert.match(off, /aria-checked="false"/, 'turning the feature off clears the switch');
  // The experimental rows keep their default-off semantics next to it.
  const mixed = renderToStaticMarkup(
    <SessionExperimentSettings values={{ sessionsAutoTitleEnabled: false, sessionsEventsCursorEnabled: true }} onUpdate={() => undefined} />);
  assert.equal((mixed.match(/aria-checked="true"/g) ?? []).length, 1, 'only the enabled experiment is on');
});

test('without a save handler the auto-titling switch is visible but inert', () => {
  const html = renderToStaticMarkup(<SessionExperimentSettings values={{ sessionsAutoTitleEnabled: true }} />);
  assert.match(html, /aria-checked="true"/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3, 'all three switches render disabled');
});
