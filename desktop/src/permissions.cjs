const PERMISSIONS = Object.freeze(['accessibility', 'screen', 'fullDisk', 'microphone']);
const PERMISSION_SET = new Set(PERMISSIONS);
const MEDIA_STATUSES = new Set(['granted', 'not-determined', 'denied', 'restricted', 'unknown']);

const SETTINGS_URIS = Object.freeze({
  darwin: Object.freeze({
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  }),
  win32: Object.freeze({
    microphone: 'ms-settings:privacy-microphone',
  }),
});

function isPermissionsRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
      || message.type !== 'permissions' || typeof message.id !== 'string'
      || !/^[a-f0-9]{32}$/.test(message.id)) return false;
  if (message.action === 'status') {
    return Object.keys(message).length === 3
      && Object.hasOwn(message, 'type') && Object.hasOwn(message, 'id') && Object.hasOwn(message, 'action');
  }
  return message.action === 'request'
    && Object.keys(message).length === 4
    && Object.hasOwn(message, 'type') && Object.hasOwn(message, 'id')
    && Object.hasOwn(message, 'action') && Object.hasOwn(message, 'permission')
    && PERMISSION_SET.has(message.permission);
}

function mediaStatus(systemPreferences, mediaType) {
  try {
    const status = systemPreferences?.getMediaAccessStatus?.(mediaType);
    return MEDIA_STATUSES.has(status) ? status : 'unknown';
  } catch {
    return 'unknown';
  }
}

function canRequest(status) {
  return status === 'not-determined' || status === 'denied' || status === 'unknown';
}

function row(id, status, canRequestValue = canRequest(status), requiresRestart) {
  return {
    id,
    status,
    canRequest: canRequestValue,
    ...(requiresRestart === undefined ? {} : { requiresRestart }),
  };
}

function mediaPermissionRow(platform, id, status) {
  // Electron's macOS screen-capture status can stay stale after System Settings
  // changes, and Electron documents that microphone access changed after denial
  // takes effect after relaunch. This is only advisory: keep the native status
  // untouched and remove the hint as soon as the API reports granted.
  const requiresRestart = platform === 'darwin'
    && ((id === 'screen' && (status === 'denied' || status === 'not-determined'))
      || (id === 'microphone' && status === 'denied'));
  return row(id, status, undefined, requiresRestart ? true : undefined);
}

function unsupportedSnapshot(platform) {
  return { platform, permissions: PERMISSIONS.map(id => row(id, 'unsupported', false)) };
}

function getPermissionSnapshot({ platform = process.platform, systemPreferences } = {}) {
  if (platform === 'darwin') {
    let accessibility = 'unknown';
    try {
      const trusted = systemPreferences?.isTrustedAccessibilityClient?.(false);
      if (typeof trusted === 'boolean') accessibility = trusted ? 'granted' : 'not-determined';
    } catch { /* The API does not expose a more precise status. */ }
    return {
      platform,
      permissions: [
        row('accessibility', accessibility),
        mediaPermissionRow(platform, 'screen', mediaStatus(systemPreferences, 'screen')),
        // Electron has no API for Full Disk Access. Never infer it from files.
        row('fullDisk', 'unknown', true),
        mediaPermissionRow(platform, 'microphone', mediaStatus(systemPreferences, 'microphone')),
      ],
    };
  }
  if (platform === 'win32') {
    // Electron can report Windows microphone privacy status. Its screen status
    // may be hard-coded to granted on older Windows versions, so report screen
    // capture consent as unsupported instead of implying a user grant.
    return {
      platform,
      permissions: [
        row('accessibility', 'unsupported', false),
        row('screen', 'unsupported', false),
        row('fullDisk', 'unsupported', false),
        row('microphone', mediaStatus(systemPreferences, 'microphone')),
      ],
    };
  }
  return unsupportedSnapshot(platform);
}

function ownerWindowIsLive(window) {
  try {
    return Boolean(window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed());
  } catch {
    return false;
  }
}

async function openPermissionSettings({ platform, permission, shell }) {
  const uri = SETTINGS_URIS[platform]?.[permission];
  if (!uri || typeof shell?.openExternal !== 'function') return false;
  await shell.openExternal(uri);
  return true;
}

async function freshDesktopPolicy({ backend, fetchImpl, timeoutMs }) {
  if (!backend?.origin || !backend?.token || typeof fetchImpl !== 'function') return 'unavailable';
  try {
    const response = await fetchImpl(`${backend.origin}/api/desktop/permissions/policy`, {
      headers: { 'X-Xueness-Desktop-Token': backend.token },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 403) return 'disabled';
    if (!response.ok) return 'unavailable';
    const policy = await response.json();
    return policy && typeof policy === 'object' && !Array.isArray(policy)
      && Object.keys(policy).length === 1 && Object.hasOwn(policy, 'enabled')
      && policy.enabled === true ? 'enabled' : 'disabled';
  } catch {
    return 'unavailable';
  }
}

async function performPermissionRequest({ platform, permission, systemPreferences, shell, recheckAction }) {
  if (platform === 'darwin') {
    if (permission === 'accessibility') {
      if (typeof systemPreferences?.isTrustedAccessibilityClient === 'function') {
        const trusted = systemPreferences.isTrustedAccessibilityClient(true);
        if (trusted === false) {
          const policy = await recheckAction();
          if (policy !== 'enabled') {
            const error = new Error(policy);
            error.code = policy;
            throw error;
          }
          await openPermissionSettings({ platform, permission, shell });
        }
      }
    } else if (permission === 'screen' || permission === 'fullDisk') {
      await openPermissionSettings({ platform, permission, shell });
    } else if (permission === 'microphone') {
      const before = mediaStatus(systemPreferences, 'microphone');
      if (before !== 'granted' && before !== 'restricted') {
        if (typeof systemPreferences?.askForMediaAccess !== 'function') throw new Error('microphone permission API unavailable');
        let granted;
        let promptError;
        try { granted = await systemPreferences.askForMediaAccess('microphone'); }
        catch (error) { promptError = error; }
        const after = mediaStatus(systemPreferences, 'microphone');
        if (granted === false || after === 'denied' || (promptError && after === 'denied')) {
          const policy = await recheckAction();
          if (policy !== 'enabled') {
            const error = new Error(policy);
            error.code = policy;
            throw error;
          }
          await openPermissionSettings({ platform, permission, shell });
        }
        if (promptError && after !== 'denied') throw promptError;
      }
    }
    return getPermissionSnapshot({ platform, systemPreferences });
  }
  if (platform === 'win32' && permission === 'microphone') {
    await openPermissionSettings({ platform, permission, shell });
    return getPermissionSnapshot({ platform, systemPreferences });
  }
  return getPermissionSnapshot({ platform, systemPreferences });
}

function createPermissionsHandler({
  platform = process.platform,
  systemPreferences,
  shell,
  getOwnerWindow = () => null,
  getBackend = () => null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  let permissionActionPending = false;
  return async function handlePermissionsRequest(message) {
    if (!isPermissionsRequest(message)) return null;
    try {
      if (message.action === 'status') {
        return { id: message.id, state: getPermissionSnapshot({ platform, systemPreferences }) };
      }
      let owner;
      try { owner = getOwnerWindow(); } catch { owner = null; }
      if (!ownerWindowIsLive(owner)) return { id: message.id, error: 'unavailable' };
      const policy = await freshDesktopPolicy({ backend: getBackend(), fetchImpl, timeoutMs });
      if (policy !== 'enabled') return { id: message.id, error: policy };
      try { owner = getOwnerWindow(); } catch { owner = null; }
      if (!ownerWindowIsLive(owner)) return { id: message.id, error: 'unavailable' };
      if (permissionActionPending) return { id: message.id, error: 'busy' };
      permissionActionPending = true;
      const recheckAction = async () => {
        const currentPolicy = await freshDesktopPolicy({ backend: getBackend(), fetchImpl, timeoutMs });
        if (currentPolicy !== 'enabled') return currentPolicy;
        try { owner = getOwnerWindow(); } catch { owner = null; }
        return ownerWindowIsLive(owner) ? 'enabled' : 'unavailable';
      };
      try {
        const state = await performPermissionRequest({ platform, permission: message.permission,
          systemPreferences, shell, recheckAction });
        return { id: message.id, state };
      } finally {
        permissionActionPending = false;
      }
    } catch (error) {
      return { id: message.id, error: error?.code === 'disabled' ? 'disabled' : 'unavailable' };
    }
  };
}

module.exports = {
  PERMISSIONS,
  SETTINGS_URIS,
  isPermissionsRequest,
  getPermissionSnapshot,
  openPermissionSettings,
  freshDesktopPolicy,
  createPermissionsHandler,
};
