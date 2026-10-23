import { stripVTControlCharacters } from 'node:util';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function cleanText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(text: string): number {
  if (!text || /^\p{Mark}+$/u.test(text)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) return 2;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (/\p{Mark}/u.test(char) || cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e) continue;
    return isWide(cp) ? 2 : 1;
  }
  return 0;
}

export function cellWidth(text: string): number {
  return graphemes(text).reduce((width, part) => width + graphemeWidth(part), 0);
}

export function clipText(text: string, columns: number): string {
  let width = 0;
  let result = '';
  for (const part of graphemes(text)) {
    if (part === '\n') break;
    const partWidth = graphemeWidth(part);
    if (width + partWidth > columns) break;
    result += part;
    width += partWidth;
  }
  return result;
}

export function wrapText(text: string, columns: number): string[] {
  const rows: string[] = [];
  let row = '';
  let width = 0;
  for (const part of graphemes(text)) {
    if (part === '\n') {
      rows.push(row);
      row = '';
      width = 0;
      continue;
    }
    let partWidth = graphemeWidth(part);
    let rendered = part;
    if (partWidth > columns) {
      rendered = '?';
      partWidth = 1;
    }
    if (width + partWidth > columns) {
      rows.push(row);
      row = '';
      width = 0;
    }
    row += rendered;
    width += partWidth;
  }
  rows.push(row);
  return rows;
}

export function cursorPosition(prefix: string, columns: number): { row: number; column: number } {
  let row = 0;
  let column = 0;
  for (const part of graphemes(prefix)) {
    if (part === '\n') {
      row += 1;
      column = 0;
      continue;
    }
    let width = graphemeWidth(part);
    if (width > columns) width = 1;
    if (column + width > columns) {
      row += 1;
      column = 0;
    }
    column += width;
  }
  if (column === columns) return { row: row + 1, column: 0 };
  return { row, column };
}
