import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, resolveTheme, normalizeColorPalette } from './themeBoot';

test('prepaint theme uses explicit preferences and otherwise follows the operating system', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(normalizeTheme('invalid'), 'system');
  assert.equal(resolveTheme(null, false), 'light');
});

test('color palette defaults to Xueness and only accepts the Codex 风格 value (stored as claude)', () => {
  assert.equal(normalizeColorPalette(undefined), 'xueness');
  assert.equal(normalizeColorPalette(null), 'xueness');
  assert.equal(normalizeColorPalette('xueness'), 'xueness');
  assert.equal(normalizeColorPalette('claude'), 'claude');
  assert.equal(normalizeColorPalette('warm'), 'xueness');
  assert.equal(normalizeColorPalette(''), 'xueness');
});
