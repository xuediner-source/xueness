import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppZoom, nextAppZoom, shortcutOwner } from './workbenchShortcutActions';
import { matchesShortcut, normalizeShortcutBinding, findShortcutConflict, recordShortcutEvent, isReservedShortcut } from '../../xuenessShortcutCommands';
import { displayBindingParts } from '../../xuenessShortcutDisplay';
test('app zoom is bounded and resettable; corrupt settings cannot scale the app', () => {
  assert.equal(normalizeAppZoom(NaN), 1); assert.equal(normalizeAppZoom('1.5'), 1);
  assert.equal(nextAppZoom(1.5, 'zoom-in'), 1.5); assert.equal(nextAppZoom(.75, 'zoom-out'), .75);
  assert.equal(nextAppZoom(1.2, 'reset-zoom'), 1); assert.equal(nextAppZoom(1, 'zoom-in'), 1.1);
  assert.equal(shortcutOwner('toggle-terminal'), 'terminal');
});
test('alternative bindings preserve legacy strings and detect conflicts against every chord', () => {
  assert.equal(normalizeShortcutBinding('Mod+K'), 'Mod+K');
  assert.equal(normalizeShortcutBinding('mod+k | shift+mod+p'), 'Mod+K | Mod+Shift+P');
  assert.equal(normalizeShortcutBinding('Mod+K |'), null);
  assert.equal(matchesShortcut({key:'P',ctrlKey:true,shiftKey:true}, 'Mod+K | Mod+Shift+P', 'win32'), true);
  assert.equal(matchesShortcut({key:'P',metaKey:true,shiftKey:true}, 'Mod+K | Mod+Shift+P', 'darwin'), true);
  assert.equal(findShortcutConflict('Mod+Shift+P', 'refresh-session', {}, 'win32'), 'command-palette');
  assert.deepEqual(displayBindingParts('Mod+K | Mod+Shift+P', 'darwin'), ['⌘','K',' / ','⌘','⇧','P']);
});
test('bare Enter is recordable only for composer and browser editing keys stay reserved', () => {
  assert.deepEqual(recordShortcutEvent({key:'Enter'}, 'win32', 'composer'), {kind:'binding',binding:'Enter'});
  assert.deepEqual(recordShortcutEvent({key:'Enter'}, 'win32', 'global'), {kind:'invalid',reason:'modifier-required'});
  for (const key of ['Ctrl+C','Meta+F','Mod+K | Ctrl+W']) assert.equal(isReservedShortcut(key), true);
});
