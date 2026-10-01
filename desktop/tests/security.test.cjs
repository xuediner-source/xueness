const test = require('node:test');
const assert = require('node:assert/strict');
const { isOwnedUrl, isExternalUrl, readyOrigin, installPermissionPolicy } = require('../src/security.cjs');

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

test('permission policy grants only clipboard writes from the owning backend main frame', () => {
  const origin = 'http://127.0.0.1:4567';
  const owner = {};
  const other = {};
  let requestHandler;
  let checkHandler;
  installPermissionPolicy({
    setPermissionRequestHandler(handler) { requestHandler = handler; },
    setPermissionCheckHandler(handler) { checkHandler = handler; },
  }, owner, origin);

  const request = (contents, permission, requestingUrl, isMainFrame = true) => {
    let result;
    requestHandler(contents, permission, value => { result = value; }, { requestingUrl, isMainFrame });
    return result;
  };
  const check = (contents, permission, requestingOrigin, requestingUrl = requestingOrigin, isMainFrame = true) =>
    checkHandler(contents, permission, requestingOrigin, { requestingUrl, isMainFrame });

  assert.equal(request(owner, 'clipboard-sanitized-write', origin + '/'), true);
  assert.equal(check(owner, 'clipboard-sanitized-write', origin), true);
  assert.equal(request(owner, 'clipboard-read', origin + '/'), false);
  assert.equal(check(owner, 'notifications', origin), false);
  assert.equal(request(owner, 'clipboard-sanitized-write', 'https://example.com/'), false);
  assert.equal(check(owner, 'clipboard-sanitized-write', origin, 'http://127.0.0.1:4568/'), false);
  assert.equal(request(owner, 'clipboard-sanitized-write', origin + '/embedded', false), false);
  assert.equal(check(other, 'clipboard-sanitized-write', origin), false);
});
