const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SETTINGS_URIS, isPermissionsRequest, getPermissionSnapshot,
  openPermissionSettings, createPermissionsHandler,
} = require('../src/permissions.cjs');

const requestId = '0123456789abcdef0123456789abcdef';
const message = (permission, action = 'request') => ({ type: 'permissions', id: requestId, action, ...(permission ? { permission } : {}) });
const liveWindow = () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false } });

test('private permission protocol accepts only exact status and request messages', () => {
  assert.equal(isPermissionsRequest(message(undefined, 'status')), true);
  assert.equal(isPermissionsRequest(message('microphone')), true);
  assert.equal(isPermissionsRequest({ ...message('microphone'), extra: true }), false);
  assert.equal(isPermissionsRequest({ ...message(undefined, 'status'), permission: 'screen' }), false);
  assert.equal(isPermissionsRequest(message('screen', 'open')), false);
  assert.equal(isPermissionsRequest(message('camera')), false);
  assert.equal(isPermissionsRequest({ ...message('screen'), id: 'not-an-id' }), false);
});

test('macOS reads use non-prompting permission APIs and report Full Disk Access honestly', () => {
  const calls = [];
  const snapshot = getPermissionSnapshot({ platform: 'darwin', systemPreferences: {
    isTrustedAccessibilityClient(prompt) { calls.push(['accessibility', prompt]); return false; },
    getMediaAccessStatus(mediaType) { calls.push(['media', mediaType]); return mediaType === 'screen' ? 'denied' : 'granted'; },
    askForMediaAccess() { calls.push(['prompt']); throw new Error('must not prompt on read'); },
  } });
  assert.deepEqual(calls, [['accessibility', false], ['media', 'screen'], ['media', 'microphone']]);
  assert.deepEqual(snapshot.permissions.map(item => [item.id, item.status]), [
    ['accessibility', 'not-determined'], ['screen', 'denied'], ['fullDisk', 'unknown'], ['microphone', 'granted'],
  ]);
  assert.equal(snapshot.permissions.find(item => item.id === 'screen').requiresRestart, true);
  assert.equal(snapshot.permissions.find(item => item.id === 'microphone').requiresRestart, undefined);
  assert.equal(snapshot.permissions.find(item => item.id === 'fullDisk').canRequest, true);
});

test('macOS restart hints follow native status and neither reads nor settings actions fake a grant', async () => {
  const calls = [];
  let screen = 'not-determined';
  let microphone = 'denied';
  const handler = createPermissionsHandler({
    platform: 'darwin',
    systemPreferences: {
      isTrustedAccessibilityClient(prompt) { calls.push(['accessibility', prompt]); return true; },
      getMediaAccessStatus(type) {
        calls.push(['status', type]);
        return type === 'screen' ? screen : microphone;
      },
      askForMediaAccess(type) { calls.push(['ask', type]); throw new Error('status must never prompt'); },
    },
    shell: { async openExternal(uri) { calls.push(['settings', uri]); } },
    getOwnerWindow: liveWindow,
    getBackend: () => ({ origin: 'http://127.0.0.1:41234', token: 'native-token' }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true }) }),
  });
  const statusMessage = message(undefined, 'status');
  const initial = await handler(statusMessage);
  assert.equal(initial.state.permissions.find(item => item.id === 'screen').status, 'not-determined');
  assert.equal(initial.state.permissions.find(item => item.id === 'screen').requiresRestart, true);
  assert.equal(initial.state.permissions.find(item => item.id === 'microphone').status, 'denied');
  assert.equal(initial.state.permissions.find(item => item.id === 'microphone').requiresRestart, true);
  assert.equal(calls.some(call => call[0] === 'ask'), false, 'Reading status must not prompt for permission');

  const screenAction = await handler(message('screen'));
  assert.equal(screenAction.state.permissions.find(item => item.id === 'screen').status, 'not-determined');
  assert.equal(screenAction.state.permissions.find(item => item.id === 'screen').requiresRestart, true);
  assert.deepEqual(calls.filter(call => call[0] === 'settings'), [['settings', SETTINGS_URIS.darwin.screen]]);
  assert.equal(calls.some(call => call[0] === 'ask'), false, 'The screen action must only open its fixed settings pane');

  // Simulate a later native status read after the user changes settings. Only
  // the Electron API result can clear the advisory; no code grants it itself.
  screen = 'granted';
  microphone = 'granted';
  const refreshed = await handler(statusMessage);
  for (const id of ['screen', 'microphone']) {
    const permission = refreshed.state.permissions.find(item => item.id === id);
    assert.equal(permission.status, 'granted');
    assert.equal(permission.requiresRestart, undefined, `${id} restart hint clears only when native status is granted`);
  }
  assert.equal(calls.some(call => call[0] === 'ask'), false);
});

test('Windows does not turn Electron screen status into a fake grant', () => {
  const mediaTypes = [];
  const snapshot = getPermissionSnapshot({ platform: 'win32', systemPreferences: {
    getMediaAccessStatus(mediaType) { mediaTypes.push(mediaType); return 'granted'; },
  } });
  assert.deepEqual(mediaTypes, ['microphone']);
  assert.equal(snapshot.permissions.find(item => item.id === 'screen').status, 'unsupported');
  assert.equal(snapshot.permissions.find(item => item.id === 'fullDisk').status, 'unsupported');
  assert.equal(snapshot.permissions.find(item => item.id === 'microphone').status, 'granted');
});

test('non-native platforms report every permission unsupported', () => {
  const snapshot = getPermissionSnapshot({ platform: 'linux', systemPreferences: {
    getMediaAccessStatus() { throw new Error('unsupported'); },
  } });
  assert.deepEqual(snapshot.permissions.map(item => item.status), ['unsupported', 'unsupported', 'unsupported', 'unsupported']);
  assert.ok(snapshot.permissions.every(item => item.canRequest === false));
});

test('accessibility prompt runs only on request and opens its fixed settings pane when still denied', async () => {
  const calls = [];
  const handler = createPermissionsHandler({
    platform: 'darwin',
    systemPreferences: {
      isTrustedAccessibilityClient(prompt) { calls.push(['accessibility', prompt]); return false; },
      getMediaAccessStatus() { return 'not-determined'; },
    },
    shell: { async openExternal(uri) { calls.push(['settings', uri]); } },
    getOwnerWindow: liveWindow,
    getBackend: () => ({ origin: 'http://127.0.0.1:41234', token: 'native-token' }),
    fetchImpl: async (url, options) => {
      calls.push(['policy', url, options.headers['X-Xueness-Desktop-Token']]);
      return { ok: true, status: 200, json: async () => ({ enabled: true }) };
    },
  });
  const result = await handler(message('accessibility'));
  assert.equal(result.id, requestId);
  assert.equal(result.state.permissions[0].status, 'not-determined');
  assert.deepEqual(calls, [
    ['policy', 'http://127.0.0.1:41234/api/desktop/permissions/policy', 'native-token'],
    ['accessibility', true],
    ['policy', 'http://127.0.0.1:41234/api/desktop/permissions/policy', 'native-token'],
    ['settings', SETTINGS_URIS.darwin.accessibility],
    ['accessibility', false],
  ]);
});

test('screen and Full Disk actions open only fixed macOS panes without asking for media access', async () => {
  const calls = [];
  let enabled = true;
  const handler = createPermissionsHandler({
    platform: 'darwin',
    systemPreferences: {
      isTrustedAccessibilityClient() { return true; },
      getMediaAccessStatus(type) { calls.push(['status', type]); return 'not-determined'; },
      askForMediaAccess(type) { calls.push(['ask', type]); throw new Error('screen must use settings'); },
    },
    shell: { async openExternal(uri) { calls.push(['settings', uri]); } },
    getOwnerWindow: liveWindow,
    getBackend: () => ({ origin: 'http://127.0.0.1:41234', token: 'native-token' }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ enabled }) }),
  });
  for (const permission of ['screen', 'fullDisk']) {
    const result = await handler(message(permission));
    assert.equal(result.state.permissions.find(item => item.id === permission).status,
      permission === 'fullDisk' ? 'unknown' : 'not-determined');
  }
  assert.deepEqual(calls.filter(call => call[0] === 'settings'), [
    ['settings', SETTINGS_URIS.darwin.screen], ['settings', SETTINGS_URIS.darwin.fullDisk],
  ]);
  assert.equal(calls.some(call => call[0] === 'ask'), false);
});

test('microphone uses Electron consent API and denied consent opens the fixed pane', async () => {
  const calls = [];
  let microphone = 'not-determined';
  const handler = createPermissionsHandler({
    platform: 'darwin',
    systemPreferences: {
      isTrustedAccessibilityClient() { return true; },
      getMediaAccessStatus(type) { return type === 'microphone' ? microphone : 'granted'; },
      async askForMediaAccess(type) { calls.push(['ask', type]); microphone = 'denied'; return false; },
    },
    shell: { async openExternal(uri) { calls.push(['settings', uri]); } },
    getOwnerWindow: liveWindow,
    getBackend: () => ({ origin: 'http://127.0.0.1:41234', token: 'native-token' }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true }) }),
  });
  const result = await handler(message('microphone'));
  assert.equal(result.state.permissions.find(item => item.id === 'microphone').status, 'denied');
  assert.equal(result.state.permissions.find(item => item.id === 'microphone').requiresRestart, true);
  assert.deepEqual(calls, [
    ['ask', 'microphone'], ['settings', SETTINGS_URIS.darwin.microphone],
  ]);
});

test('fresh disabled policy or a closed owner prevents all permission actions', async () => {
  let apiCalls = 0, nativeCalls = 0;
  const options = {
    platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient() { nativeCalls += 1; return true; } },
    shell: { async openExternal() { nativeCalls += 1; } },
    getOwnerWindow: liveWindow,
    getBackend: () => ({ origin: 'http://127.0.0.1:41234', token: 'native-token' }),
    fetchImpl: async () => { apiCalls += 1; return { ok: false, status: 403 }; },
  };
  const denied = await createPermissionsHandler(options)(message('accessibility'));
  assert.deepEqual(denied, { id: requestId, error: 'disabled' });
  assert.equal(apiCalls, 1);
  assert.equal(nativeCalls, 0);

  const closed = await createPermissionsHandler({ ...options, getOwnerWindow: () => null })(message('accessibility'));
  assert.deepEqual(closed, { id: requestId, error: 'unavailable' });
  assert.equal(apiCalls, 1);
  assert.equal(nativeCalls, 0);
});

test('permission policy accepts only a fresh exact enabled response', async () => {
  let nativeCalls = 0;
  const handler = createPermissionsHandler({
    platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient() { nativeCalls += 1; return true; } },
    getOwnerWindow: liveWindow,
    getBackend: () => ({ origin: 'http://127.0.0.1:41234', token: 'native-token' }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, stale: true }) }),
  });
  assert.deepEqual(await handler(message('accessibility')), { id: requestId, error: 'disabled' });
  assert.equal(nativeCalls, 0);
});

test('owner closing while fresh policy is checked prevents the OS action', async () => {
  let ownerLive = true, nativeCalls = 0;
  const handler = createPermissionsHandler({
    platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient() { nativeCalls += 1; return true; } },
    getOwnerWindow: () => ownerLive ? liveWindow() : null,
    getBackend: () => ({ origin: 'http://127.0.0.1:41234', token: 'native-token' }),
    fetchImpl: async () => {
      ownerLive = false;
      return { ok: true, status: 200, json: async () => ({ enabled: true }) };
    },
  });
  assert.deepEqual(await handler(message('accessibility')), { id: requestId, error: 'unavailable' });
  assert.equal(nativeCalls, 0);
});

test('a delayed microphone denial rechecks plugin and owner before opening settings', async () => {
  let policyChecks = 0, microphone = 'not-determined', settingsCalls = 0;
  const handler = createPermissionsHandler({
    platform: 'darwin',
    systemPreferences: {
      isTrustedAccessibilityClient() { return true; },
      getMediaAccessStatus(type) { return type === 'microphone' ? microphone : 'granted'; },
      async askForMediaAccess() { microphone = 'denied'; return false; },
    },
    shell: { async openExternal() { settingsCalls += 1; } },
    getOwnerWindow: liveWindow,
    getBackend: () => ({ origin: 'http://127.0.0.1:41234', token: 'native-token' }),
    fetchImpl: async () => {
      policyChecks += 1;
      return policyChecks === 1
        ? { ok: true, status: 200, json: async () => ({ enabled: true }) }
        : { ok: false, status: 403 };
    },
  });
  assert.deepEqual(await handler(message('microphone')), { id: requestId, error: 'disabled' });
  assert.equal(policyChecks, 2);
  assert.equal(settingsCalls, 0);
});

test('only one native permission dialog can run at a time', async () => {
  let releasePrompt;
  let promptCalls = 0;
  let microphone = 'not-determined';
  const handler = createPermissionsHandler({
    platform: 'darwin',
    systemPreferences: {
      isTrustedAccessibilityClient() { return true; },
      getMediaAccessStatus(type) { return type === 'microphone' ? microphone : 'granted'; },
      askForMediaAccess() {
        promptCalls += 1;
        return new Promise(resolve => { releasePrompt = () => { microphone = 'granted'; resolve(true); }; });
      },
    },
    getOwnerWindow: liveWindow,
    getBackend: () => ({ origin: 'http://127.0.0.1:41234', token: 'native-token' }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true }) }),
  });
  const first = handler(message('microphone'));
  await new Promise(resolve => setImmediate(resolve));
  const secondMessage = { ...message('accessibility'), id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const second = await handler(secondMessage);
  assert.deepEqual(second, { id: secondMessage.id, error: 'busy' });
  assert.equal(promptCalls, 1);
  releasePrompt();
  const firstResult = await first;
  assert.equal(firstResult.state.permissions.find(item => item.id === 'microphone').status, 'granted');
});

test('settings URI helper rejects unknown permissions before reaching shell', async () => {
  let calls = 0;
  const opened = await openPermissionSettings({ platform: 'darwin', permission: 'camera', shell: {
    async openExternal() { calls += 1; },
  } });
  assert.equal(opened, false);
  assert.equal(calls, 0);
});
