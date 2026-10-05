'use strict';

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { writeFile } = require('node:fs/promises');
const { app, net } = require('electron');
const { createElectronAssetRequest } = require('../src/electron-net-asset.cjs');

const resultFile = process.env.XUENESS_ELECTRON_FIXTURE_RESULT;
if (!resultFile) throw new Error('Missing isolated Electron fixture result path.');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function address(port, path) {
  return 'http://127.0.0.1:' + port + path;
}

async function runFixture() {
  let trustedHits = 0;
  let deniedHits = 0;
  let payloadFinished = false;
  let slowClosed = false;
  let resolveSlowClosed;
  const slowClosedPromise = new Promise(resolve => { resolveSlowClosed = resolve; });
  const payload = Buffer.alloc(256 * 1024, 0x5a);
  const trustedServer = createServer((request, response) => {
    if (request.url === '/payload') {
      trustedHits += 1;
      response.writeHead(200, {
        'content-length': String(payload.length),
        'cache-control': 'no-store',
      });
      void (async () => {
        for (let offset = 0; offset < payload.length; offset += 16 * 1024) {
          if (response.destroyed) return;
          if (!response.write(payload.subarray(offset, offset + 16 * 1024))) {
            await new Promise(resolve => response.once('drain', resolve));
          }
          await delay(4);
        }
        if (!response.destroyed) response.end();
        payloadFinished = true;
      })().catch(() => response.destroy());
      return;
    }
    if (request.url === '/slow') {
      trustedHits += 1;
      response.writeHead(200, { 'cache-control': 'no-store' });
      const timer = setInterval(() => {
        if (!response.write(Buffer.alloc(8 * 1024, 0x73))) response.once('drain', () => {});
      }, 5);
      response.on('close', () => {
        clearInterval(timer);
        slowClosed = true;
        resolveSlowClosed();
      });
      return;
    }
    response.writeHead(404).end();
  });

  let trustedPort;
  const redirectServer = createServer((request, response) => {
    const target = request.url === '/trusted'
      ? address(trustedPort, '/payload')
      : address(deniedPort, '/never-contact');
    response.writeHead(302, { location: target, 'cache-control': 'no-store' }).end();
  });
  const deniedServer = createServer((_request, response) => {
    deniedHits += 1;
    response.writeHead(200).end('unexpected target contact');
  });

  let redirectPort;
  let deniedPort;
  try {
    [trustedPort, redirectPort, deniedPort] = await Promise.all([
      listen(trustedServer), listen(redirectServer), listen(deniedServer),
    ]);

    // The loopback HTTP exception exists only in this isolated test fixture.
    const fixtureHosts = new Set([String(trustedPort), String(redirectPort)]);
    const isFixtureUrlAllowed = url => url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && fixtureHosts.has(url.port)
      && !url.username && !url.password;
    const requestAsset = createElectronAssetRequest(net);
    const requestOptions = { isAllowedUrl: isFixtureUrlAllowed, maxRedirects: 5 };

    const trustedResponse = await requestAsset(address(redirectPort, '/trusted'), requestOptions);
    assert.equal(trustedResponse.status, 200);
    const reader = trustedResponse.body.getReader();
    const chunks = [];
    const first = await reader.read();
    assert.equal(first.done, false);
    chunks.push(Buffer.from(first.value));
    const streamedBeforeComplete = !payloadFinished;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    assert.equal(Buffer.concat(chunks).length, payload.length);
    assert.equal(Buffer.concat(chunks).equals(payload), true);

    const abortController = new AbortController();
    const slowResponse = await requestAsset(address(trustedPort, '/slow'), {
      ...requestOptions,
      signal: abortController.signal,
    });
    const slowReader = slowResponse.body.getReader();
    const firstSlowChunk = await slowReader.read();
    assert.equal(firstSlowChunk.done, false);
    abortController.abort();
    let abortErrorObserved = false;
    try { await slowReader.read(); }
    catch (error) { abortErrorObserved = error.name === 'AbortError'; }
    await Promise.race([slowClosedPromise, delay(3000).then(() => { throw new Error('aborted response remained open'); })]);

    let deniedError = null;
    try { await requestAsset(address(redirectPort, '/untrusted'), requestOptions); }
    catch (error) { deniedError = error; }
    await delay(100);
    assert.match(deniedError?.message || '', /不可信/);
    assert.equal(deniedHits, 0, 'redirect target must not receive a request before policy validation');

    return {
      trustedHits,
      deniedHits,
      streamedBytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      streamedBeforeComplete,
      abortErrorObserved,
      slowClosed,
    };
  } finally {
    await Promise.all([close(trustedServer), close(redirectServer), close(deniedServer)]);
  }
}

app.whenReady().then(async () => {
  try {
    const result = await runFixture();
    await writeFile(resultFile, JSON.stringify({ result }));
    app.exit(0);
  } catch (error) {
    console.error(error?.stack || error);
    await writeFile(resultFile, JSON.stringify({ error: error?.stack || String(error) }));
    app.exit(1);
  }
});
