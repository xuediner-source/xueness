// 审批面板鼠标交互 e2e（reviews/parity-rereview.md「诚实的空白」补强）：
// 真实构建产物 + 隔离状态目录 + 注入式 provider，直接向后端 journal 注入
// "denied + approval_required" 的工具调用（与 tests/test_web.py 审批流同一
// journal 契约），然后用 Playwright 真实鼠标/键盘事件驱动审批面板：
//   1. 展开/收起 diff 预览（edit 类 pending 自带的折叠预览）；
//   2. 批准并重试（批准后 replay_approved 用 journal 参数重放该调用，
//      工具真实执行，工作区文件内容改变，面板清除）；
//   3. 拒绝路径：本产品审批面板没有独立"拒绝"按钮（deny-by-default 门下，
//      不批准即拒绝——被拒调用已把该轮终止，pending 挂起等待显式批准），
//      因此验证"轮次已终止 + 面板仍挂起 + 点击选中待审批项"，并如实标注；
//   4. 键盘可达性冒烟：焦点进入审批面板后 Tab 到批准按钮、Enter 触发；
//   5. 子代理单任务取消（T2 佐证）：实验开关开启时，运行中的子任务行有
//      独立"取消此项"按钮，点击（确认框接受）后命中 cancel_one 端点，
//      该行状态变为已取消，其他子任务不受影响。
// 全程截图存输出目录，末尾打印 PASS/FAIL 摘要，失败以非零码退出。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const outputDir = process.argv[2] || 'E:/models/apps/xueness-optimization-20261012/screenshots';
await mkdir(outputDir, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'xn-approval-interactions-'));
const EDIT_CALL_ID = 'fixture-edit';
const WRITE_CALL_ID = 'fixture-write-approve';
const EXEC_CALL_ID = 'fixture-exec';
const OLD_TEXT = ['exports.report = () => ({', '  module: "audit",', '  version: 1,', '  checks: [],', '  verdict: "unknown",', '});', ''].join('\n');
const NEW_TEXT = ['exports.report = () => ({', '  module: "audit",', '  version: 2,', '  checks: ["gate", "journal"],', '  verdict: "verified",', '});', ''].join('\n');

// 整段 Python 源码是单个 raw 模板；JS 侧数据（call id、文件文本）通过
// argv[3] 的 JSON 传入，避免插值拆散模板后转义序列被二次处理。
const source = String.raw`
import json, sys, threading
from pathlib import Path
from unittest.mock import patch
from xueness import web
from xueness.bundled_plugins.providers.provider import FakeProvider

base, dist, config_path = map(Path, sys.argv[1:4])
config = json.loads(config_path.read_text(encoding="utf-8"))
EDIT_CALL_ID = config["editCallId"]
WRITE_CALL_ID = config["writeCallId"]
EXEC_CALL_ID = config["execCallId"]
OLD_TEXT = config["oldText"]
NEW_TEXT = config["newText"]

state = base / 'state'; state.mkdir(parents=True, exist_ok=True)
workspace = base / 'workspace'; workspace.mkdir(parents=True, exist_ok=True)
(state / 'plugin-state.json').write_text(json.dumps({'apiVersion': 1, 'enabled': {'updates': False, 'onboarding': False, 'diagnostics': False}}))
# 与后端实验开关同源的设置键（agent.subagentCancelOneEnabled），供子代理侧栏
# 的单任务取消按钮与 cancel_one 端点使用。
(state / 'settings.json').write_text(json.dumps({'agent': {'subagentCancelOneEnabled': True}}))

class ReplayAwareProvider(FakeProvider):
    """审批重放完成后把轮收束：不再发起新工具调用，只回最终摘要。"""
    def complete(self, messages, tools):
        results = {}
        for message in messages:
            cid = message.get("tool_call_id")
            if cid:
                try:
                    results[cid] = json.loads(message.get("content") or "{}")
                except ValueError:
                    results[cid] = {}
        for cid in (EDIT_CALL_ID, WRITE_CALL_ID):
            if results.get(cid, {}).get("ok"):
                return {"content": json.dumps({"summary": "已批准的工具调用已执行完成。", "evidence": [
                    {"tool_call_id": cid, "observation": "approved call replayed and executed"}]})}
        return {"content": json.dumps({"summary": "等待对被拒工具调用的显式审批。", "evidence": []})}

def denied_session(store, title, task, call, workspace):
    result = {"ok": False, "error": "denied", "error_code": "approval_required"}
    s = store.new(task, workspace)
    s['title'] = title
    s['status'] = 'paused'
    s['pause_reason'] = '被拒的工具调用等待显式审批；该轮已终止。'
    s['messages'] = [
        {'role': 'system', 'content': 'You are a coding agent.'},
        {'role': 'user', 'content': task},
        {'role': 'assistant', 'content': '', 'tool_calls': [call]},
        {'role': 'tool', 'tool_call_id': call['id'],
         'content': json.dumps(result, ensure_ascii=False)},
    ]
    s['results'] = {call['id']: result}
    store.save(s)
    return s

ctx = web.build_context(state, base / 'runs', workspace, allow_real=False)
# allow_real 仅放行 "real" 名称的解析检查；解析本身被替换为内部 fixture，
# 全程不会发起真实模型请求。
ctx['allow_real'] = True
ctx['webapp_dir'] = dist
store = ctx['store']

# notes.md 预置旧内容，批准后 edit 重放把文件真实改写为新内容。
(workspace / 'notes.md').write_text(OLD_TEXT, encoding='utf-8')

edit_call = {"id": EDIT_CALL_ID, "type": "function", "function": {"name": "edit", "arguments": json.dumps({
    "path": "notes.md", "old": OLD_TEXT, "new": NEW_TEXT})}}
approve_edit = denied_session(store, '审批面板：编辑批准流', '更新 notes.md 的报告生成器。', edit_call, workspace)

write_call = {"id": WRITE_CALL_ID, "type": "function", "function": {"name": "write", "arguments": json.dumps({
    "path": "hello-approve.txt", "content": "approved by keyboard" + chr(10)})}}
approve_write = denied_session(store, '审批面板：键盘批准流', '写入 hello-approve.txt。', write_call, workspace)

exec_call = {"id": EXEC_CALL_ID, "type": "function", "function": {"name": "exec",
    "arguments": json.dumps({"argv": ["python", "--version"]})}}
reject_exec = denied_session(store, '审批面板：拒绝后轮次终止', '运行 python --version。', exec_call, workspace)

subagent_session = store.new('派发只读子任务并随时可单独取消。', workspace)
subagent_session['title'] = '子代理单任务取消'
subagent_session['status'] = 'paused'
subagent_session['messages'] = [
    {'role': 'system', 'content': 'You are a coding agent.'},
    {'role': 'user', 'content': '派发只读子任务并随时可单独取消。'},
]
store.save(subagent_session)

registry = ctx['task_registry']
registry.record('task-a1b2c3d4', parent_session=subagent_session['id'], agent='explore',
                prompt='只读检查工作区结构与文件清单。', root=str(workspace))
registry.record('task-e5f6a7b8', parent_session=subagent_session['id'], agent='general-purpose',
                prompt='汇总子任务结果。', root=str(workspace))
registry.finish('task-e5f6a7b8', ok=True, summary='汇总完成：工作区结构无异常。', steps=3)

with patch("xueness.provider_config.resolve", return_value=ReplayAwareProvider()):
    server = web.create_server(0, ctx)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(json.dumps({'port': server.server_address[1],
                      'ids': {'edit': approve_edit['id'], 'write': approve_write['id'],
                              'exec': reject_exec['id'], 'subagents': subagent_session['id']},
                      'workspace': str(workspace)}), flush=True)
    threading.Event().wait(600)
    server.shutdown(); server.server_close()
`;
const configPath = join(temp, 'config.json');
await writeFile(configPath, JSON.stringify({ editCallId: EDIT_CALL_ID, writeCallId: WRITE_CALL_ID, execCallId: EXEC_CALL_ID, oldText: OLD_TEXT, newText: NEW_TEXT }));
const script = join(temp, 'server.py');
await writeFile(script, source);
const child = spawn(process.env.PYTHON || 'python3', [script, temp, join(root, 'webapp/dist'), configPath], {
  cwd: root,
  env: { ...process.env, PYTHONPATH: root, XUENESS_API_KEY: '', XUENESS_MODEL: '', XUENESS_MARKETPLACE_URL: '', XUENESS_WORKSPACE_ROOTS: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const failures = [];
let browser;
try {
  const ready = await new Promise((accept, reject) => {
    let out = '', err = '';
    child.stderr.on('data', d => err += d);
    child.stdout.on('data', d => { out += d; if (out.includes('\n')) accept(JSON.parse(out.split('\n')[0])); });
    child.once('exit', code => reject(new Error(`fixture ${code}: ${err}`)));
    setTimeout(() => reject(new Error(err || 'fixture timeout')), 30000).unref();
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  const workspace = ready.workspace;
  const ids = ready.ids;
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    if (ok) console.log(`  ok  ${name}`);
    else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  };
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('xueness.theme', 'light');
    localStorage.setItem('xueness.language', 'zh');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
    await route.continue();
  });
  const openSession = async id => {
    await page.goto(origin);
    const item = page.getByTestId(`xn-sidebar-item-${id}`);
    await item.waitFor({ state: 'attached' });
    if (!await item.isVisible()) await page.getByTestId('xn-shell-sidebar-toggle').click();
    await item.click();
  };
  const approvalsRegion = page.locator('.xn-approvals');

  // -- 场景 A：edit 审批（鼠标） ------------------------------------------
  await openSession(ids.edit);
  const editItem = page.getByTestId(`approval-item-${EDIT_CALL_ID}`);
  await editItem.waitFor();
  const toggle = editItem.locator('.xn-approval-preview-toggle');
  await toggle.waitFor();
  check('edit pending 面板渲染', (await approvalsRegion.count()) === 1);
  check('预览默认展开', (await toggle.getAttribute('aria-expanded')) === 'true');
  await page.screenshot({ path: join(outputDir, 'approval-pending.png') });
  // 真实鼠标点击：收起 → 再展开。
  await toggle.click();
  check('点击后预览收起', (await toggle.getAttribute('aria-expanded')) === 'false');
  await toggle.click();
  check('再次点击后预览展开', (await toggle.getAttribute('aria-expanded')) === 'true');

  // 真实鼠标点击批准并重试：批准 → replay_approved 重放 edit → 文件真实改写。
  // Windows 上 Python text-mode 写入会把 \n 落盘为 CRLF，断言前先归一。
  const lf = text => text.replace(/\r\n/g, '\n');
  const before = lf(await readFile(join(workspace, 'notes.md'), 'utf8'));
  check('批准前文件仍是旧内容', before === OLD_TEXT);
  await editItem.getByRole('button', { name: '批准并重试' }).click();
  await editItem.waitFor({ state: 'detached', timeout: 45000 });
  const after = lf(await readFile(join(workspace, 'notes.md'), 'utf8'));
  check('批准后面板清除', (await page.getByTestId(`approval-item-${EDIT_CALL_ID}`).count()) === 0);
  check('批准后工具真实执行（文件内容已改写）', after === NEW_TEXT, `got ${JSON.stringify(after)}`);
  await page.screenshot({ path: join(outputDir, 'approval-approved.png') });

  // -- 场景 K：键盘可达性冒烟（Tab 到批准按钮 + Enter） --------------------
  await openSession(ids.write);
  const writeItem = page.getByTestId(`approval-item-${WRITE_CALL_ID}`);
  await writeItem.waitFor();
  // write 类 pending 无预览：面板内第一个可 Tab 到的就是批准按钮。
  await approvalsRegion.click();
  let focused = '';
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName}:${el.textContent?.trim() ?? ''}` : '';
    });
    if (focused.includes('批准并重试')) break;
  }
  check('Tab 聚焦批准按钮', focused.includes('批准并重试'), focused);
  await page.keyboard.press('Enter');
  await writeItem.waitFor({ state: 'detached', timeout: 45000 });
  const written = lf(await readFile(join(workspace, 'hello-approve.txt'), 'utf8'));
  check('键盘批准后写入真实落盘', written === 'approved by keyboard\n', JSON.stringify(written));

  // -- 场景 R：拒绝路径（不批准即拒绝，轮次已终止） -------------------------
  // 本产品审批面板没有独立"拒绝"按钮：deny-by-default 门把被拒调用标记为
  // approval_required 并终止该轮，面板只提供显式批准。这里验证轮次终止 +
  // pending 仍挂起，并用真实鼠标点击待审批项（面板支持点击选中）。
  await openSession(ids.exec);
  const execItem = page.getByTestId(`approval-item-${EXEC_CALL_ID}`);
  await execItem.waitFor();
  const toolRow = page.locator('[data-testid^="timeline-item-tool-"][data-status="pendingApproval"]');
  check('被拒调用在时间线标记等待批准', (await toolRow.count()) >= 1);
  await execItem.click();
  check('点击待审批项后获得焦点标记', (await execItem.getAttribute('data-focused')) === 'true');
  check('轮次终止原因可见', (await page.locator('.xn-run-error').count()) >= 1);
  await page.screenshot({ path: join(outputDir, 'approval-rejected.png') });

  // -- 场景 S：子代理单任务取消（T2 佐证） ---------------------------------
  await openSession(ids.subagents);
  // Radix Select 触发器的 ARIA 角色是 combobox，不是 button。
  await page.getByRole('combobox', { name: '切换视图' }).click();
  await page.getByRole('option', { name: '子代理' }).click();
  const pane = page.getByTestId('subagent-sidepane');
  await pane.waitFor();
  const runningCard = page.getByTestId('subagent-task-task-a1b2c3d4');
  await runningCard.waitFor();
  const endedCard = page.getByTestId('subagent-task-task-e5f6a7b8');
  await endedCard.waitFor();
  const cancelOne = runningCard.getByTestId('subagent-cancel-task-a1b2c3d4');
  check('实验开关开启时运行中子任务行有独立取消按钮', (await cancelOne.count()) === 1);
  check('已结束子任务不提供取消按钮', (await endedCard.getByTestId('subagent-cancel-task-e5f6a7b8').count()) === 0);
  let cancelPath = '';
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/tasks/')) cancelPath = new URL(request.url()).pathname;
  });
  page.once('dialog', dialog => dialog.accept());
  await page.screenshot({ path: join(outputDir, 'subagent-cancel-one.png') });
  await cancelOne.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="subagent-status-task-a1b2c3d4"]')?.textContent === '已取消',
    undefined, { timeout: 15000 },
  );
  check('取消请求命中 cancel_one 端点', cancelPath === `/api/sessions/${ids.subagents}/tasks/task-a1b2c3d4/cancel`, cancelPath);
  check('取消后该行状态变为已取消', true);
  check('另一子任务（已完成）不受影响', (await endedCard.count()) === 1);
  await page.screenshot({ path: join(outputDir, 'subagent-cancel-one-done.png') });

  assert.deepEqual(external, [], `blocked external requests: ${external.join(', ')}`);
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  if (failures.length) {
    console.error(`FAIL approval-interactions (${failures.length}):\n  - ${failures.join('\n  - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS approval-pending/approved/rejected.png + subagent-cancel-one.png -> ${outputDir}`);
  }
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.error(`FAIL approval-interactions: ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await browser?.close().catch(() => {});
}
