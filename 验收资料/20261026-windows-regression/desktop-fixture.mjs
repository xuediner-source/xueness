import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const { _electron } = createRequire(new URL('../../webapp/package.json', import.meta.url))('playwright');

export async function startDesktopFixture(executablePath, dataDirectory) {
  const data = resolve(dataDirectory);
  const workspace = join(data, 'workspace');
  mkdirSync(join(data, 'state'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'sample.txt'), 'Xueness Windows full-chain fixture 20261026\n');
  if (!existsSync(join(data,'state','plugin-state.json'))) writeFileSync(join(data, 'state', 'plugin-state.json'), JSON.stringify({ apiVersion: 1, enabled: { updates: false } }));
  if (!existsSync(join(data,'state','settings.json'))) writeFileSync(join(data, 'state', 'settings.json'), JSON.stringify({ general: { sessionsAutoTitleEnabled: false } }));
  const modelRequests = [];
  const pending = new Set();
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-e2e', object: 'model', owned_by: 'local-fixture' }] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { res.writeHead(400); return res.end('{}'); }
    const messages = body.messages ?? [];
    const user = [...messages].reverse().find(m => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    const last = messages.at(-1);
    modelRequests.push({ path: req.url, model: body.model, user: text, roles: messages.map(m => m.role), tools: (body.tools ?? []).map(t => t.function?.name) });
    if (text?.includes('E2E_HOLD')) {
      pending.add(res);
      res.on('close', () => pending.delete(res));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '正在等待取消操作。' }, finish_reason: null }] }) + '\n\n');
      return;
    }
    const tool = text?.includes('E2E_WRITE') ? 'write' : text?.includes('E2E_READ') ? 'read' : null;
    if (tool && last?.role !== 'tool') {
      const args = tool === 'read' ? { path: 'sample.txt' } : { path: 'output/e2e.txt', content: 'E2E write approved 20261026\n' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'e2e-' + tool + '-' + modelRequests.length, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    const answer = tool === 'read' ? '已读取 sample.txt：Xueness Windows full-chain fixture 20261026。\nEvidence: E1' : tool === 'write' ? '已创建 output/e2e.txt 并验证内容。\nEvidence: E2' : '本地全链路回复已完成：UI、桌面宿主、后端和会话持久化连接正常。';
    if (!body.stream) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ id: 'local', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const content of answer.match(/.{1,7}/gs) ?? []) {
      if (res.destroyed) return;
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n');
      await new Promise(r => setTimeout(r, 35));
    }
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const app = await _electron.launch({ executablePath: resolve(executablePath), args: ['--force-renderer-accessibility'], env: { ...process.env, XUENESS_DESKTOP_DATA: data, XUENESS_ALLOW_REAL: '1', ELECTRON_RUN_AS_NODE: undefined }, timeout: 45000 });
  const page = await app.firstWindow({ timeout: 45000 });
  const responses = [], errors = [];
  page.on('response', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) responses.push({ method: r.request().method(), path: u.pathname, status: r.status() }); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => errors.push({ requestFailed:new URL(r.url()).pathname, error:r.failure()?.errorText }));
  page.on('console', m => { if(m.type()==='error') errors.push({consoleError:m.text()}); });
  await page.getByTestId('xn-shell').waitFor({ timeout: 45000 });
  const api = (path, body, method) => page.evaluate(async ({ path, body, method }) => {
    const csrf = await (await fetch('/api/csrf')).json();
    const response = await fetch(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { path, body, method });
  let closed=false;
  return { app, page, api, data, workspace, modelRequests, responses, errors, modelBase: `http://127.0.0.1:${server.address().port}/v1`, async close() { if(closed)return; closed=true; await app.close(); for (const res of pending) res.destroy(); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
