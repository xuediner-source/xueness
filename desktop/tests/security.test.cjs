const test = require('node:test');
const assert = require('node:assert/strict');
const { isOwnedUrl, isExternalUrl, readyOrigin } = require('../src/security.cjs');

test('only the authenticated backend origin can navigate inside the window', () => {
  const origin = 'http://127.0.0.1:43210';
  assert.equal(isOwnedUrl(origin+'/api/plugins', origin), true);
  for (const value of ['http://127.0.0.1:43211/', 'http://127.0.0.1.evil.test:43210/',
    'http://user@127.0.0.1:43210/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a URL']) {
    assert.equal(isOwnedUrl(value, origin), false, value);
  }
});
test('external opening rejects executable schemes and embedded credentials', () => {
  assert.equal(isExternalUrl('https://github.com/xuediner-source/xueness'), true);
  for (const value of ['file:///C:/Windows', 'shell:AppsFolder', 'javascript:alert(1)',
    'https://secret@example.com/', 'data:text/html,test']) assert.equal(isExternalUrl(value), false);
});
test('backend readiness cannot name a remote host, credentials or arbitrary route', () => {
  assert.equal(readyOrigin('http://127.0.0.1:4567'), 'http://127.0.0.1:4567');
  for (const value of ['https://example.com/', 'http://localhost:4567/', 'http://127.0.0.1/',
    'http://127.0.0.1:4567/path', 'http://127.0.0.1:4567/?token=secret']) assert.throws(() => readyOrigin(value));
});
