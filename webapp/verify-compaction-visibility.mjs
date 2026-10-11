// 真实构建产物 + 真实后端压缩路径的截图验收：
// 隔离状态目录里造一条长会话，调用与运行时相同的 core.compact 产生真实
// compactions 记录与归档消息，再对统一会话时间线截图，确认压缩边界标记。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const outputDir = process.argv[2] || 'E:/models/apps/xueness-optimization-20261012/screenshots';
await mkdir(outputDir, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'xn-compaction-visibility-'));
const source = String.raw`
import json, sys, threading
from pathlib import Path
from xueness import core, web
base, dist = map(Path, sys.argv[1:])
state = base / 'state'; state.mkdir(parents=True, exist_ok=True)
workspace = base / 'workspace'; workspace.mkdir(parents=True, exist_ok=True)
(state / 'plugin-state.json').write_text(json.dumps({'apiVersion': 1, 'enabled': {'updates': False, 'onboarding': False, 'diagnostics': False}}))
ctx = web.build_context(state, base / 'runs', workspace, allow_real=False)
ctx['webapp_dir'] = dist
store = ctx['store']
s = store.new('审计整个仓库并输出压缩可见性报告。', workspace)
s['title'] = '压缩可见性验收会话'
s['status'] = 'completed'
s['messages'] = [{'role': 'system', 'content': 'You are a coding agent.'},
                 {'role': 'user', 'content': '审计整个仓库并输出压缩可见性报告。'}]
# 六轮带大体积工具输出的工作：足以触发确定性的掩码 + 丢弃压缩。
for turn in range(6):
    s['messages'] += [
        {'role': 'assistant', 'content': '第 %d 轮：检查工作区文件与日志。' % turn,
         'tool_calls': [{'id': 'call-%d' % turn, 'type': 'function',
                         'function': {'name': 'exec', 'arguments': json.dumps({'command': 'git log --oneline -50'})}}]},
        {'role': 'tool', 'tool_call_id': 'call-%d' % turn, 'content': ('commit %02d: refactor timeline modules\n' % turn) * 320},
        {'role': 'user', 'content': '继续第 %d 轮检查。' % (turn + 1)},
    ]
s['messages'].append({'role': 'assistant', 'content': '六轮检查完成：时间线、归档与掩码策略均符合预期。'})
store.save(s)
# 与后端运行时完全相同的压缩入口（掩码旧输出 -> 丢弃整段交换 -> 摘要）。
reloaded = store.load(s['id'])
core.compact(reloaded, max_chars=8000)
assert reloaded.get('compactions'), 'fixture compaction did not run'
store.save(reloaded)
final = store.load(s['id'])
assert final.get('compactions') and final.get('archived_messages'), 'compaction records missing after save'
server = web.create_server(0, ctx)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(json.dumps({'port': server.server_address[1], 'id': final['id'],
                  'compactions': final['compactions']}), flush=True)
threading.Event().wait(300)
server.shutdown(); server.server_close()
`;
const script = join(temp, 'server.py'); await writeFile(script, source);
const child = spawn(process.env.PYTHON || 'python3', [script, temp, join(root, 'webapp/dist')], { cwd: root,
  env: { ...process.env, PYTHONPATH: root, XUENESS_API_KEY: '', XUENESS_MODEL: '', XUENESS_MARKETPLACE_URL: '', XUENESS_WORKSPACE_ROOTS: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
const errors = [], external = [];
let browser;
try {
  const ready = await new Promise((accept, reject) => {
    let out = '', err = '';
    child.stderr.on('data', d => err += d);
    child.stdout.on('data', d => { out += d; if (out.includes('\n')) accept(JSON.parse(out.split('\n')[0])); });
    child.once('exit', code => reject(new Error(`fixture ${code}: ${err}`)));
    setTimeout(() => reject(new Error(err || 'fixture timeout')), 20000).unref();
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  const removed = ready.compactions.reduce((total, record) => total + (record.removed || 0), 0);
  const masked = ready.compactions.reduce((total, record) => total + (record.masked || 0), 0);
  assert.ok(removed > 0 && masked > 0, `expected removal and masking, got ${JSON.stringify(ready.compactions)}`);
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    await context.addInitScript(theme => {
      localStorage.setItem('xueness.theme', theme);
      localStorage.setItem('xueness.language', 'zh');
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      await route.continue();
    });
    await page.goto(origin);
    const item = page.getByTestId(`xn-sidebar-item-${ready.id}`);
    await item.waitFor({ state: 'attached' });
    if (!await item.isVisible()) await page.getByTestId('xn-shell-sidebar-toggle').click();
    await item.click();
    // 标记必须真实渲染：后端记录的 removed/masked 计数出现在时间线分隔行里。
    const boundary = page.getByTestId('timeline-compaction-boundary');
    await boundary.waitFor();
    const label = await boundary.locator('.xn-zc-compaction__label').innerText();
    assert.match(label, new RegExp(`已压缩 ${removed} 条较早消息`), `unexpected label: ${label}`);
    if (masked > 0) assert.match(label, new RegExp(`另有 ${masked} 条旧输出已掩码`), `unexpected label: ${label}`);
    assert.equal(await boundary.getAttribute('role'), 'note');
    assert.match(await boundary.getAttribute('aria-label'), /原文保留在会话日志/);
    // 位置：归档块（最后一轮被压缩的回复）在分隔行之上，恢复后的第一轮在分隔行之下。
    const order = await page.evaluate(() => {
      const texts = ['第 4 轮：检查工作区文件与日志。', '继续第 5 轮检查。', 'timeline-compaction-boundary', '继续第 6 轮检查。'];
      return texts.map(text => {
        const node = text === 'timeline-compaction-boundary'
          ? document.querySelector('[data-testid="timeline-compaction-boundary"]')
          : [...document.querySelectorAll('.xn-zcode-conversation p, .xn-zcode-conversation .xn-zc-user-bubble')]
            .find(el => el.textContent.includes(text));
        return node ? node.getBoundingClientRect().top : null;
      });
    });
    assert.deepEqual(order.map(value => value !== null), [true, true, true, true], `missing timeline content: ${JSON.stringify(order)}`);
    assert.ok(order[0] < order[2] && order[2] < order[3], `boundary must sit between archived history and live turns: ${JSON.stringify(order)}`);
    // 时间线默认跟随到底部；把分隔行滚入视口，让截图真实呈现标记及其上下文。
    await boundary.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const inView = await boundary.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    assert.ok(inView, 'boundary marker must be inside the viewport for the screenshot');
    await page.screenshot({ path: join(outputDir, theme === 'light' ? 'compaction-timeline.png' : 'compaction-timeline-dark.png'), fullPage: false });
    await context.close();
  }
  assert.deepEqual(external, [], `blocked external requests: ${external.join(', ')}`);
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`PASS compaction-timeline.png / compaction-timeline-dark.png -> ${outputDir}`);
} finally {
  child.kill();
  await browser?.close().catch(() => {});
}
