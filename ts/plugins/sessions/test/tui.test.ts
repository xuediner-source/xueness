import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'node:test';
import type { ReadStream, WriteStream } from 'node:tty';
import { ChatEditor } from '../src/tui-editor.ts';
import { FullscreenChatTerminal } from '../src/tui.ts';
import { renderTuiFrame } from '../src/tui-frame.ts';
import { cellWidth, cursorPosition, wrapText } from '../src/tui-text.ts';

class FakeInput extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    return this;
  }
}

class FakeOutput extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    done();
  }

  text(): string {
    return this.chunks.join('');
  }
}

function terminalStreams(): { input: FakeInput; output: FakeOutput; terminal: FullscreenChatTerminal } {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new FullscreenChatTerminal({
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream,
    language: 'en',
  });
  return { input, output, terminal };
}

test('Unicode editor preserves graphemes, history draft, and wrapped cursor positions', () => {
  const editor = new ChatEditor();
  editor.insert('甲👩‍💻é乙');
  editor.left();
  editor.backspace();
  assert.equal(editor.value, '甲👩‍💻乙');
  assert.equal(editor.cursor, '甲👩‍💻'.length);

  editor.replace('previous command');
  editor.submit();
  editor.replace('unsent draft');
  editor.previous();
  assert.equal(editor.value, 'previous command');
  editor.next();
  assert.equal(editor.value, 'unsent draft');

  assert.deepEqual(cursorPosition('ab', 2), { row: 1, column: 0 });
  assert.deepEqual(cursorPosition('ab\nc', 2), { row: 1, column: 1 });
  assert.deepEqual(wrapText('中文ab', 4), ['中文', 'ab']);
});

test('frame rendering fits terminal cells and scrolls to earlier transcript text', () => {
  const draft = '很长的中文草稿👩‍💻'.repeat(18);
  for (const [columns, rows] of [[32, 12], [80, 24]] as const) {
    const frame = renderTuiFrame({
      columns, rows, title: 'XUENESS', context: '', status: 'Ready',
      transcript: 'EARLY transcript marker\n'.repeat(80) + 'LATEST transcript marker',
      draft, cursor: draft.length, prompt: 'Input', running: false, scroll: 0, language: 'en',
    });
    const lines = stripVTControlCharacters(frame.output).split('\r\n');
    assert.equal(lines.length, rows);
    for (const line of lines) assert.ok(cellWidth(line) <= columns);

    const cursorMatches = [...frame.output.matchAll(/\x1b\[(\d+);(\d+)H/g)];
    assert.ok(cursorMatches.length > 0);
    const [, cursorRow, cursorColumn] = cursorMatches.at(-1)!;
    assert.ok(Number(cursorRow) >= 1 && Number(cursorRow) <= rows);
    assert.ok(Number(cursorColumn) >= 1 && Number(cursorColumn) <= columns);

  }

  const { input, output, terminal } = terminalStreams();
  try {
    terminal.write('EARLY transcript marker\n'.repeat(80) + 'LATEST transcript marker');
    terminal.watch();
    const previousLength = output.chunks.length;
    input.write('\x1b[5~');
    terminal.paint();
    assert.ok(stripVTControlCharacters(output.chunks.slice(previousLength).join('')).includes('EARLY transcript marker'));
  } finally {
    terminal.close();
  }
});

test('controller handles multiline paste and keeps approval input separate from the next draft', async () => {
  const { input, terminal } = terminalStreams();
  try {
    let settled = false;
    const pasted = terminal.prompt('› ').then((value) => {
      settled = true;
      return value;
    });
    input.write('\x1b[200~第一行\n第二行\x1b[201~');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    input.write('\r');
    assert.equal(await pasted, '第一行\n第二行');

    terminal.running = true;
    input.write('next draft');
    const approval = terminal.prompt('Approve write example? [y/N] ');
    input.write('y\r');
    assert.equal(await approval, 'y');

    terminal.running = false;
    const ordinary = terminal.prompt('› ');
    input.write('\r');
    assert.equal(await ordinary, 'next draft');
  } finally {
    terminal.close();
  }
});

test('controller interrupt and close restore terminal state and remove listeners once', () => {
  const { input, output, terminal } = terminalStreams();
  const sigintBefore = process.listenerCount('SIGINT');
  const keypressBefore = input.listenerCount('keypress');
  const resizeBefore = output.listenerCount('resize');
  try {
    terminal.watch();
    assert.equal(input.isRaw, true);
    assert.ok(output.text().includes('\x1b[?1049h'));
    assert.ok(output.text().includes('\x1b[?2004h'));

    terminal.running = true;
    terminal.interrupt();
    assert.equal(terminal.stopRequested, true);

    terminal.close();
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('keypress'), keypressBefore);
    assert.equal(output.listenerCount('resize'), resizeBefore);
    assert.equal(process.listenerCount('SIGINT'), sigintBefore);
    const closedOutput = output.text();
    assert.ok(closedOutput.includes('\x1b[?2004l'));
    assert.ok(closedOutput.includes('\x1b[?25h'));
    assert.ok(closedOutput.includes('\x1b[?1049l'));

    terminal.close();
    assert.equal(output.text(), closedOutput);
  } finally {
    terminal.close();
  }
});
