import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, resolveTheme } from './themeBoot';
test('prepaint theme uses explicit preferences and otherwise follows the operating system', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(normalizeTheme('invalid'), 'system');
  assert.equal(resolveTheme(null, false), 'light');
});
