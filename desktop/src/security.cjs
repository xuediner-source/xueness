const { URL } = require('node:url');

function isOwnedUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}
function isExternalUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
function readyOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid backend address');
  return url.origin;
}

function canWriteClipboard({ webContents, ownerContents, permission, origin, requestingUrl, isMainFrame }) {
  return webContents === ownerContents && permission === 'clipboard-sanitized-write'
    && isMainFrame === true && isOwnedUrl(requestingUrl, origin);
}

function installPermissionPolicy(session, ownerContents, origin) {
  session.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    callback(canWriteClipboard({ webContents, ownerContents, permission, origin,
      requestingUrl: details?.requestingUrl, isMainFrame: details?.isMainFrame }));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
    return canWriteClipboard({ webContents, ownerContents, permission, origin,
      requestingUrl: details?.requestingUrl || requestingOrigin, isMainFrame: details?.isMainFrame });
  });
}

module.exports = { isOwnedUrl, isExternalUrl, readyOrigin, canWriteClipboard, installPermissionPolicy };
