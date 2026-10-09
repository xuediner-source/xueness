'use strict';

const { readFileSync, statSync } = require('node:fs');
const { join, resolve, isAbsolute } = require('node:path');

// The installer's shortcut may be regenerated during an update. Keep the
// operator's explicit data location in a user-owned launcher preference instead
// of depending on the shortcut's command line or its working directory.
function configuredDataDirectory({ env = process.env, platform = process.platform, appData }) {
  if (typeof env.XUENESS_DESKTOP_DATA === 'string' && env.XUENESS_DESKTOP_DATA) {
    return resolve(env.XUENESS_DESKTOP_DATA);
  }
  if (!['win32', 'darwin'].includes(platform) || typeof appData !== 'string') return null;
  try {
    const file = join(appData, 'Xueness', 'desktop-data-directory.json');
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 4096) return null;
    const value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || value.apiVersion !== 1 || typeof value.dataDirectory !== 'string'
        || value.dataDirectory.length > 2048 || !isAbsolute(value.dataDirectory)
        || value.dataDirectory.includes('\0')) return null;
    return resolve(value.dataDirectory);
  } catch { return null; }
}

module.exports = { configuredDataDirectory };
