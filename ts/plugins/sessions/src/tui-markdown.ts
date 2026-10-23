import { cleanText, cellWidth, graphemes, clipText } from './tui-text.ts';
import type { TuiThemeMode } from './tui-types.ts';
import { palette } from './tui-theme.ts';

const isSgr = /^\x1b\[[0-9;]*m$/;

function wrapAnsi(text: string, width: number): string[] {
  const limit = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const rows: string[] = [];
  let row = '';
  let column = 0;
  let active = '';
  const atoms = text.split(/(\x1b\[[0-9;]*m)/g).filter(Boolean);
  for (const atom of atoms) {
    if (isSgr.test(atom)) {
      row += atom;
      active = /^\x1b\[(?:0)?m$/.test(atom) ? '' : active + atom;
      continue;
    }
    for (const part of graphemes(atom)) {
      if (part === '\n') {
        rows.push(row + '\x1b[0m');
        row = active;
        column = 0;
        continue;
      }
      const w = cellWidth(part);
      if (column > 0 && column + w > limit) {
        rows.push(row + '\x1b[0m');
        row = active;
        column = 0;
      }
      if (w > limit) {
        row += '?';
        column += 1;
      } else {
        row += part;
        column += w;
      }
    }
  }
  rows.push(row + '\x1b[0m');
  return rows;
}

function inline(text: string, colors: ReturnType<typeof palette>): string {
  const safe = cleanText(text);
  const token = /(!?\[[^\]]*\]\(([^)]+)\)|\*\*[^*]+\*\*|(?<![\p{L}\p{N}_])__[^_]+__(?![\p{L}\p{N}_])|`[^`]+`|\*[^*]+\*|(?<![\p{L}\p{N}_])_[^_]+_(?![\p{L}\p{N}_]))/gu;
  let result = '';
  let from = 0;
  for (const match of safe.matchAll(token)) {
    const index = match.index!;
    result += safe.slice(from, index);
    const value = match[0];
    if (value.startsWith('[') || value.startsWith('![')) {
      const label = /^!?\[([^\]]*)\]/.exec(value)?.[1] ?? value;
      result += `${colors.accent}${label} (${match[2]})${colors.reset}`;
    } else if (value.startsWith('`')) {
      result += `${colors.code}${value.slice(1, -1)}${colors.reset}`;
    } else if (value.startsWith('**') || value.startsWith('__')) {
      result += `${colors.bold}${value.slice(2, -2)}${colors.reset}`;
    } else {
      result += `${colors.dim}${value.slice(1, -1)}${colors.reset}`;
    }
    from = index + value.length;
  }
  return result + safe.slice(from);
}

function highlightedCode(line: string, language: string, colors: ReturnType<typeof palette>): string {
  const lang = language.toLowerCase();
  const lex = /(\/\/.*|#.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|throw|try|catch|def|print|true|false|null|None|undefined|this|in|of|as|type|interface|extends|await|yield)\b|\b\d+(?:\.\d+)?\b)/g;
  const code = cleanText(line);
  let result = '';
  let offset = 0;
  for (const match of code.matchAll(lex)) {
    const value = match[0];
    const start = match.index!;
    result += code.slice(offset, start);
    let color = '';
    if (value.startsWith('//') || (value.startsWith('#') && !['json', 'jsonc'].includes(lang))) color = colors.dim;
    else if (/^["']/.test(value)) color = colors.success;
    else if (/^\d/.test(value)) color = colors.warning;
    else color = colors.accent;
    result += `${color}${value}${colors.reset}`;
    offset = start + value.length;
  }
  return result + code.slice(offset);
}

function isTableSeparator(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableRows(lines: string[], width: number, colors: ReturnType<typeof palette>): string[] {
  const parsed = lines.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
  const rows = parsed.filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
  if (!rows.length) return [];
  const count = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, index) => Math.max(1, ...rows.map((row) => cellWidth(row[index] ?? ''))));
  while (widths.reduce((sum, n) => sum + n + 3, 1) > width) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 1) break;
    widths[widest]!--;
  }
  return rows.map((row, rowIndex) => {
    const cells = widths.map((cellWidthLimit, index) => {
      const raw = clipText(row[index] ?? '', cellWidthLimit);
      const padding = ' '.repeat(Math.max(0, cellWidthLimit - cellWidth(raw)));
      const content = inline(raw, colors);
      return rowIndex === 0 ? `${colors.bold}${content}${colors.reset}${padding}` : `${content}${padding}`;
    });
    return `${colors.dim}|${colors.reset} ${cells.join(` ${colors.dim}|${colors.reset} `)} ${colors.dim}|${colors.reset}`;
  }).flatMap((row) => wrapAnsi(row, width));
}

export function markdownLines(text: string, width: number, mode: TuiThemeMode): string[] {
  const boundedWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const colors = palette(mode);
  const source = cleanText(text).split('\n');
  const lines: string[] = [];
  for (let index = 0; index < source.length;) {
    if (/^\s*```/.test(source[index]!)) {
      const language = source[index]!.trim().slice(3).trim();
      index += 1;
      while (index < source.length && !/^\s*```/.test(source[index]!)) {
        lines.push(...wrapAnsi(`${colors.code}${highlightedCode(source[index]!, language, colors)}${colors.reset}`, boundedWidth));
        index += 1;
      }
      if (index < source.length) index += 1;
      continue;
    }
    if (source[index]!.includes('|') && index + 1 < source.length && isTableSeparator(source[index + 1]!)) {
      const table: string[] = [];
      while (index < source.length && source[index]!.includes('|')) table.push(source[index++]!);
      lines.push(...tableRows(table, boundedWidth, colors));
      continue;
    }
    const raw = source[index++]!;
    let line = raw;
    let prefix = '';
    let style = '';
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    const list = /^\s*((?:[-+*])|(?:\d+\.))\s+(.*)$/.exec(raw);
    if (heading) { prefix = `${heading[1]} `; line = heading[2]!; style = `${colors.bold}${colors.accent}`; }
    else if (quote) { prefix = '│ '; line = quote[1]!; style = colors.dim; }
    else if (list) { prefix = `${list[1]} `; line = list[2]!; }
    lines.push(...wrapAnsi(`${style}${prefix}${inline(line, colors)}${style ? colors.reset : ''}`, boundedWidth));
  }
  return lines.length ? lines : [''];
}

export function diffLines(diff: string, width: number, mode: TuiThemeMode): string[] {
  const boundedWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const colors = palette(mode);
  return cleanText(diff).split('\n').flatMap((line) => {
    const color = line.startsWith('+') && !line.startsWith('+++') ? colors.add
      : line.startsWith('-') && !line.startsWith('---') ? colors.remove
        : line.startsWith('@@') ? colors.accent : '';
    return wrapAnsi(`${color}${line}${color ? colors.reset : ''}`, boundedWidth);
  });
}
