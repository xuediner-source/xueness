import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTerminalLifecycle, setTerminalLifecycleEnabled, removeTerminalWorkspace } from './terminalLifecycle';
import { hasGlobalShortcutConflict } from '../../xuenessShortcutCommands';

test('shell lifecycle disables the lazy owner without mounting terminal UI', () => {
  const enabled: boolean[] = []; const removed: string[] = [];
  setTerminalLifecycleEnabled(true);
  registerTerminalLifecycle({ setEnabled: value => enabled.push(value), removeWorkspace: id => removed.push(id) });
  setTerminalLifecycleEnabled(false); removeTerminalWorkspace('/explicitly-removed');
  assert.deepEqual(enabled, [true, false]); assert.deepEqual(removed, ['/explicitly-removed']);
  registerTerminalLifecycle(undefined);
});

test('existing workbench shortcut arbitration leaves focused terminal control keys and IME alone', () => {
  const target = { className: 'xn-terminal-host', closest: (selector: string) => selector.includes('terminal') ? target : null };
  assert.equal(hasGlobalShortcutConflict({ key: 'c', ctrlKey: true }, 'new-session', target, 'win32'), true);
  assert.equal(hasGlobalShortcutConflict({ key: 'n', ctrlKey: true }, 'new-session', target, 'win32'), true);
  assert.equal(hasGlobalShortcutConflict({ key: 'k', metaKey: true, isComposing: true }, 'command-palette', target, 'darwin'), true);
});

test('remote disable reaches detached terminal owners without disabling local shells', async () => {
  const { setRemoteTerminalLifecycleEnabled } = await import('./terminalLifecycle');
  const local: boolean[] = [], remote: boolean[] = [];
  setTerminalLifecycleEnabled(true); setRemoteTerminalLifecycleEnabled(true);
  registerTerminalLifecycle({ setEnabled: value => local.push(value), setRemoteEnabled: value => remote.push(value), removeWorkspace() {} });
  setRemoteTerminalLifecycleEnabled(false);
  assert.deepEqual(local, [true]); assert.deepEqual(remote, [true, false]);
  registerTerminalLifecycle(undefined);
});
