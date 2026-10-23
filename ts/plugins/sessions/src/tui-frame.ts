import { cellWidth, cleanText, cursorPosition, graphemes, wrapText } from './tui-text.ts';
import type { TuiDialogView, TuiLine, TuiThemeMode } from './tui-types.ts';
import { palette } from './tui-theme.ts';

export interface TuiFrameState {
  columns: number;
  rows: number;
  title: string;
  context: string;
  status: string;
  transcript: string;
  draft: string;
  cursor: number;
  prompt: string | null;
  running: boolean;
  scroll: number;
  language: 'zh' | 'en';
  themeMode?: TuiThemeMode;
  mainLines?: readonly TuiLine[];
  sidebarLines?: readonly TuiLine[];
  sidebarWidth?: number;
  sidebarOverlay?: boolean;
  sidebarScroll?: number;
  menuLines?: readonly TuiLine[];
  dialog?: TuiDialogView;
  attachmentLabels?: readonly string[];
  queuedLabels?: readonly string[];
  notice?: string;
  selectedRange?: { start: { line: number; column: number }; end: { line: number; column: number } };
}

export interface TuiFrame {
  output: string;
  viewRows: number;
  maxScroll: number;
  inputWidth: number;
  inputRow: number;
  inputRows: number;
  draftTop: number;
  sidebarArea?: { x: number; width: number };
  sidebarScroll: number;
  transcriptTop: number;
  visibleLines: readonly TuiLine[];
  regions: { x: number; y: number; width: number; height: number; action: string }[];
}

const sgrPattern = /\x1b\[[0-9;:]*m/g;
const reset = '\x1b[0m';

function plainAnsi(text: string): string {
  return cleanText(text.replace(sgrPattern, '')).replace(/\n/g, ' ');
}

function selectedAt(line: number, column: number, width: number, range: TuiFrameState['selectedRange']): boolean {
  if (!range) return false;
  const before = (a: { line: number; column: number }, b: { line: number; column: number }) =>
    a.line < b.line || (a.line === b.line && a.column < b.column);
  const reversed = before(range.end, range.start);
  const start = reversed ? range.end : range.start;
  const end = reversed ? range.start : range.end;
  const cellStart = { line, column };
  const cellEnd = { line, column: column + width };
  return before(cellStart, end) && before(start, cellEnd);
}

/** Clip by terminal cells while retaining only SGR styling from the source text. */
function clipAnsi(text: string, columns: number, line?: number, range?: TuiFrameState['selectedRange']): string {
  const limit = Math.max(0, Math.floor(columns));
  let result = '';
  let width = 0;
  let offset = 0;
  let stopped = false;
  const appendText = (value: string) => {
    if (stopped) return;
    for (const part of graphemes(plainAnsi(value))) {
      const partWidth = cellWidth(part);
      if (width + partWidth > limit) { stopped = true; break; }
      if (line !== undefined && selectedAt(line, width, partWidth, range)) result += `\x1b[7m${part}\x1b[27m`;
      else result += part;
      width += partWidth;
    }
  };
  for (const match of text.matchAll(sgrPattern)) {
    const index = match.index ?? offset;
    appendText(text.slice(offset, index));
    if (stopped) break;
    result += match[0];
    offset = index + match[0].length;
  }
  if (!stopped) appendText(text.slice(offset));
  return result;
}

function padAnsi(text: string, columns: number): string {
  const clipped = clipAnsi(text, columns);
  return clipped + ' '.repeat(Math.max(0, columns - cellWidth(plainAnsi(clipped))));
}

function toneColor(tone: TuiLine['tone'], colors: ReturnType<typeof palette>): string {
  switch (tone) {
    case 'accent': return colors.accent;
    case 'dim': return colors.dim;
    case 'error': return colors.error;
    case 'success': return colors.success;
    case 'warning': return colors.warning;
    default: return '';
  }
}

function legacyTone(text: string): TuiLine['tone'] {
  const trimmed = text.trimStart();
  return trimmed.startsWith('→') ? 'warning'
    : trimmed.startsWith('✓') ? 'success'
      : trimmed.startsWith('✗') ? 'error'
        : trimmed.startsWith('◆') || trimmed.startsWith('›') ? 'accent' : undefined;
}

function styledLine(line: TuiLine, width: number, colors: ReturnType<typeof palette>, absoluteLine?: number, range?: TuiFrameState['selectedRange']): string {
  const text = clipAnsi(line.text, width, absoluteLine, range);
  const color = toneColor(line.tone, colors);
  const body = color ? `${color}${text}${colors.reset}` : text;
  return body + ' '.repeat(Math.max(0, width - cellWidth(plainAnsi(text))));
}

function outputFrame(lines: string[], cursor: { row: number; column: number } | null, colors: ReturnType<typeof palette>): string {
  const base = colors.background + colors.foreground;
  const body = lines.map((line) => `${reset}${base}\x1b[2K${line.replaceAll(reset, reset + base)}${reset}`).join('\r\n');
  if (!cursor) return `\x1b[?25l\x1b[H${body}\x1b[?25l`;
  return `\x1b[?25l\x1b[H${body}\x1b[${cursor.row + 1};${cursor.column + 1}H\x1b[?25h`;
}

function lineRow(text: string, width: number, color = ''): string {
  const clipped = clipAnsi(text, width);
  return `${color}${clipped}${color ? reset : ''}${' '.repeat(Math.max(0, width - cellWidth(plainAnsi(clipped))))}`;
}

function inputCursor(draft: string, cursor: number, inputWidth: number, inputRows: number, inputRow: number): { row: number; column: number } {
  const cleanDraft = cleanText(draft);
  const columns = Math.max(1, inputWidth);
  const rows = Math.max(1, inputRows);
  const position = cursorPosition(cleanDraft.slice(0, Math.max(0, Math.min(cleanDraft.length, cursor))), columns);
  const first = Math.max(0, position.row - rows + 1);
  return { row: inputRow + Math.min(rows - 1, position.row - first), column: Math.min(columns - 1, position.column) };
}

function cursorInWrappedLine(text: string, column: number, width: number): { row: number; column: number } {
  const target = Math.max(0, column);
  let row = 0;
  let visualColumn = 0;
  let sourceColumn = 0;
  for (const part of graphemes(cleanText(text))) {
    if (part === '\n') {
      if (target <= sourceColumn) return { row, column: visualColumn };
      row += 1; visualColumn = 0; sourceColumn = 0; continue;
    }
    const sourceWidth = cellWidth(part);
    const partWidth = sourceWidth > width ? 1 : sourceWidth;
    if (target <= sourceColumn) return { row, column: visualColumn };
    if (visualColumn + partWidth > width) { row += 1; visualColumn = 0; }
    if (target < sourceColumn + sourceWidth) return { row, column: visualColumn };
    visualColumn += partWidth;
    sourceColumn += sourceWidth;
    if (target === sourceColumn) return visualColumn === width ? { row: row + 1, column: 0 } : { row, column: visualColumn };
  }
  return { row, column: visualColumn };
}

export function renderTuiFrame(state: TuiFrameState): TuiFrame {
  const width = Math.max(0, Math.floor(state.columns));
  const height = Math.max(0, Math.floor(state.rows));
  const zh = state.language === 'zh';
  const colors = palette(state.themeMode ?? 'dark');
  const sidebarScroll = Math.max(0, Math.min(state.sidebarScroll ?? 0, (state.sidebarLines?.length ?? 0) - height));
  const sideLines = state.sidebarLines?.slice(sidebarScroll);
  const requestedSideWidth = Math.max(3, Math.floor(state.sidebarWidth ?? 42));
  const wideSidebar = !!sideLines && width > 120 && !state.sidebarOverlay;
  const overlaySidebar = !!sideLines && !wideSidebar;
  const sideWidth = sideLines ? Math.min(width, requestedSideWidth) : 0;
  const mainWidth = wideSidebar ? Math.max(1, width - sideWidth) : width;
  const titleWidth = mainWidth;
  const attachmentText = state.attachmentLabels?.length
    ? `${zh ? '附件' : 'Attachments'}: ${state.attachmentLabels.map(cleanText).join(' · ')}` : '';
  const queuedText = state.queuedLabels?.length
    ? `${zh ? '队列' : 'Queued'}: ${state.queuedLabels.map(cleanText).join(' · ')}` : '';
  const persistent = [attachmentText, queuedText].filter(Boolean);
  const rawMenu = state.menuLines?.slice(0, 10) ?? [];
  const footerText = state.notice ? cleanText(state.notice) : zh
    ? 'Esc 暂停 · Ctrl-X B 侧栏 · Tab 补全 · Ctrl-C 两次退出'
    : 'Esc pause · Ctrl-X B sidebar · Tab complete · Ctrl-C twice exit';
  const promptLabel = cleanText(state.prompt ?? (state.running
    ? (zh ? '运行中 · 可预写下一条输入' : 'Running · you can draft the next input')
    : (zh ? '输入' : 'Input')));

  let mainLines: TuiLine[];
  if (state.mainLines !== undefined) mainLines = [...state.mainLines];
  else {
    const oldWidth = Math.max(1, mainWidth - (wideSidebar ? 0 : 2));
    mainLines = cleanText(state.transcript).split('\n').flatMap((source) =>
      wrapText(source, oldWidth).map((text) => ({ text, tone: legacyTone(text) })));
  }

  const rows: string[] = Array.from({ length: height }, () => '');
  const regions: TuiFrame['regions'] = [];
  const setRow = (y: number, text: string, color = '') => {
    if (y >= 0 && y < height) rows[y] = lineRow(text, titleWidth, color);
  };

  const topRows = Math.min(3, height);
  const footerRows = height >= 5 ? 1 : 0;
  const promptRows = height >= 7 ? 1 : 0;
  const baseInputRows = height >= 6 ? 2 : height >= 5 ? 1 : 0;
  const dividerRows = height >= 9 ? 1 : 0;
  const transcriptMin = height >= 8 ? 1 : 0;
  const core = topRows + footerRows + promptRows + baseInputRows + dividerRows + transcriptMin;
  const persistentSlots = Math.max(0, height - core);
  let shownPersistent = persistent.slice(0, Math.min(persistent.length, persistentSlots));
  if (persistent.length > persistentSlots && persistentSlots === 1) {
    shownPersistent = [`${attachmentText}${attachmentText && queuedText ? ' · ' : ''}${queuedText}`];
  }
  const remainingForMenu = Math.max(0, persistentSlots - shownPersistent.length);
  const menuCount = Math.min(rawMenu.length, remainingForMenu);
  const extra = Math.max(0, height - core - shownPersistent.length - menuCount);
  const inputRows = baseInputRows > 0
    ? Math.min(6, baseInputRows + Math.floor(extra / 2)) : 0;
  const viewRows = Math.max(0, transcriptMin + extra - (inputRows - baseInputRows));

  const titleText = `${cleanText(state.title)}  ${cleanText(state.status)}`;
  setRow(0, `${colors.bold}${colors.accent}${clipAnsi(titleText, titleWidth)}${colors.reset}`);
  if (topRows > 1) setRow(1, cleanText(state.context), colors.dim);
  if (topRows > 2) setRow(2, '─'.repeat(Math.max(0, titleWidth)), colors.border);

  const maxScroll = Math.max(0, mainLines.length - viewRows);
  const scroll = Math.max(0, Math.min(maxScroll, Math.floor(state.scroll)));
  const transcriptEnd = Math.max(0, mainLines.length - scroll);
  const transcriptTop = Math.max(0, transcriptEnd - viewRows);
  const visibleLines = mainLines.slice(transcriptTop, transcriptEnd);
  const transcriptStartRow = topRows;
  for (let index = 0; index < viewRows; index += 1) {
    const absoluteLine = transcriptTop + index;
    const line = mainLines[absoluteLine];
    if (!line) continue;
    const y = transcriptStartRow + index;
    if (y >= height) continue;
    const displayed = state.mainLines === undefined ? { ...line, text: ` ${line.text}` } : line;
    rows[y] = styledLine(displayed, titleWidth, colors, absoluteLine, state.selectedRange);
    regions.push({ x: 0, y, width: mainWidth, height: 1, action: `transcript:${absoluteLine}` });
    if (line.action) regions.push({ x: 0, y, width: mainWidth, height: 1, action: line.action });
  }

  let y = transcriptStartRow + viewRows;
  if (dividerRows) setRow(y++, '─'.repeat(Math.max(0, titleWidth)), colors.border);
  for (const label of shownPersistent) setRow(y++, label, colors.dim);
  for (let index = 0; index < menuCount; index += 1) {
    const item = rawMenu[index]!;
    setRow(y, styledLine(item, titleWidth, colors));
    regions.push({ x: 0, y, width: mainWidth, height: 1, action: item.action ?? `menu-row:${index}` });
    y += 1;
  }
  if (promptRows) setRow(y++, promptLabel, colors.accent);
  const inputRow = Math.max(0, Math.min(Math.max(0, height - 1), y));
  const cleanDraft = cleanText(state.draft);
  const wrappedDraft = inputRows > 0 ? wrapText(`${cleanDraft} `, Math.max(1, titleWidth)) : [];
  const draftCursor = cursorPosition(cleanDraft.slice(0, Math.max(0, Math.min(cleanDraft.length, state.cursor))), Math.max(1, titleWidth));
  const draftTop = Math.max(0, draftCursor.row - inputRows + 1);
  const draftRows = wrappedDraft.slice(draftTop, draftTop + inputRows);
  for (let index = 0; index < inputRows; index += 1) {
    setRow(y++, draftRows[index] ?? '');
  }
  if (footerRows) setRow(height - 1, footerText, colors.dim);

  if (wideSidebar && sideLines) {
    const sideStart = mainWidth;
    const innerWidth = Math.max(0, sideWidth - 2);
    for (let row = 0; row < height; row += 1) {
      const line = sideLines[row];
      regions.push({ x: sideStart, y: row, width: sideWidth, height: 1, action: 'sidebar-panel' });
      const content = line ? styledLine(line, innerWidth, colors) : ' '.repeat(innerWidth);
      rows[row] = `${rows[row] ?? ''}${colors.border}│${colors.reset}${content}${colors.border}│${colors.reset}`;
      if (line?.action && innerWidth > 0) regions.push({ x: sideStart + 1, y: row, width: innerWidth, height: 1, action: line.action });
    }
  } else if (overlaySidebar && sideLines && width > 0) {
    const overlayWidth = Math.max(1, sideWidth);
    const overlayStart = width - overlayWidth;
    const innerWidth = Math.max(0, overlayWidth - 2);
    for (let row = 0; row < height; row += 1) {
      const line = sideLines[row];
      regions.push({ x: overlayStart, y: row, width: overlayWidth, height: 1, action: 'sidebar-panel' });
      let panel: string;
      if (overlayWidth >= 3) {
        const content = line ? styledLine(line, innerWidth, colors) : ' '.repeat(innerWidth);
        panel = `${colors.border}│${colors.reset}${content}${colors.border}│${colors.reset}`;
      } else panel = `${colors.border}${'│'.repeat(overlayWidth)}${colors.reset}`;
      rows[row] = `${padAnsi(rows[row] ?? '', overlayStart)}${panel}`;
      if (line?.action && innerWidth > 0) regions.push({ x: overlayStart + 1, y: row, width: innerWidth, height: 1, action: line.action });
    }
  }

  let cursor: { row: number; column: number } | null = null;
  const modernFrame = state.mainLines !== undefined || state.sidebarLines !== undefined || state.menuLines !== undefined || state.dialog !== undefined;
  if (inputRows > 0 && (modernFrame || state.prompt !== null || state.running)) {
    cursor = inputCursor(state.draft, state.cursor, Math.max(1, titleWidth), inputRows, inputRow);
  }

  if (state.dialog && width > 0 && height > 0) {
    const dialog = state.dialog;
    const boxWidth = Math.max(1, Math.min(width, 72));
    const contentWidth = Math.max(0, boxWidth - 4);
    const wrapWidth = Math.max(1, contentWidth);
    const dialogRows: { text: string; sourceIndex: number }[] = [];
    const sourceStarts: number[] = [];
    dialog.lines.forEach((source, sourceIndex) => {
      sourceStarts[sourceIndex] = dialogRows.length;
      for (const text of wrapText(cleanText(source), wrapWidth)) dialogRows.push({ text, sourceIndex });
    });
    const selectedIndex = dialog.selected ?? -1;
    const focusIndex = Math.max(0, Math.min(dialog.lines.length - 1, dialog.cursor?.row ?? selectedIndex));
    const focusRow = (sourceStarts[focusIndex] ?? 0) + (dialog.cursor ? cursorInWrappedLine(dialog.lines[focusIndex] ?? '', dialog.cursor.column, wrapWidth).row : 0);
    const boxHeight = Math.min(height, Math.max(1, dialogRows.length + 5));
    const contentRows = Math.max(0, boxHeight - 5);
    const windowStart = Math.max(0, Math.min(focusRow - contentRows + 1, dialogRows.length - contentRows));
    const visibleDialogRows = dialogRows.slice(windowStart, windowStart + contentRows);
    const left = Math.floor((width - boxWidth) / 2);
    const top = Math.floor((height - boxHeight) / 2);
    const borderRow = (leftChar: string, fill: string, rightChar: string) =>
      `${leftChar}${fill.repeat(Math.max(0, boxWidth - 2))}${rightChar}`;
    const insideRow = (text: string, reverse = false) => {
      const clipped = clipAnsi(text, contentWidth);
      const body = `${reverse ? '\x1b[7m' : ''}${clipped}${reverse ? '\x1b[27m' : ''}`;
      return `│ ${body}${' '.repeat(Math.max(0, contentWidth - cellWidth(plainAnsi(clipped))))} │`;
    };
    const boxRows = [borderRow('╭', '─', '╮'), insideRow(dialog.title), borderRow('├', '─', '┤')];
    for (let index = 0; index < contentRows; index += 1) {
      const source = visibleDialogRows[index];
      if (source) {
        boxRows.push(insideRow(source.text, selectedIndex === source.sourceIndex));
        regions.push({ x: left + 2, y: top + 3 + index, width: contentWidth, height: 1, action: `dialog:${source.sourceIndex}` });
      } else boxRows.push(insideRow(''));
    }
    if (boxHeight >= 5) {
      boxRows.push(insideRow(dialog.help));
      boxRows.push(borderRow('╰', '─', '╯'));
    }
    for (let index = 0; index < Math.min(boxRows.length, boxHeight); index += 1) {
      const boxLine = padAnsi(boxRows[index] ?? '', boxWidth);
      rows[top + index] = `${padAnsi('', left)}${boxLine}${' '.repeat(Math.max(0, width - left - boxWidth))}`;
    }
    cursor = null;
    if (dialog.cursor && dialog.lines.length > 0 && contentRows > 0 && boxWidth >= 5) {
      const sourceIndex = Math.max(0, Math.min(dialog.lines.length - 1, dialog.cursor.row));
      const mapped = cursorInWrappedLine(dialog.lines[sourceIndex] ?? '', dialog.cursor.column, wrapWidth);
      const visibleRow = Math.max(0, Math.min(contentRows - 1, sourceStarts[sourceIndex]! + mapped.row - windowStart));
      cursor = {
        row: top + 3 + visibleRow,
        column: Math.max(left + 2, Math.min(left + boxWidth - 3, left + 2 + mapped.column)),
      };
    }
  }

  return {
    output: outputFrame(rows, cursor, colors), viewRows, maxScroll, inputWidth: Math.max(0, titleWidth), inputRow,
    inputRows, draftTop, sidebarScroll, sidebarArea: sideLines ? { x: wideSidebar ? mainWidth : width - sideWidth, width: sideWidth } : undefined,
    transcriptTop, visibleLines, regions,
  };
}
