import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { observationState, filterObservations, ModelMonitorPanel, type ModelObservation } from './index';
import { setLocale } from '../../i18n';
test('missing IDs stay unreported; multiple wire IDs can expose routing differences', () => {
  const row = { requestedModel: 'requested', returnedModels: [] } as unknown as ModelObservation;
  assert.equal(observationState(row), 'unreported');
  assert.equal(observationState({ ...row, returnedModels: ['requested'] }), 'same');
  assert.equal(observationState({ ...row, returnedModels: ['requested', 'alias'] }), 'different');
  const rows = [{ ...row, id: 'one', providerId: 'test', returnedModels: ['alias'] }, { ...row, id: 'two', providerId: 'test', returnedModels: ['requested'] }];
  assert.deepEqual(filterObservations(rows, 'alias', 'different').map(row => row.id), ['one']);
});
test('initial view waits for evidence and does not assert a rollout or fabricate history', () => {
  setLocale('en'); const markup = renderToStaticMarkup(<ModelMonitorPanel />);
  assert.match(markup, /without extra model requests/);
  assert.match(markup, /Model IDs are not inferred/);
  assert.doesNotMatch(markup, /Gemini 4 Argon|model-observation/);
  setLocale('zh');
});
