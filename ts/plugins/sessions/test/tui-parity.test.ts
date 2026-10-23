import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'node:test';
import type { Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import { TuiInputDecoder } from '../src/tui-input.ts';
import { filterChoices, completeChoice, menuQuery } from '../src/tui-menus.ts';
import { permissionDialog } from '../src/tui-permission.ts';
import { questionDialog } from '../src/tui-questions.ts';
import { renderTuiFrame } from '../src/tui-frame.ts';
import { createTuiUiState } from '../src/tui-ui-state.ts';
import { applyTuiEvent, createTuiDocument, documentLines, hydrateTuiDocument } from '../src/tui-transcript.ts';
import { refreshTuiSidebar } from '../src/tui-actions.ts';
import { FullscreenChatTerminal } from '../src/tui-fullscreen.ts';
import type { TuiDialog, TuiPermissionRequest, TuiPort } from '../src/tui-types.ts';
import { cellWidth } from '../src/tui-text.ts';

const key = (name: string, flags: Partial<Key> = {}): Key => ({ name, sequence: name, ...flags }) as Key;
const press = <T>(dialog: TuiDialog<T>, name: string, text?: string, flags: Partial<Key> = {}) => dialog.key(text, key(name, flags));
const dialogValue = <T>(dialog: TuiDialog<T>, name: string, text?: string, flags: Partial<Key> = {}): T => {
  const result = press(dialog, name, text, flags);
  if (!result.done) throw new Error(`Dialog did not finish on ${name}`);
  return result.value;
};
const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve)); };

test('menu filtering keeps catalog order and file completion distinguishes directories from attachments', () => {
  const catalog = [
    { id: 'early', label: 'Open document', value: 'open', description: 'read current file' },
    { id: 'middle', label: 'Read source', value: 'read', keywords: ['inspect'] },
    { id: 'late', label: 'Read workspace', value: 'workspace', description: 'read all files' },
  ];
  assert.deepEqual(filterChoices(catalog, 'read').map((item) => item.id), ['early', 'middle', 'late']);
  const draft = 'inspect @src/mai';
  const query = menuQuery(draft, draft.length)!;
  assert.equal(query.kind, 'file');
  assert.equal(query.query, 'src/mai');
  const menu = { ...query, title: 'Files', items: [], selected: 0 };
  const directory = completeChoice(draft, menu, { id: 'dir', label: 'folder', value: 'src/folder/', directory: true });
  assert.equal(directory.text, 'inspect @src/folder/');
  assert.equal(directory.attach, undefined);
  const file = completeChoice(draft, menu, { id: 'file', label: 'main.ts', value: 'src/main.ts' });
  assert.equal(file.text, 'inspect @src/main.ts ');
  assert.equal(file.attach, 'src/main.ts');
});

test('permission dialog gates project memory and supports downward selection and denial feedback', () => {
  const request = (code: string, remember: TuiPermissionRequest['remember']): TuiPermissionRequest => ({
    callId: 'call-1', tool: 'write_file', kind: 'write', subject: 'a.txt', code, message: 'Needs approval',
    remember, signal: new AbortController().signal,
  });
  const remembered = permissionDialog(request('approval_required', { exact: ['write:a.txt'], broad: ['write:*'] }));
  assert.ok(remembered.view('en').lines.some((line) => line.includes('Always allow in this project')));
  press(remembered, 'down');
  assert.deepEqual(dialogValue(remembered, 'return'), { behavior: 'allow', remember: ['write:a.txt'], project: true });

  for (const candidate of [request('approval_required', null), request('approval_denied', { exact: ['write:a.txt'], broad: [] })]) {
    const dialog = permissionDialog(candidate);
    assert.ok(!dialog.view('en').lines.some((line) => line.includes('Always allow in this project')));
    press(dialog, 'down');
    assert.equal(dialogValue(dialog, 'return').behavior, 'deny');
  }
  const feedback = permissionDialog(request('approval_required', null));
  press(feedback, 'r', 'r');
  for (const char of 'Not now') press(feedback, char, char);
  assert.deepEqual(dialogValue(feedback, 'return'), {
    behavior: 'deny', message: 'write requires explicit approval', reason: 'user_denied', feedback: 'Not now',
  });
});

test('question dialog combines single choice, multi choice, Other, skip, review, and final answers', () => {
  const dialog = questionDialog([
    { id: 'single', header: 'Single', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'multi', header: 'Multi', question: 'Pick several', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }] },
    { id: 'other', header: 'Other', question: 'Add a value', options: [{ label: 'Default' }] },
    { id: 'skip', header: 'Skip', question: 'Optional' },
  ]);
  press(dialog, 'down'); press(dialog, 'return');
  press(dialog, '2', '2'); press(dialog, 'return');
  press(dialog, 'o', 'o');
  for (const char of 'custom value') press(dialog, char, char);
  press(dialog, 'return'); press(dialog, 'return');
  press(dialog, 's', 's');
  const review = dialog.view('en');
  assert.ok(review.lines.some((line) => line.includes('[skip] Skip: Skipped')));
  const result = dialogValue(dialog, 'return');
  assert.match(result ?? '', /\[single\] Single: B/);
  assert.match(result ?? '', /\[multi\] Multi: Blue/);
  assert.match(result ?? '', /\[other\] Other: custom value/);
});

test('event projection upserts tool results, enriches private results, deduplicates final assistant text, and omits system prompts', async () => {
  const doc = createTuiDocument('fixture');
  applyTuiEvent(doc, { type: 'tool_call', id: 'call-1', name: 'read_file', input: { path: 'a.txt' } });
  applyTuiEvent(doc, { type: 'tool_result', id: 'call-1', name: 'read_file', result: 'public result', ok: true });
  applyTuiEvent(doc, { type: 'assistant_delta', stream_id: 'assistant-one', delta: 'First ' });
  applyTuiEvent(doc, { type: 'assistant_delta', stream_id: 'assistant-one', delta: 'complete answer.' });
  applyTuiEvent(doc, { type: 'assistant', stream_id: 'assistant-one', content: 'First complete answer.' });
  applyTuiEvent(doc, { type: 'assistant_delta', stream_id: 'assistant-two', delta: 'TUI_STREAM_OK' });
  applyTuiEvent(doc, { type: 'assistant', stream_id: 'assistant-two', content: 'TUI_STREAM_OK' });
  applyTuiEvent(doc, { type: 'completion', response: 'TUI_STREAM_OK' });
  applyTuiEvent(doc, { type: 'reasoning_delta', stream_id: 's', delta: 'partial thought' });

  const ui = createTuiUiState('en');
  ui.context.sessionId = 'fixture'; ui.document = doc;
  const sidebarData: Record<string, any> = { files: [], todos: [], subagents: [], mcp: [], workflows: [], apis: [],
    messages: [{ role: 'assistant', content: 'TUI_STREAM_OK' }], streams: [{ id: 's', reasoning: 'full thought restored', final_message_index: 0 }], toolResults: {
      'call-1': { ok: false, output: 'stale approval snapshot', data: { awaitingApproval: true } },
    } };
  const port = { sidebar: async () => sidebarData } as unknown as TuiPort;
  await refreshTuiSidebar({ ui, port, schedule() {} } as Parameters<typeof refreshTuiSidebar>[0]);
  const tools = doc.entries.filter((entry) => entry.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.status, 'completed');
  assert.equal(tools[0]?.output, 'public result');

  sidebarData.toolResults['call-1'] = { ok: true, output: 'private result enrichment', data: { diff: '+private change' } };
  await refreshTuiSidebar({ ui, port, schedule() {} } as Parameters<typeof refreshTuiSidebar>[0]);
  const latestTool = doc.entries.find((entry) => entry.kind === 'tool' && entry.id === 'call-1');
  assert.equal(latestTool?.status, 'completed');
  assert.match(latestTool?.output ?? '', /private result enrichment/);
  assert.equal(latestTool?.diff, '+private change');
  assert.deepEqual(doc.entries.filter((entry) => entry.kind === 'assistant').map((entry) => [entry.id, entry.text]), [
    ['assistant-one', 'First complete answer.'], ['assistant-two', 'TUI_STREAM_OK'],
  ]);
  const restoredThoughts = doc.entries.filter((entry) => entry.kind === 'thought' && entry.id === 'reasoning-s');
  assert.equal(restoredThoughts.length, 1);
  assert.equal(restoredThoughts[0]?.text, 'full thought restored');
  assert.ok(documentLines(doc, 80, 'dark', 'en').some((line) => stripVTControlCharacters(line.text).includes('TUI_STREAM_OK')));

  const hydrated = hydrateTuiDocument('fixture', [
    { role: 'system', content: 'private system prompt' }, { role: 'user', content: 'visible user text' },
  ]);
  assert.ok(!documentLines(hydrated, 80, 'dark', 'en').some((line) => line.text.includes('private system prompt')));
});

test('frame preserves sidebar layouts and keeps the long dialog cursor line visible without a selection', () => {
  const shared = { title: 'XUENESS', context: 'model · mode', status: 'Ready', transcript: '', draft: '', cursor: 0, prompt: null, running: false, scroll: 0, language: 'en' as const };
  const sidebar = [{ text: 'SIDEBAR ITEM', action: 'sidebar:modifiedFiles' }];
  const wide = renderTuiFrame({ ...shared, columns: 140, rows: 22, mainLines: [{ text: 'main content' }], sidebarLines: sidebar, sidebarWidth: 42 });
  assert.ok(wide.regions.some((region) => region.action === 'sidebar:modifiedFiles' && region.x === 99));
  assert.ok(stripVTControlCharacters(wide.output).includes('SIDEBAR ITEM'));

  const narrow = renderTuiFrame({ ...shared, columns: 54, rows: 18, mainLines: [{ text: 'main content' }], sidebarLines: sidebar, sidebarWidth: 42, sidebarOverlay: true });
  assert.ok(narrow.regions.some((region) => region.action === 'sidebar:modifiedFiles' && region.x === 13));
  const dialogLines = Array.from({ length: 20 }, (_, index) => index === 19 ? `CURSOR-TAIL-${'x'.repeat(80)}` : `row-${index}`);
  const dialog = renderTuiFrame({ ...shared, columns: 54, rows: 18, mainLines: [{ text: 'main content' }], sidebarLines: sidebar, sidebarWidth: 42, sidebarOverlay: true,
    dialog: { title: 'Approval', lines: dialogLines, help: 'Enter confirm', cursor: { row: 19, column: 72 } } });
  const visibleRows = stripVTControlCharacters(dialog.output).split('\r\n');
  assert.equal(visibleRows.length, 18);
  for (const row of visibleRows) assert.ok(cellWidth(row) <= 54);
  assert.ok(visibleRows.some((row) => row.includes('CURSOR-TAIL-')));
  assert.ok(dialog.regions.some((region) => region.action === 'dialog:19'));
  const cursor = [...dialog.output.matchAll(/\x1b\[(\d+);(\d+)H/g)].at(-1)!;
  assert.ok(Number(cursor[1]) >= 1 && Number(cursor[1]) <= 18);
  assert.ok(Number(cursor[2]) >= 1 && Number(cursor[2]) <= 54);
});

test('input decoder handles fragmented UTF-8, mouse, OSC theme, paste, and modified Enter keys', async () => {
  const keys: { text: string | undefined; key: Key }[] = [];
  const mouse: { x: number; y: number; wheel: number }[] = [];
  const themes: string[] = [];
  const decoder = new TuiInputDecoder({
    key: (text, value) => keys.push({ text, key: value }),
    mouse: (event) => mouse.push({ x: event.x, y: event.y, wheel: event.wheel }),
    theme: (mode) => themes.push(mode),
  });
  try {
    const utf8 = Buffer.from('猫');
    decoder.write(utf8.subarray(0, 1)); decoder.write(utf8.subarray(1));
    decoder.write('\x1b[<64;7;'); decoder.write('9M');
    decoder.write('\x1b]11;rgb:ffff/ffff/ffff'); decoder.write('\x07');
    decoder.write('\x1b[20'); decoder.write('0~pasted\x1b[201~');
    decoder.write('\x1b[13;2u\x1b[13;5u');
    await tick();
    assert.ok(keys.some((item) => item.text === '猫'));
    assert.deepEqual(mouse, [{ x: 6, y: 8, wheel: -1 }]);
    assert.deepEqual(themes, ['light']);
    assert.ok(keys.some((item) => item.key.name === 'paste-start'));
    assert.ok(keys.some((item) => item.key.name === 'paste-end'));
    assert.ok(keys.some((item) => item.key.name === 'return' && item.key.shift));
    assert.ok(keys.some((item) => item.key.name === 'return' && item.key.ctrl));
  } finally { decoder.close(); }
});

class FakeInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(enabled: boolean): this { this.isRaw = enabled; return this; }
}

class FakeOutput extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void { done(); }
}

test('controller queues and steers through its fake port, preserves a racing draft, exits on two Ctrl-C presses, and closes listeners', async () => {
  const input = new FakeInput(); const output = new FakeOutput();
  const sent: { text: string; delivery: string }[] = [];
  const pending: ((value: { id: string; text: string; kind: 'queue' | 'steer' }) => void)[] = [];
  let stopped = 0;
  let unsubscribed = 0;
  const port = {
    subscribe: () => () => { unsubscribed += 1; },
    choices: async () => [],
    sidebar: async () => ({ files: [], todos: [], subagents: [], mcp: [], workflows: [], apis: [] }),
    childTranscript: async () => ({ sessionId: 'child', messages: [] }),
    sendInput: (text: string, _attachments: readonly unknown[], delivery: 'queue' | 'steer') => {
      sent.push({ text, delivery });
      return new Promise<{ id: string; text: string; kind: 'queue' | 'steer' }>((resolve) => pending.push(resolve));
    },
    cancelInput: async () => {}, captureImage: async () => null, attach: async (path: string) => ({ id: path, label: path }),
    writeClipboard: async () => {}, setMode: async (mode: string) => mode, stop: () => { stopped += 1; },
  } as unknown as TuiPort;
  const terminal = new FullscreenChatTerminal({ input: input as unknown as ReadStream, output: output as unknown as WriteStream, language: 'en' });
  const before = { data: input.listenerCount('data'), end: input.listenerCount('end'), resize: output.listenerCount('resize'), sigint: process.listenerCount('SIGINT') };
  try {
    terminal.connect(port); terminal.watch(); terminal.running = true;
    terminal.ui.draft.replace('queued text'); terminal.submit('queue');
    terminal.ui.draft.replace('keep this draft');
    assert.deepEqual(sent, [{ text: 'queued text', delivery: 'queue' }]);
    pending[0]!({ id: 'q1', text: 'queued text', kind: 'queue' }); await tick();
    assert.equal(terminal.ui.draft.value, 'keep this draft');
    terminal.ui.draft.replace('steering text'); terminal.submit('steer');
    assert.deepEqual(sent[1], { text: 'steering text', delivery: 'steer' });
    pending[1]!({ id: 's1', text: 'steering text', kind: 'steer' }); await tick();
    assert.equal(terminal.ui.draft.value, '');
    terminal.running = false; await tick();
    input.write('\x03\x03'); await tick();
    assert.equal(stopped, 1);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('data'), before.data);
    assert.equal(input.listenerCount('end'), before.end);
    assert.equal(output.listenerCount('resize'), before.resize);
    assert.equal(process.listenerCount('SIGINT'), before.sigint);
    terminal.close();
    assert.equal(unsubscribed, 1);
  } finally { terminal.close(); }
});
