import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorkbenchStorage, type StorageLike } from './desktopStorage';

test('workbench storage uses the desktop bridge without falling back after a bridge failure', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const installWindow = (value: unknown) => Object.defineProperty(globalThis, 'window', {
    configurable: true, writable: true, value,
  });
  try {
    installWindow(undefined);
    assert.equal(getWorkbenchStorage(), null, 'server rendering has no browser storage');

    const web = { location: { search: '' }, localStorage: {} as StorageLike } as unknown as Window;
    Object.defineProperty(web, 'top', { value: web });
    installWindow(web);
    assert.equal(getWorkbenchStorage(), web.localStorage, 'ordinary web work keeps using browser localStorage');

    let fallbackWrites = 0;
    const desktop = { location: { search: '?xuenessDesktop=1' }, localStorage: {
      getItem: () => null,
      setItem: () => { fallbackWrites++; },
    } as StorageLike } as unknown as Window;
    Object.defineProperty(desktop, 'top', { value: desktop });
    installWindow(desktop);
    assert.equal(getWorkbenchStorage(), null, 'desktop pages without preload cannot write port-local data');

    const bridge: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error('host store unavailable'); },
    };
    desktop.xuenessDesktopStorage = bridge;
    const selected = getWorkbenchStorage();
    assert.equal(selected, bridge);
    assert.throws(() => selected!.setItem('xueness.sessions.pane-layout.v2', '{}'), /host store unavailable/);
    assert.equal(fallbackWrites, 0, 'failed host writes never fall through to random-port localStorage');
  } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
