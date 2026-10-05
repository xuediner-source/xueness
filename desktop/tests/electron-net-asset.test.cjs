'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createElectronAssetRequest } = require('../src/electron-net-asset.cjs');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = { 'content-length': ['3'] };
    this.readableEnded = false;
    this.paused = true;
    this.sent = false;
  }

  pause() { this.paused = true; }

  resume() {
    this.paused = false;
    if (this.sent) return;
    this.sent = true;
    setImmediate(() => {
      if (this.paused) return;
      this.emit('data', Buffer.from('abc'));
      this.readableEnded = true;
      this.emit('end');
    });
  }
}

class FakeRequest extends EventEmitter {
  constructor(url, redirectUrl) {
    super();
    this.url = url;
    this.redirectUrl = redirectUrl;
    this.aborted = false;
    this.followed = false;
    this.inRedirectEvent = false;
  }

  end() {
    setImmediate(() => {
      this.inRedirectEvent = true;
      this.emit('redirect', 302, 'GET', this.redirectUrl);
      this.inRedirectEvent = false;
    });
  }

  followRedirect() {
    assert.equal(this.inRedirectEvent, true, 'manual redirect must be followed synchronously in its event');
    this.followed = true;
    setImmediate(() => this.emit('response', new FakeResponse()));
  }

  abort() { this.aborted = true; }
}

function makeNet(redirectUrl = 'http://trusted.test:8080/payload') {
  let request;
  return {
    net: { request(options) { request = new FakeRequest(options.url, redirectUrl); return request; } },
    get request() { return request; },
  };
}

test('Electron asset transport validates before synchronous followRedirect and streams the response', async () => {
  const fake = makeNet();
  const requestAsset = createElectronAssetRequest(fake.net);
  const trusted = url => url.protocol === 'http:' && url.hostname === 'trusted.test' && url.port === '8080';
  const response = await requestAsset('http://trusted.test:8080/start', { isAllowedUrl: trusted });

  assert.equal(fake.request.followed, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '3');
  const chunks = [];
  for await (const chunk of Readable.fromWeb(response.body)) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'abc');
});

test('Electron asset transport aborts an active request when its signal is cancelled', async () => {
  const fake = makeNet();
  const requestAsset = createElectronAssetRequest(fake.net);
  const controller = new AbortController();
  const trusted = url => url.protocol === 'http:' && url.hostname === 'trusted.test';
  const pending = requestAsset('http://trusted.test/start', { isAllowedUrl: trusted, signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(fake.request.aborted, true);
  assert.equal(fake.request.followed, false);
});

test('Electron asset transport rejects disallowed and excessive redirects without following them', async t => {
  const fake = makeNet();
  const requestAsset = createElectronAssetRequest(fake.net, { maxRedirects: 0 });
  const trusted = url => url.protocol === 'http:' && url.hostname === 'trusted.test';
  const pending = requestAsset('http://trusted.test/start', { isAllowedUrl: trusted });
  await assert.rejects(pending, /重定向次数过多/);
  assert.equal(fake.request.followed, false);
  assert.equal(fake.request.aborted, true);

  const disallowed = makeNet('http://evil.test:8080/payload');
  const strictRequest = createElectronAssetRequest(disallowed.net);
  await assert.rejects(
    strictRequest('http://trusted.test/start', {
      isAllowedUrl: url => url.hostname === 'trusted.test' && url.port === '',
    }),
    /不可信/,
  );
  assert.equal(disallowed.request.followed, false);
  assert.equal(disallowed.request.aborted, true);
});
