'use strict';

const { Readable } = require('node:stream');

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function createElectronAssetRequest(net, options = {}) {
  if (!net || typeof net.request !== 'function') {
    throw new TypeError('Electron net.request is required.');
  }

  const { maxRedirects = 5 } = options;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new TypeError('maxRedirects must be a non-negative integer.');
  }

  return function requestAsset(input, requestOptions = {}) {
    const { headers = {}, signal, isAllowedUrl } = requestOptions;
    if (typeof isAllowedUrl !== 'function') {
      return Promise.reject(new TypeError('An asset URL policy is required.'));
    }

    let initialUrl;
    try {
      initialUrl = input instanceof URL ? new URL(input.href) : new URL(String(input));
    } catch {
      return Promise.reject(new Error('更新资产下载地址无效。'));
    }
    if (isAllowedUrl(initialUrl) !== true) {
      return Promise.reject(new Error('更新资产下载地址不可信。'));
    }
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      let request;
      let responseStream = null;
      let responseResolved = false;
      let responseEnded = false;
      let settled = false;
      let redirectCount = 0;
      let currentUrl = initialUrl;
      let signalListener = null;

      const detachSignal = () => {
        if (signal && signalListener) signal.removeEventListener('abort', signalListener);
        signalListener = null;
      };

      const fail = error => {
        if (settled) return;
        settled = true;
        detachSignal();
        reject(error);
        try { request?.abort(); } catch {}
      };

      const onAbort = () => {
        const error = abortError();
        if (!responseResolved) {
          fail(error);
          return;
        }
        responseStream?.destroy(error);
        try { request?.abort(); } catch {}
      };

      try {
        request = net.request({
          url: initialUrl.href,
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          headers: { 'user-agent': 'Xueness-desktop-updater', ...headers },
        });
      } catch (error) {
        fail(error);
        return;
      }

      signalListener = onAbort;
      signal?.addEventListener('abort', signalListener, { once: true });

      request.on('redirect', (_statusCode, _method, redirectUrl) => {
        if (settled) return;
        let target;
        try {
          target = new URL(redirectUrl, currentUrl);
        } catch {
          fail(new Error('更新资产重定向无效。'));
          return;
        }
        if (redirectCount >= maxRedirects) {
          fail(new Error('更新资产重定向次数过多。'));
          return;
        }
        let allowed = false;
        try { allowed = isAllowedUrl(target) === true; } catch {}
        if (!allowed) {
          fail(new Error('更新资产下载地址不可信。'));
          return;
        }
        redirectCount += 1;
        currentUrl = target;
        try {
          // Electron cancels manual redirects unless this is called in this event turn.
          request.followRedirect();
        } catch (error) {
          fail(error);
        }
      });

      request.on('response', response => {
        if (settled) {
          response.resume?.();
          return;
        }
        responseResolved = true;

        responseStream = new Readable({
          highWaterMark: 64 * 1024,
          read() { response.resume?.(); },
          destroy(error, callback) {
            detachSignal();
            if (!responseEnded) {
              try { request.abort(); } catch {}
            }
            callback(error);
          },
        });
        responseStream.on('close', detachSignal);
        response.once('end', () => {
          responseEnded = true;
          responseStream.push(null);
        });
        response.once('error', error => responseStream.destroy(error));
        response.once('aborted', () => responseStream.destroy(abortError()));
        response.on('data', chunk => {
          if (!responseStream.push(Buffer.from(chunk))) response.pause?.();
        });
        response.pause?.();

        const responseHeaders = new Map();
        for (const [name, rawValues] of Object.entries(response.headers || {})) {
          const values = Array.isArray(rawValues) ? rawValues : [rawValues];
          responseHeaders.set(name.toLowerCase(), values.map(String).join(', '));
        }
        const status = Number(response.statusCode) || 0;
        settled = true;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: { get: name => responseHeaders.get(String(name).toLowerCase()) ?? null },
          body: Readable.toWeb(responseStream),
        });
      });

      request.on('error', error => {
        if (!responseResolved) fail(error);
        else responseStream?.destroy(error);
      });
      request.once('close', () => {
        // Electron can close the writable request side before emitting the response, including
        // while following a redirect. The response stream is the reliable completion boundary.
        if (responseResolved && !responseEnded && !responseStream?.destroyed) {
          responseStream?.destroy(new Error('Electron updater response closed before it ended.'));
        }
      });
      request.end();
    });
  };
}

module.exports = { createElectronAssetRequest };
