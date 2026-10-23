'use strict';

const { openSync, closeSync, fsyncSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { dirname, join } = require('node:path');

const FILE_VERSION = 1;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_KEY_LENGTH = 4096;
const DRAFT_PREFIX = 'xueness:composer-drafts:v1:';
const HISTORY_PREFIX = 'xueness:chat-prompt-history:';
const EXACT_KEYS = new Set([
  'xueness.sessions.pane-layout.v2',
  'xueness.sessions.pane-layout.v1',
  'xueness.sidebar-widths.v1',
  'xueness.sidebar-collapsed.v1',
]);

function encodedSuffix(key, prefix) {
  const suffix = key.slice(prefix.length);
  if (!suffix || suffix.length > 2048) return false;
  try { return encodeURIComponent(decodeURIComponent(suffix)) === suffix; }
  catch { return false; }
}

function valueLimit(key) {
  if (key.startsWith(DRAFT_PREFIX)) return 4 * 1024 * 1024;
  if (key.startsWith(HISTORY_PREFIX)) return 1024 * 1024;
  if (key === 'xueness.sessions.pane-layout.v1' || key === 'xueness.sessions.pane-layout.v2') return 128 * 1024;
  return 4096;
}

function assertAllowedKey(key) {
  if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH
      || !(EXACT_KEYS.has(key) || key.startsWith(DRAFT_PREFIX) && encodedSuffix(key, DRAFT_PREFIX)
        || key.startsWith(HISTORY_PREFIX) && encodedSuffix(key, HISTORY_PREFIX))) {
    throw new TypeError('Unsupported desktop storage key');
  }
}

function containsAttachmentPayload(value) {
  if (Array.isArray(value)) return value.some(containsAttachmentPayload);
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (/^(attachments?|attachmentdata|dataurl|base64|contentbase64|bytes)$/i.test(key)
        || containsAttachmentPayload(child)) return true;
  }
  return false;
}

function assertValue(key, value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > valueLimit(key)) {
    throw new RangeError('Desktop storage value exceeds its limit');
  }
  if (key.startsWith(DRAFT_PREFIX)) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new TypeError('Invalid composer draft record'); }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1
        || !parsed.scopes || typeof parsed.scopes !== 'object' || Array.isArray(parsed.scopes)
        || containsAttachmentPayload(parsed)) throw new TypeError('Invalid composer draft record');
  } else if (key.startsWith(HISTORY_PREFIX)) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new TypeError('Invalid prompt history record'); }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      throw new TypeError('Invalid prompt history record');
    }
  }
}

function createDesktopStateStore(filePath) {
  let entries = Object.create(null);
  let writable = true;

  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid desktop state file');
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || parsed.version !== FILE_VERSION || !parsed.entries
        || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new Error('Invalid desktop state file');
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (typeof value !== 'string') throw new Error('Invalid desktop state entry');
      if (key.startsWith(DRAFT_PREFIX) || key.startsWith(HISTORY_PREFIX) || EXACT_KEYS.has(key)) {
        assertAllowedKey(key);
        assertValue(key, value);
      }
      entries[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') writable = false;
  }

  function save(nextEntries) {
    if (!writable) throw new Error('Desktop storage is unavailable');
    const raw = JSON.stringify({ version: FILE_VERSION, entries: nextEntries });
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) throw new RangeError('Desktop storage is full');
    const temporary = join(dirname(filePath), `.desktop-state-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, raw, 'utf8');
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, filePath);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  return {
    getItem(key) {
      try { assertAllowedKey(key); } catch { return null; }
      return Object.hasOwn(entries, key) ? entries[key] : null;
    },
    setItem(key, value) {
      assertAllowedKey(key);
      assertValue(key, value);
      if (Object.hasOwn(entries, key) && entries[key] === value) return;
      const next = Object.assign(Object.create(null), entries, { [key]: value });
      save(next);
      entries = next;
    },
    removeItem(key) {
      assertAllowedKey(key);
      if (!writable) throw new Error('Desktop storage is unavailable');
      if (!Object.hasOwn(entries, key)) return;
      const next = Object.assign(Object.create(null), entries);
      delete next[key];
      save(next);
      entries = next;
    },
  };
}

module.exports = { createDesktopStateStore };
