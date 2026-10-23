import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocale, setLocale } from '../../i18n';
import { requestMutation } from '../../xuenessWorkbench';
import { couldHaveBeenAccepted } from './submissionTransport';
import { SessionRequestError } from './sessionRequestErrors';

const previousFetch = globalThis.fetch;
const previousLocale = getLocale();

test.afterEach(() => {
  globalThis.fetch = previousFetch;
  setLocale(previousLocale);
});

function requestFetch(response: Response | (() => never)): void {
  globalThis.fetch = async path => {
    if (String(path) === '/api/csrf') return Response.json({ csrfToken: 'test-token' });
    return typeof response === 'function' ? response() : response;
  };
}

test('non-2xx responses without readable backend detail show actionable localized text and retain status', async () => {
  requestFetch(Response.json({ error_code: 'permission_denied' }, { status: 403 }));
  await assert.rejects(requestMutation('POST', '/api/sessions/s1/messages', { text: 'hello' }), error => {
    assert.ok(error instanceof SessionRequestError);
    assert.match(error.message, /当前操作未获允许/u);
    assert.doesNotMatch(error.message, /HTTP 403/u);
    assert.equal(error.status, 403);
    assert.equal(error.errorCode, 'permission_denied');
    assert.equal((error as SessionRequestError & { error_code?: string }).error_code, 'permission_denied');
    assert.equal(couldHaveBeenAccepted(error), false);
    return true;
  });

  setLocale('en');
  requestFetch(Response.json({}, { status: 502 }));
  await assert.rejects(requestMutation('POST', '/api/sessions/s1/messages', { text: 'hello' }), error => {
    assert.match((error as Error).message, /service could not complete/i);
    assert.equal((error as SessionRequestError).status, 502);
    assert.equal(couldHaveBeenAccepted(error), true);
    return true;
  });
});

test('known backend detail remains visible and known error codes retain the HTTP metadata', async () => {
  const detail = 'This request needs the full-access confirmation.';
  requestFetch(Response.json({ error: detail, error_code: 'yolo_confirmation_required' }, { status: 403 }));
  await assert.rejects(requestMutation('POST', '/api/sessions/s1/messages', { text: 'hello' }), error => {
    assert.ok(error instanceof SessionRequestError);
    assert.match(error.message, /发送前需要确认完全访问/u);
    assert.ok(error.message.includes(detail), 'the server explanation is still presented');
    assert.equal(error.detail, detail);
    assert.equal(error.status, 403);
    assert.equal(error.errorCode, 'yolo_confirmation_required');
    return true;
  });
});

test('network failures are readable but stay uncertain, while a failed CSRF preflight stays known-unsent', async () => {
  const networkFailure = new TypeError('Failed to fetch');
  requestFetch(() => { throw networkFailure; });
  await assert.rejects(requestMutation('POST', '/api/sessions/s1/messages', { text: 'hello' }), error => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /网络连接中断/u);
    assert.doesNotMatch(error.message, /Failed to fetch/u);
    assert.equal(error.cause, networkFailure);
    assert.equal('requestNotSent' in error, false);
    assert.equal(couldHaveBeenAccepted(error), true);
    return true;
  });

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch before mutation'); };
  await assert.rejects(requestMutation('POST', '/api/sessions/s1/messages', { text: 'hello' }), error => {
    assert.equal((error as Error).message.includes('网络连接中断'), true);
    assert.equal((error as Error & { requestNotSent?: boolean }).requestNotSent, true);
    assert.equal(couldHaveBeenAccepted(error), false);
    return true;
  });
});

test('successful responses with unreadable JSON explain the unknown result without changing recovery classification', async () => {
  requestFetch(new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(requestMutation('POST', '/api/sessions/s1/messages', { text: 'hello' }), error => {
    assert.ok(error instanceof SessionRequestError);
    assert.match(error.message, /服务器返回的数据无法读取/u);
    assert.equal(error.status, 200);
    assert.equal(error.responseUnreadable, true);
    assert.equal('requestNotSent' in error, false);
    assert.equal(couldHaveBeenAccepted(error), true);
    return true;
  });
});
