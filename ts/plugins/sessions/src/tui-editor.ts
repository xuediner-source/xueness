import { graphemes } from './tui-text.ts';
import { cursorPosition } from './tui-text.ts';

export class ChatEditor {
  value = '';
  cursor = 0;
  history: string[] = [];

  private historyIndex = 0;
  private savedDraft = '';

  get historyActive(): boolean {
    return this.historyIndex < this.history.length;
  }

  private boundaries(): number[] {
    const result = [0];
    let offset = 0;
    for (const part of graphemes(this.value)) {
      offset += part.length;
      result.push(offset);
    }
    return result;
  }

  private leaveHistory(): void {
    if (this.historyIndex < this.history.length) {
      this.historyIndex = this.history.length;
      this.savedDraft = '';
    }
  }

  insert(text: string): void {
    this.leaveHistory();
    const normalized = text.replace(/\r\n?/g, '\n');
    this.value = this.value.slice(0, this.cursor) + normalized + this.value.slice(this.cursor);
    this.cursor += normalized.length;
  }

  backspace(): void {
    const boundaries = this.boundaries();
    const index = boundaries.indexOf(this.cursor);
    if (index <= 0) return;
    const start = boundaries[index - 1]!;
    this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
    this.cursor = start;
    this.leaveHistory();
  }

  delete(): void {
    const boundaries = this.boundaries();
    const index = boundaries.indexOf(this.cursor);
    if (index < 0 || index + 1 >= boundaries.length) return;
    const end = boundaries[index + 1]!;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(end);
    this.leaveHistory();
  }

  left(): void {
    const boundaries = this.boundaries();
    const index = boundaries.indexOf(this.cursor);
    if (index > 0) this.cursor = boundaries[index - 1]!;
  }

  right(): void {
    const boundaries = this.boundaries();
    const index = boundaries.indexOf(this.cursor);
    if (index >= 0 && index + 1 < boundaries.length) this.cursor = boundaries[index + 1]!;
  }

  home(): void {
    const newline = this.cursor === 0 ? -1 : this.value.lastIndexOf('\n', this.cursor - 1);
    this.cursor = newline + 1;
  }

  end(): void {
    const newline = this.value.indexOf('\n', this.cursor);
    this.cursor = newline < 0 ? this.value.length : newline;
  }

  /** Move one wrapped visual row, preserving the cursor's cell column. */
  moveVertical(delta: -1 | 1, columns: number): void {
    const width = Math.max(1, Math.floor(columns));
    const boundaries = this.boundaries();
    const current = cursorPosition(this.value.slice(0, this.cursor), width);
    const targetRow = current.row + delta;
    let bestOffset: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const offset of boundaries) {
      const position = cursorPosition(this.value.slice(0, offset), width);
      if (position.row !== targetRow) continue;
      const distance = Math.abs(position.column - current.column);
      if (distance < bestDistance || (distance === bestDistance && (bestOffset === undefined || offset < bestOffset))) {
        bestDistance = distance;
        bestOffset = offset;
      }
    }
    if (bestOffset !== undefined) this.cursor = bestOffset;
  }

  /** Move to the beginning of the preceding whitespace-delimited word. */
  wordLeft(): void {
    const boundaries = this.boundaries();
    let index = boundaries.indexOf(this.cursor);
    if (index < 0) return;
    const parts = graphemes(this.value);
    while (index > 0 && /^\s+$/u.test(parts[index - 1]!)) index -= 1;
    while (index > 0 && !/^\s+$/u.test(parts[index - 1]!)) index -= 1;
    this.cursor = boundaries[index]!;
  }

  /** Move past the next whitespace-delimited word. */
  wordRight(): void {
    const boundaries = this.boundaries();
    let index = boundaries.indexOf(this.cursor);
    if (index < 0) return;
    const parts = graphemes(this.value);
    while (index < parts.length && /^\s+$/u.test(parts[index]!)) index += 1;
    while (index < parts.length && !/^\s+$/u.test(parts[index]!)) index += 1;
    this.cursor = boundaries[index]!;
  }

  /** Delete preceding whitespace and its preceding word. */
  deleteWordBefore(): void {
    const boundaries = this.boundaries();
    let startIndex = boundaries.indexOf(this.cursor);
    if (startIndex <= 0) return;
    const parts = graphemes(this.value);
    while (startIndex > 0 && /^\s+$/u.test(parts[startIndex - 1]!)) startIndex -= 1;
    while (startIndex > 0 && !/^\s+$/u.test(parts[startIndex - 1]!)) startIndex -= 1;
    const start = boundaries[startIndex]!;
    this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
    this.cursor = start;
    this.leaveHistory();
  }

  clearBefore(): void {
    const newline = this.cursor === 0 ? -1 : this.value.lastIndexOf('\n', this.cursor - 1);
    const start = newline + 1;
    if (start === this.cursor) return;
    this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
    this.cursor = start;
    this.leaveHistory();
  }

  clearAfter(): void {
    const newline = this.value.indexOf('\n', this.cursor);
    const end = newline < 0 ? this.value.length : newline;
    if (end === this.cursor) return;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(end);
    this.leaveHistory();
  }

  replace(text: string): void {
    this.leaveHistory();
    this.value = text.replace(/\r\n?/g, '\n');
    this.cursor = this.value.length;
  }

  /** Replace stored history without disturbing the current draft or cursor. */
  restoreHistory(values: readonly string[]): void {
    this.history = [...values];
    this.historyIndex = this.history.length;
    this.savedDraft = '';
  }

  submit(): string {
    const submitted = this.value;
    if (submitted.length > 0 && this.history.at(-1) !== submitted) this.history.push(submitted);
    this.value = '';
    this.cursor = 0;
    this.historyIndex = this.history.length;
    this.savedDraft = '';
    return submitted;
  }

  previous(): void {
    if (this.history.length === 0 || this.historyIndex <= 0) return;
    if (this.historyIndex === this.history.length) this.savedDraft = this.value;
    this.historyIndex -= 1;
    this.value = this.history[this.historyIndex]!;
    this.cursor = this.value.length;
  }

  next(): void {
    if (this.historyIndex >= this.history.length) return;
    this.historyIndex += 1;
    this.value = this.historyIndex === this.history.length
      ? this.savedDraft
      : this.history[this.historyIndex]!;
    this.cursor = this.value.length;
  }
}
